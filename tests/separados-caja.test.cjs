// Fixtures exclusivamente en memoria. No importa connection real, servidor ni setupDB.
require('ts-node/register/transpile-only');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const assert = require('node:assert/strict');
let db;
function query(sql, params = []) {
  sql = sql.replace(/FOR UPDATE/g, '').replace(/<=>/g, 'IS').replace(/\bBINARY\s+/g, '').replace(/LEFT\(m.descripcion, \?\)/g, 'substr(m.descripcion, 1, ?)');
  const stmt = db.prepare(sql);
  if (/^\s*(SELECT|WITH)/i.test(sql)) return [stmt.all(...params)];
  const result = stmt.run(...params);
  return [{ insertId: Number(result.lastInsertRowid), affectedRows: Number(result.changes) }];
}
const conn = { query: async (...args) => query(...args),
  beginTransaction: async () => db.exec('BEGIN'), commit: async () => db.exec('COMMIT'),
  rollback: async () => db.exec('ROLLBACK'), release() {} };
const pool = { promise: () => ({ getConnection: async () => conn, query: conn.query }),
  query(sql, params, callback) {
    try { callback(null, query(sql, params)[0]); } catch (error) { callback(error); }
  } };
require.cache[require.resolve('../src/conection')] = { exports: { __esModule: true, default: pool } };
require.cache[require.resolve('../src/middlewares/authMiddleware')] = {
  exports: { verifyTokenAndTenant: (_req, _res, next) => next() }
};
const router = require('../src/routes/separados').default;
const cajaRouter = require('../src/routes/caja').default;
const service = require('../src/services/separadosCaja');
function setup() {
  db = new DatabaseSync(':memory:');
  db.function('IF', (cond, yes, no) => cond ? yes : no);
  db.function('CONCAT', (...parts) => parts.join(''));
  db.exec(`
    CREATE TABLE separados (id INTEGER PRIMARY KEY, empresa_id INT, cliente_id INT, cajero_id INT,
      total REAL, saldo_pendiente REAL, detalles_json TEXT, estado TEXT, fecha_creacion TEXT, fecha_vencimiento TEXT);
    CREATE TABLE abonos_separados (id INTEGER PRIMARY KEY, empresa_id INT, separado_id INT, cajero_id INT,
      monto REAL, metodo_pago TEXT, pago_efectivo REAL, pago_transferencia REAL, fecha_pago TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE sesiones_caja (id INTEGER PRIMARY KEY, usuario_id INT, empresa_id INT, estado TEXT, fecha_apertura TEXT,
      base_caja REAL DEFAULT 100, fecha_cierre TEXT, total_ventas REAL, total_efectivo REAL, total_transferencia REAL,
      total_tarjeta REAL, total_addi REAL, total_sistecredito REAL, total_ingresos REAL, total_salidas REAL,
      dinero_reportado REAL, diferencia REAL);
    CREATE TABLE movimientos_caja (id INTEGER PRIMARY KEY, empresa_id INT, usuario_id INT, sesion_caja_id INT,
      tipo TEXT, monto REAL, descripcion TEXT);
    CREATE TABLE cajeros (id INT, empresa_id INT, nombre TEXT);
    CREATE TABLE clientes (id INT, nombre TEXT, documento TEXT, telefono TEXT);
    CREATE TABLE facturas_venta (id INTEGER PRIMARY KEY, empresa_id INT, cajero_id INT, cliente_id INT,
      total REAL, metodo_pago TEXT, pago_efectivo REAL, pago_transferencia REAL, fecha TEXT DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE facturas_electronicas (empresa_id INT, cajero_id INT, total REAL, metodo_pago TEXT,
      pago_efectivo REAL, pago_transferencia REAL, fecha_emision TEXT);
    CREATE TABLE cambios_factura (empresa_id INT, cajero_id INT, saldo_adicional REAL, metodo_pago TEXT, fecha TEXT, factura_original_id INT);
    CREATE TABLE usuarios_plataforma (id INT, empresa_id INT, cajero_id INT);
    INSERT INTO usuarios_plataforma VALUES (4,1,7),(5,1,8);
    CREATE TABLE productos (id INT, empresa_id INT, cantidad INT, es_servicio INT, nombre TEXT, precio_compra REAL);
    CREATE TABLE ventas (empresa_id INT, factura_id INT, producto_id INT, cantidad INT, precio_unitario REAL, costo_unitario REAL);
    CREATE TABLE kardex (producto_id INT, empresa_id INT, tipo_movimiento TEXT, cantidad_antes INT,
      cantidad_modificada INT, cantidad_despues INT, motivo TEXT, referencia TEXT, usuario_nombre TEXT);
    INSERT INTO cajeros VALUES (7,1,'Cajero'),(8,1,'Otro'),(9,2,'Ajeno');
    INSERT INTO clientes VALUES (1,'Cliente','123','555');
    INSERT INTO sesiones_caja (id,usuario_id,empresa_id,estado,fecha_apertura) VALUES
      (10,4,1,'Abierta',CURRENT_DATE),(11,5,1,'Abierta',CURRENT_DATE);
    INSERT INTO separados VALUES (1,1,1,7,2000,2000,'[]','Pendiente',CURRENT_TIMESTAMP,NULL);
  `);
}
async function route(method, path, body = {}, user = { id: 4, empresa_id: 1, cajero_id: 7 }, extra = {}, target = router) {
  if (path === '/:id/anular' && body.operacion_id === undefined) {
    const turno = user.id === 5 ? 11 : 10;
    const nominal = query('SELECT COALESCE(SUM(monto),0) AS total FROM abonos_separados WHERE empresa_id=1 AND separado_id=1')[0][0].total;
    const ef = query("SELECT COALESCE(SUM(CASE WHEN monto > 0 AND metodo_pago='Efectivo' THEN monto ELSE pago_efectivo END),0) AS total FROM abonos_separados WHERE empresa_id=1 AND separado_id=1")[0][0].total;
    body = { sesion_caja_id: turno, operacion_id: `1.${turno}.${require('node:crypto').randomUUID()}`,
      ...(body.devolucion_efectivo === undefined && body.devolucion_transferencia === undefined ? { devolucion_efectivo: Math.min(nominal, Math.max(0, ef)), devolucion_transferencia: nominal - Math.min(nominal, Math.max(0, ef)) } : {}), ...body };
  }
  const layer = target.stack.find(l => l.route?.path === path && l.route.methods[method]);
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(n) { status = n; return this; }, json(data) { resolve({ status, data }); return this; } };
    Promise.resolve(layer.route.stack.at(-1).handle({ user, params: { id: 1 }, body, query: {}, ...extra }, res)).catch(reject);
  });
}
function totals(session = 10, cajero = 7, empresa = 1) {
  const { sql, params } = service.consultaCajaSeparados(empresa, cajero, { id: session, fecha_apertura: '2000-01-01' });
  return query(sql, params)[0][0];
}
const cash = { metodo_pago: 'Efectivo', pago_efectivo: 0, pago_transferencia: 0 };
test('1000 + 500: dos registros visibles, neto efectivo 1500 y auditoría sin doble ingreso', async () => {
  setup();
  assert.equal((await route('post', '/:id/abonos', { ...cash, monto: 1000 })).status, 200);
  assert.equal((await route('post', '/:id/abonos', { ...cash, monto: 500 })).status, 200);
  const history = await route('get', '/historial-abonos');
  assert.deepEqual(history.data.abonos.map(a => a.monto), [500,1000]);
  assert.equal(totals().total_efectivo, 1500);
  assert.equal(totals().total_abonos_separados, 1500);
  assert.equal(query('SELECT SUM(monto) AS total FROM movimientos_caja')[0][0].total, 0);
  assert.equal(query('SELECT saldo_pendiente FROM separados')[0][0].saldo_pendiente, 500);
  db.close();
});
test('abono inicial efectivo con ceros de UI', async () => {
  setup();
  const result = await route('post', '/', { ...cash, cliente_id: 1, detalles: [], total: 2000, abono_inicial: 1000 });
  assert.equal(result.status, 201);
  assert.equal(totals().total_efectivo, 1000);
  db.close();
});
test('transferencia y Mixto separan el ingreso físico; Mixto inválido revierte', async () => {
  setup();
  await route('post', '/:id/abonos', { ...cash, metodo_pago: 'Transferencia', monto: 1000 });
  await route('post', '/:id/abonos', { metodo_pago: 'Mixto', monto: 500, pago_efectivo: 200, pago_transferencia: 300 });
  assert.equal(totals().total_efectivo, 200);
  assert.equal(totals().total_transferencia, 1300);
  assert.equal((await route('post', '/:id/abonos', { metodo_pago: 'Mixto', monto: 500 })).status, 400);
  assert.equal(totals().total_abonos_separados, 1500);
  db.close();
});
test('devolución parcial 500 y remanente 1000, sin duplicar stock ni devolución', async () => {
  setup();
  db.exec(`INSERT INTO productos VALUES (1,1,3,0,'Producto',100);
    UPDATE separados SET detalles_json = '[{"id":1,"qty":2,"precio_venta":1000}]';`);
  await route('post', '/:id/abonos', { ...cash, monto: 1500 });
  let result = await route('put', '/:id/anular', { devolucion_efectivo: 500 });
  assert.equal(result.data.dinero_devuelto, 500);
  assert.equal(result.data.pendiente_devolucion, 1000);
  assert.equal(totals().total_efectivo, 1000);
  result = await route('put', '/:id/anular');
  assert.equal(result.data.dinero_devuelto, 1000);
  assert.equal(totals().total_efectivo, 0);
  assert.equal(totals().total_devoluciones_separados, 1500);
  assert.equal(query('SELECT cantidad FROM productos')[0][0].cantidad, 5);
  assert.equal(query('SELECT COUNT(*) AS n FROM kardex')[0][0].n, 1);
  assert.equal((await route('put', '/:id/anular')).status, 400);
  assert.equal(totals().total_devoluciones_separados, 1500);
  db.close();
});
test('devolución completa en efectivo de un pago por transferencia descuenta caja real', async () => {
  setup();
  await route('post', '/:id/abonos', { metodo_pago: 'Transferencia', monto: 1500 });
  assert.equal((await route('put', '/:id/anular', { devolucion_efectivo: 1500 })).status, 200);
  assert.equal(totals().total_efectivo, -1500);
  assert.equal(totals().total_transferencia, 1500);
  db.close();
});
test('devolución se atribuye a sesión actual aunque use mismo cajero y fecha de apertura', async () => {
  setup();
  await route('post', '/:id/abonos', { ...cash, monto: 1500 });
  await route('put', '/:id/anular', {}, { id: 5, empresa_id: 1, cajero_id: 7 });
  assert.equal(totals(10).total_efectivo, 1500);
  assert.equal(totals(11).total_efectivo, -1500);
  assert.equal(totals(10, 7, 2).total_efectivo, null);
  db.close();
});
test('facturación final no vuelve a sumar total ni efectivo; no permite repetir ni anular', async () => {
  setup();
  db.exec(`INSERT INTO productos VALUES (1,1,3,0,'Producto',100);
    UPDATE separados SET detalles_json = '[{"id":1,"qty":2,"precio_venta":1000}]';`);
  await route('post', '/:id/abonos', { ...cash, monto: 2000 });
  assert.equal((await route('put', '/:id/completar', { pago_efectivo: 2000 })).status, 200);
  assert.equal(totals().total_ventas, 2000);
  assert.equal(totals().total_efectivo, 2000);
  assert.equal(query('SELECT metodo_pago FROM facturas_venta')[0][0].metodo_pago, 'Separado');
  assert.equal(query('SELECT cantidad FROM productos')[0][0].cantidad, 3);
  assert.equal(query('SELECT COUNT(*) AS n FROM ventas')[0][0].n, 1);
  assert.equal((await route('put', '/:id/completar')).status, 400);
  assert.equal((await route('put', '/:id/anular')).status, 400);
  db.close();
});
test('pagos sin sesión, cajero ajeno, NaN o sobrepago no dejan registros', async () => {
  setup();
  for (const [monto, user] of [[1000,{ id: 99, empresa_id: 1, cajero_id: 7 }],
    [1000,{ id: 4, empresa_id: 1, cajero_id: 9 }], ['abc',undefined], [2500,undefined]]) {
    assert.equal((await route('post', '/:id/abonos', { ...cash, monto }, user)).status, 400);
  }
  assert.equal(query('SELECT COUNT(*) AS n FROM abonos_separados')[0][0].n, 0);
  db.close();
});
test('históricos simples con pagos cero: lectura corregida y devolución consistente sin editar datos', async () => {
  setup();
  db.exec(`INSERT INTO abonos_separados VALUES (1,1,1,7,1000,'Efectivo',0,0,CURRENT_TIMESTAMP);
    INSERT INTO abonos_separados VALUES (2,1,1,8,500,'Efectivo',500,0,CURRENT_TIMESTAMP);
    INSERT INTO abonos_separados VALUES (3,2,1,7,900,'Efectivo',900,0,CURRENT_TIMESTAMP);`);
  assert.equal(totals().total_efectivo, 1000);
  assert.equal((await route('get', '/historial-abonos')).data.abonos.length, 2);
  assert.equal((await route('put', '/:id/anular')).data.dinero_devuelto, 1500);
  assert.equal(totals().total_efectivo, -500);
  db.close();
});
test('estado actual y cierre persisten el mismo cuadre; sesión cerrada rechaza pagos', async () => {
  setup();
  await route('post', '/:id/abonos', { ...cash, monto: 1000 });
  await route('post', '/:id/abonos', { ...cash, monto: 500 });
  await route('put', '/:id/anular', { devolucion_efectivo: 500 });
  db.exec(`INSERT INTO movimientos_caja (empresa_id,usuario_id,sesion_caja_id,tipo,monto,descripcion)
    VALUES (1,4,10,'Ingreso',200,'Ingreso manual'),(1,4,10,'Salida',50,'Salida manual');`);
  const preview = await route('get', '/estado-actual', {}, undefined, {}, cajaRouter);
  assert.equal(preview.data.sesion.valor_esperado, 1250);
  const close = await route('post', '/cierre', { dinero_reportado: 1250 }, undefined, {}, cajaRouter);
  assert.equal(close.status, 200);
  assert.equal(close.data.resumen.valor_esperado, 1250);
  assert.equal(close.data.resumen.total_efectivo, 1000);
  assert.equal(close.data.resumen.diferencia, 0);
  assert.equal(query('SELECT total_efectivo FROM sesiones_caja WHERE id=10')[0][0].total_efectivo, 1000);
  assert.equal((await route('put', '/:id/anular')).status, 400);
  assert.equal((await route('post', '/cierre', { dinero_reportado: 1250 }, undefined, {}, cajaRouter)).status, 404);
  db.close();
});
test('devoluciones inválidas, cambio de medio parcial y fechas históricas', async () => {
  setup();
  await route('post', '/:id/abonos', { metodo_pago: 'Transferencia', monto: 1500 });
  for (const value of [1600, -1, 'abc', 0]) {
    assert.equal((await route('put', '/:id/anular', { devolucion_efectivo: value })).status, 400);
  }
  await route('put', '/:id/anular', { devolucion_efectivo: 500 });
  assert.equal((await route('put', '/:id/anular')).data.dinero_devuelto, 1000);
  assert.equal(totals().total_efectivo, -500);
  assert.equal(totals().total_transferencia, 500);
  db.exec(`INSERT INTO abonos_separados VALUES (99,1,1,7,400,'Efectivo',400,0,'1999-12-31');`);
  assert.equal(totals().total_efectivo, -500);
  assert.equal((await route('get', '/historial-abonos', {}, undefined, { query: { fecha: '1999-12-31' } })).data.abonos.length, 1);
  db.close();
});
test('factura histórica de conversión con evidencia Kardex no duplica el recaudo', async () => {
  setup();
  db.exec(`INSERT INTO abonos_separados VALUES (1,1,1,7,1500,'Efectivo',1500,0,CURRENT_TIMESTAMP);
    INSERT INTO facturas_venta VALUES (1,1,7,1,1500,'Efectivo',1500,0,CURRENT_TIMESTAMP);
    INSERT INTO kardex (empresa_id,motivo,referencia) VALUES (1,'Conversión Separado a Venta','FS-1');`);
  assert.equal(totals().total_efectivo, 1500);
  assert.equal(totals().total_ventas, 1500);
  db.close();
});
test('sesiones sin cajero se aíslan y cajero de token prevalece sobre selección UI', async () => {
  setup();
  await route('post', '/:id/abonos', { ...cash, monto: 1000 }, { id: 4, empresa_id: 1 });
  await route('post', '/:id/abonos', { ...cash, monto: 500 }, { id: 5, empresa_id: 1 });
  assert.equal(totals(10, null).total_efectivo, 1000);
  assert.equal(totals(11, null).total_efectivo, 500);
  await route('post', '/:id/abonos', { ...cash, monto: 500, cajero_id: 8 });
  assert.equal(query('SELECT cajero_id FROM abonos_separados ORDER BY id DESC LIMIT 1')[0][0].cajero_id, 7);
  db.close();
});
