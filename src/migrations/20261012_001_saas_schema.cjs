'use strict';

// Migración independiente: no importar conexión, servidor ni setupDB del backend.
const fs = require('node:fs');
const tls = require('node:tls');
const path = require('node:path');
const mysql = require('mysql2/promise');
const dotenv = require('dotenv');

const version = '20261012_001_saas_schema';
// Referencia independiente del archivo .env: no se puede autorizar otro remoto desde él.
const productionHost = 'srv1779.hstgr.io';
// @@hostname observado y contrastado en R1; no derivarlo del alias DNS de conexión.
const productionServerHostnames = Object.freeze(['us-bos-web1779.main-hosting.eu']);
const productionDatabase = 'u311745467_impulsaepos';

function assertTargetConfig(config, rehearsalDatabase) {
  if (!config || config.socketPath) throw new Error('Destino no autorizado');
  if (rehearsalDatabase !== undefined) {
    if (typeof rehearsalDatabase !== 'string' ||
        !/^ensayo_saas_20261012_[a-f0-9]{12}$/.test(rehearsalDatabase) ||
        !['127.0.0.1', '::1'].includes(config.host) ||
        config.database !== rehearsalDatabase) {
      throw new Error('Destino de ensayo no autorizado');
    }
  } else if (config.host !== productionHost || config.port !== 3306 ||
             config.database !== productionDatabase) {
    throw new Error('Destino de producción no autorizado');
  }
  if (rehearsalDatabase === undefined &&
      (config.ssl?.rejectUnauthorized !== true || config.ssl?.verifyIdentity !== true)) {
    throw new Error('TLS autenticado no autorizado: se exige certificado e identidad verificados');
  }
}

async function assertTarget(connection, rehearsalDatabase) {
  // Leer la configuración de la conexión real, también cuando se llama migrate sin CLI.
  const client = connection.connection;
  assertTargetConfig(client?.config, rehearsalDatabase);
  if (rehearsalDatabase === undefined) {
    const stream = client.stream;
    if (stream?.encrypted !== true || stream.authorized !== true ||
        typeof stream.getPeerCertificate !== 'function') {
      throw new Error('TLS autenticado no autorizado: transporte no verificado');
    }
    // Comprobar el DNS de conexión, no el @@hostname declarado por el servidor SQL.
    const cert = stream.getPeerCertificate(true);
    if (!cert || tls.checkServerIdentity(productionHost, cert)) {
      throw new Error('TLS autenticado no autorizado: certificado de otro host');
    }
    const [status] = await connection.query("SHOW SESSION STATUS LIKE 'Ssl_cipher'");
    if (status.length !== 1 || status[0].Variable_name !== 'Ssl_cipher' ||
        typeof status[0].Value !== 'string' || !status[0].Value.trim()) {
      throw new Error('TLS autenticado no autorizado: sesión sin Ssl_cipher');
    }
  }
  if (rehearsalDatabase !== undefined &&
      !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(client.stream?.remoteAddress)) {
    throw new Error('Conexión de ensayo no aislada en loopback');
  }
  const [rows] = await connection.query('SELECT DATABASE() AS db, @@hostname AS host, @@port AS port');
  if (rows.length !== 1 || rows[0].db !== (rehearsalDatabase ?? productionDatabase) ||
      (rehearsalDatabase === undefined &&
        (!productionServerHostnames.includes(rows[0].host) || Number(rows[0].port) !== 3306))) {
    throw new Error('Identidad real del destino no autorizada');
  }
}
const createGastos = `CREATE TABLE saas_gastos (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  categoria VARCHAR(100) NOT NULL,
  descripcion TEXT NOT NULL,
  monto DECIMAL(15,2) NOT NULL,
  fecha DATE NOT NULL,
  metodo_pago VARCHAR(100) NULL DEFAULT 'Transferencia',
  comprobante_url LONGTEXT NULL,
  creado_por VARCHAR(100) NULL DEFAULT 'superadmin',
  fecha_registro TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci`;
const additions = [
  ['empresa_config', 'dias_alerta_vencimiento', 'int', 'YES', '30',
    'ALTER TABLE empresa_config ADD COLUMN dias_alerta_vencimiento INT NULL DEFAULT 30'],
  ['sesiones_caja', 'total_sistecredito', 'decimal(12,2)', 'YES', '0.00',
    'ALTER TABLE sesiones_caja ADD COLUMN total_sistecredito DECIMAL(12,2) NULL DEFAULT 0.00'],
];

function normalizeType(type) {
  return type.toLowerCase().replace(/^int\(\d+\)$/, 'int');
}
function normalizeDefault(value) {
  // MariaDB expone DEFAULT NULL como texto 'NULL'; MySQL lo expone como null.
  if (value === null || value === 'NULL') return null;
  const normalized = String(value).replace(/^'(.*)'$/, '$1');
  return /^current_timestamp(?:\(\))?$/i.test(normalized) ? 'current_timestamp' : normalized;
}
function assertColumn(column, type, nullable, defaultValue, extra = '') {
  if (!column || normalizeType(column.COLUMN_TYPE) !== type ||
      column.IS_NULLABLE !== nullable ||
      normalizeDefault(column.COLUMN_DEFAULT) !== defaultValue ||
      String(column.EXTRA).toLowerCase().replace(/default_generated/g, '').trim() !== extra) {
    const name = column ? `${column.TABLE_NAME}.${column.COLUMN_NAME}` : 'columna requerida ausente';
    throw new Error(`Esquema existente incompatible (${name}); se requiere revisión sin modificarlo`);
  }
}

