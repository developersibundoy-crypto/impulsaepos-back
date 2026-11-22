#!/usr/bin/env node
'use strict';

/*
 * Ejecutor de migraciones de la tienda online.
 *
 *   node src/migrations/tienda/run.cjs --dry-run          Muestra qué se aplicaría, sin cambios
 *   node src/migrations/tienda/run.cjs                    Aplica pendientes (destino local)
 *   node src/migrations/tienda/run.cjs --verify-only      Comprueba que lo aplicado sigue íntegro
 *
 * Lee DB_HOST, DB_PORT, DB_USER, DB_PASSWORD y DB_NAME del entorno (nunca de este archivo).
 *
 * Seguridad:
 *  - Destino local (127.0.0.1, ::1, localhost): se ejecuta sin más.
 *  - Cualquier otro destino exige --confirm-database=<DB_NAME> y --backup-verified, para que una
 *    variable de entorno equivocada no pueda modificar una base remota por accidente.
 *  - Cada migración es idempotente, se verifica tras aplicarse y registra su checksum en
 *    schema_migrations. Si el archivo de una migración ya aplicada cambia, el proceso aborta.
 *  - Un bloqueo de sesión evita que dos procesos migren a la vez.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mysql = require('mysql2/promise');
try { require('dotenv').config(); } catch {}

const LOCAL_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);
const MIGRATION_FILE = /^\d{8}_\d{3}_[a-z0-9_]+\.cjs$/;
const LOCK_NAME = 'impulsaepos_migraciones_tienda';

function parseArgs(argv) {
  const args = { dryRun: false, verifyOnly: false, backupVerified: false, confirmDatabase: null };
  for (const arg of argv) {
    if (arg === '--dry-run') args.dryRun = true;
    else if (arg === '--verify-only') args.verifyOnly = true;
    else if (arg === '--backup-verified') args.backupVerified = true;
    else if (arg.startsWith('--confirm-database=')) args.confirmDatabase = arg.slice('--confirm-database='.length);
    else throw new Error(`Argumento no reconocido: ${arg}`);
  }
  return args;
}

function readTarget(env) {
  const target = {
    host: env.DB_HOST,
    port: Number(env.DB_PORT) || 3306,
    user: env.DB_USER,
    password: env.DB_PASSWORD ?? '',
    database: env.DB_NAME,
  };
  for (const key of ['host', 'user', 'database']) {
    if (!target[key]) throw new Error(`Falta DB_${key === 'database' ? 'NAME' : key.toUpperCase()} en el entorno`);
  }
  return target;
}

function assertTargetAllowed(target, args) {
  if (LOCAL_HOSTS.has(target.host)) return;
  if (args.confirmDatabase !== target.database || !args.backupVerified) {
    throw new Error(
      `Destino remoto (${target.host}/${target.database}) no autorizado. ` +
      'Requiere --confirm-database=<nombre exacto> y --backup-verified tras comprobar un respaldo.'
    );
  }
}

function loadMigrations() {
  const files = fs.readdirSync(__dirname).filter((f) => MIGRATION_FILE.test(f)).sort();
  return files.map((file) => {
    const full = path.join(__dirname, file);
    const mod = require(full);
    const expected = file.replace(/\.cjs$/, '');
    if (mod.version !== expected) throw new Error(`${file}: version "${mod.version}" no coincide con el nombre`);
    for (const fn of ['up', 'verify']) {
      if (typeof mod[fn] !== 'function') throw new Error(`${file}: falta la función ${fn}`);
    }
    // Se normaliza CRLF/LF para que el checksum no dependa del sistema operativo.
    const content = fs.readFileSync(full, 'utf8').replace(/\r\n/g, '\n');
    const checksum = crypto.createHash('sha256').update(content).digest('hex');
    return { ...mod, file, checksum };
  });
}

async function ensureControlTable(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(100) NOT NULL,
      descripcion VARCHAR(255) NOT NULL,
      checksum CHAR(64) NOT NULL,
      aplicada_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (version)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const target = readTarget(process.env);
  assertTargetAllowed(target, args);

  const migrations = loadMigrations();
  const conn = await mysql.createConnection({ ...target, multipleStatements: false });
  let locked = false;
  try {
    console.log(`[migraciones] Destino: ${target.host}:${target.port}/${target.database}`);
    const [lock] = await conn.query('SELECT GET_LOCK(?, 10) AS ok', [LOCK_NAME]);
    if (Number(lock[0].ok) !== 1) throw new Error('Otra migración está en curso (no se obtuvo el bloqueo)');
    locked = true;

    if (!args.dryRun && !args.verifyOnly) await ensureControlTable(conn);

    let applied = new Map();
    try {
      const [rows] = await conn.query('SELECT version, checksum FROM schema_migrations');
      applied = new Map(rows.map((r) => [r.version, r.checksum]));
    } catch (e) {
      if (e.code !== 'ER_NO_SUCH_TABLE') throw e;
    }

    for (const m of migrations) {
      const previous = applied.get(m.version);
      if (previous && previous !== m.checksum) {
        throw new Error(`${m.file}: el archivo cambió después de aplicarse. Crea una migración nueva en vez de editarla.`);
      }
    }

    const pending = migrations.filter((m) => !applied.has(m.version));
    if (args.verifyOnly) {
      for (const m of migrations.filter((x) => applied.has(x.version))) {
        await m.verify(conn);
        console.log(`[migraciones] OK verificada ${m.version}`);
      }
      console.log(`[migraciones] Verificación completa. Pendientes: ${pending.length}`);
      return;
    }
    if (args.dryRun) {
      console.log(`[migraciones] (dry-run) Aplicadas: ${applied.size}. Pendientes: ${pending.length}`);
      for (const m of pending) console.log(`  - ${m.version}: ${m.description} [tablas: ${(m.tables || []).join(', ')}]`);
      return;
    }

    for (const m of pending) {
      console.log(`[migraciones] Aplicando ${m.version}...`);
      await m.up(conn);
      await m.verify(conn);
      await conn.query('INSERT INTO schema_migrations (version, descripcion, checksum) VALUES (?, ?, ?)', [
        m.version, m.description, m.checksum,
      ]);
      console.log(`[migraciones] OK ${m.version}`);
    }
    if (!pending.length) console.log('[migraciones] Nada pendiente.');
  } finally {
    if (locked) await conn.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]).catch(() => {});
    await conn.end();
  }
}

main().catch((e) => {
  console.error('[migraciones] ERROR:', e.message);
  process.exitCode = 1;
});
