'use strict';

// Utilidades compartidas por las migraciones de la tienda online.
// Principio: toda operación es idempotente y aditiva. Repetir una migración no cambia nada.

async function tableExists(conn, table) {
  const [rows] = await conn.query(
    'SELECT 1 FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1',
    [table]
  );
  return rows.length === 1;
}

async function columnExists(conn, table, column) {
  const [rows] = await conn.query(
    'SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1',
    [table, column]
  );
  return rows.length === 1;
}

async function indexExists(conn, table, index) {
  const [rows] = await conn.query(
    'SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1',
    [table, index]
  );
  return rows.length === 1;
}

async function foreignKeyExists(conn, table, constraint) {
  const [rows] = await conn.query(
    `SELECT 1 FROM information_schema.TABLE_CONSTRAINTS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? AND CONSTRAINT_TYPE = 'FOREIGN KEY' LIMIT 1`,
    [table, constraint]
  );
  return rows.length === 1;
}

// Los nombres de tabla/columna/índice son constantes del código de migración, nunca entrada externa.
const IDENT = /^[a-z_][a-z0-9_]*$/;
function ident(name) {
  if (typeof name !== 'string' || !IDENT.test(name)) throw new Error(`Identificador no válido: ${name}`);
  return '`' + name + '`';
}

async function addColumnIfMissing(conn, table, column, definition) {
  if (await columnExists(conn, table, column)) return false;
  await conn.query(`ALTER TABLE ${ident(table)} ADD COLUMN ${ident(column)} ${definition}`);
  return true;
}

async function addIndexIfMissing(conn, table, index, definition) {
  if (await indexExists(conn, table, index)) return false;
  await conn.query(`ALTER TABLE ${ident(table)} ADD ${definition}`);
  return true;
}

async function assertTables(conn, tables) {
  for (const table of tables) {
    if (!(await tableExists(conn, table))) throw new Error(`Verificación fallida: falta la tabla ${table}`);
  }
}

async function assertUniqueIndex(conn, table, index, columns) {
  const [rows] = await conn.query(
    `SELECT NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME FROM information_schema.STATISTICS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND INDEX_NAME = ? ORDER BY SEQ_IN_INDEX`,
    [table, index]
  );
  const ok = rows.length === columns.length &&
    rows.every((r, i) => Number(r.NON_UNIQUE) === 0 && r.COLUMN_NAME === columns[i]);
  if (!ok) throw new Error(`Verificación fallida: índice único ${table}.${index}(${columns.join(',')})`);
}

async function assertForeignKey(conn, table, constraint) {
  if (!(await foreignKeyExists(conn, table, constraint))) {
    throw new Error(`Verificación fallida: falta la clave foránea ${table}.${constraint}`);
  }
}

async function tableHasRows(conn, table) {
  const [rows] = await conn.query(`SELECT 1 FROM ${ident(table)} LIMIT 1`);
  return rows.length > 0;
}

// Opciones comunes de tabla. utf8mb4_unicode_ci existe en MySQL 5.7+, MySQL 8 y todas las
// versiones de MariaDB, a diferencia de utf8mb4_uca1400_ai_ci (solo MariaDB 11.x).
const TABLE_OPTIONS = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

module.exports = {
  ident,
  tableExists,
  columnExists,
  indexExists,
  foreignKeyExists,
  addColumnIfMissing,
  addIndexIfMissing,
  assertTables,
  assertUniqueIndex,
  assertForeignKey,
  tableHasRows,
  TABLE_OPTIONS,
};