async function plan(connection) {
  const [tables] = await connection.query(`SELECT TABLE_NAME, TABLE_TYPE, ENGINE, TABLE_COLLATION
    FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN ('saas_gastos', 'empresa_config', 'sesiones_caja')`);
  const byName = new Map(tables.map(t => [t.TABLE_NAME, t]));
  const [columns] = await connection.query(`SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE,
    IS_NULLABLE, COLUMN_DEFAULT, COLUMN_KEY, EXTRA, COLLATION_NAME
    FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN ('saas_gastos', 'empresa_config', 'sesiones_caja')`);
  const get = (t, c) => columns.find(row => row.TABLE_NAME === t && row.COLUMN_NAME === c);
  const statements = [];
  if (!byName.has('saas_gastos')) {
    statements.push(createGastos);
  } else {
    const table = byName.get('saas_gastos');
    if (table.TABLE_TYPE !== 'BASE TABLE' || table.ENGINE !== 'InnoDB' ||
        table.TABLE_COLLATION !== 'utf8mb4_general_ci') {
      throw new Error('saas_gastos existente incompatible; no se modificó');
    }
    const expected = [
      ['id', 'int', 'NO', null, 'auto_increment'],
      ['categoria', 'varchar(100)', 'NO', null],
      ['descripcion', 'text', 'NO', null],
      ['monto', 'decimal(15,2)', 'NO', null],
      ['fecha', 'date', 'NO', null],
      ['metodo_pago', 'varchar(100)', 'YES', 'Transferencia'],
      ['comprobante_url', 'longtext', 'YES', null],
      ['creado_por', 'varchar(100)', 'YES', 'superadmin'],
      ['fecha_registro', 'timestamp', 'NO', 'current_timestamp'],
    ];
    for (const [name, type, nullable, def, extra] of expected) {
      const column = get('saas_gastos', name);
      assertColumn(column, type, nullable, def, extra);
      if (/varchar|text/.test(type) && column.COLLATION_NAME !== 'utf8mb4_general_ci') {
        throw new Error('Collation existente incompatible; no se modificó');
      }
    }
    const primary = columns.filter(c => c.TABLE_NAME === 'saas_gastos' && c.COLUMN_KEY === 'PRI');
    if (primary.length !== 1 || primary[0].COLUMN_NAME !== 'id') {
      throw new Error('PK existente incompatible; no se modificó');
    }
  }
  for (const [table, name, type, nullable, def, ddl] of additions) {
    if (byName.get(table)?.TABLE_TYPE !== 'BASE TABLE') {
      throw new Error(`Falta tabla base ${table}; no se ejecutó DDL`);
    }
    const column = get(table, name);
    if (column) assertColumn(column, type, nullable, def);
    else statements.push(ddl);
  }
  return statements;
}

async function migrate(connection, apply = false, rehearsalDatabase) {
  // Fallar cerrado antes de bloqueos, preflight o DDL; no confiar solo en DB_NAME.
  await assertTarget(connection, rehearsalDatabase);
  let locked = false;
  try {
    if (apply) {
      const [rows] = await connection.query('SELECT GET_LOCK(?, 10) AS acquired', [version]);
      locked = rows[0].acquired === 1;
      if (!locked) throw new Error('No se obtuvo bloqueo de migración');
    }
    // Preflight completo ANTES del primer DDL. Nunca corregir definiciones existentes.
    const statements = await plan(connection);
    if (apply) {
      await connection.query('SET SESSION lock_wait_timeout = 15');
      for (const statement of statements) await connection.query(statement);
      if ((await plan(connection)).length) throw new Error('Verificación posterior fallida');
    }
    return { version, mode: apply ? 'apply' : 'plan', ddlCount: statements.length, statements };
  } finally {
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [version]);
  }
}

function configFromEnv(file, rehearsalDatabase) {
  const env = dotenv.parse(fs.readFileSync(file));
  for (const key of ['DB_HOST', 'DB_USER', 'DB_NAME']) {
    if (!env[key]) throw new Error(`Falta ${key} en archivo explícito`);
  }
  const port = Number(env.DB_PORT || 3306);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('DB_PORT inválido');
  const config = { host: env.DB_HOST, user: env.DB_USER, password: env.DB_PASSWORD || '',
    database: env.DB_NAME, port, connectTimeout: 20000, multipleStatements: false };
  if (rehearsalDatabase === undefined) {
    config.ssl = { rejectUnauthorized: true, verifyIdentity: true, minVersion: 'TLSv1.2' };
    // Sin CA explícita, Node usa sus raíces de confianza. Nunca desactivar validación.
    if (env.DB_SSL_CA_FILE) {
      config.ssl.ca = fs.readFileSync(path.resolve(path.dirname(file), env.DB_SSL_CA_FILE));
    }
  }
  assertTargetConfig(config, rehearsalDatabase);
  return config;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length < 2 || args[0] !== '--env' || ![2, 3, 5].includes(args.length) ||
      (args[2] && !['--plan', '--apply'].includes(args[2])) ||
      (args.length === 5 && args[3] !== '--rehearsal-db')) {
    throw new Error('Uso: node src/migrations/20261012_001_saas_schema.cjs --env <archivo> [--plan|--apply [--rehearsal-db <base>]]');
  }
  const rehearsalDatabase = args.length === 5 ? args[4] : undefined;
  const connection = await mysql.createConnection(configFromEnv(args[1], rehearsalDatabase));
  try { console.log(JSON.stringify(await migrate(connection, args[2] === '--apply', rehearsalDatabase), null, 2)); }
  finally { await connection.end(); }
}

module.exports = { version, plan, migrate, configFromEnv, assertTargetConfig, assertTarget };
if (require.main === module) main().catch(error => {
  // Errores del driver pueden incluir SQL/datos: emitir solo código, nunca credenciales.
  console.error(error.code || error.message);
  process.exitCode = 1;
});
