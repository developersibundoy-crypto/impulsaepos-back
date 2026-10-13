// Solo servidor LOCAL y base NUEVA aleatoria. Nunca importa conexión/servidor/setupDB.
require('ts-node/register/transpile-only');
const { test } = require('node:test');
const assert = require('node:assert/strict');
const mysql = require('mysql2');
const crypto = require('node:crypto');
const fs = require('node:fs');
let pool;
const facade = { promise: () => pool.promise(), query: (...args) => pool.query(...args) };
require.cache[require.resolve('../src/conection')] = { exports: { __esModule: true, default: facade } };
require.cache[require.resolve('../src/middlewares/authMiddleware')] = { exports: {
  verifyTokenAndTenant: (_req, _res, next) => next(), verifyPermission: () => (_req, _res, next) => next() } };
const separados = require('../src/routes/separados').default;
const caja = require('../src/routes/caja').default;
const ventas = require('../src/routes/ventas').default;
const reportes = require('../src/routes/reportes').default;
const service = require('../src/services/separadosCaja');
async function call(router, method, path, body = {}, id = 1, user = { id: 4, empresa_id: 1, cajero_id: 7 }, query = {}) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  return new Promise((resolve, reject) => {
    let status = 200;
    const res = { status(n) { status = n; return this; }, json(data) { resolve({ status, data }); return this; } };
    Promise.resolve(layer.route.stack.at(-1).handle({ user, params: { id }, body, query }, res)).catch(reject);
  });
}
const q = (...args) => pool.promise().query(...args);
async function totals(id = 10, cajero = 7) {
  const consulta = service.consultaCajaSeparados(1, cajero, { id, fecha_apertura: '2000-01-01' });
  return (await q(consulta.sql, consulta.params))[0][0];
}
function refund(ef, tr = 0, turno = 10, id = 1) {
  return { sesion_caja_id: turno, operacion_id: `${id}.${turno}.${crypto.randomUUID()}`, devolucion_efectivo: ef, devolucion_transferencia: tr };
}
test('MySQL real aislado: R1–R7, DECIMAL, collation, reintentos concurrentes y cambios firmados', async t => {
  const database = `opencode_separados_${crypto.randomBytes(10).toString('hex')}`;
  const admin = await mysql.createConnection({ host: '127.0.0.1', user: 'root', password: process.env.MYSQL_TEST_PASSWORD || '' }).promise();
  let created = false;
  try {
    await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_general_ci`);
    created = true;
    pool = mysql.createPool({ host: '127.0.0.1', user: 'root', password: process.env.MYSQL_TEST_PASSWORD || '', database,
      connectionLimit: 5, decimalNumbers: true, multipleStatements: true });
    pool.on('connection', c => c.query("SET time_zone = '-05:00'"));
    // Reutiliza el fixture sintético, adaptando tipos al motor real; no copia datos de tiendas.
    const source = fs.readFileSync(require.resolve('./separados-caja.test.cjs'), 'utf8');
    let fixture = source.match(/db\.exec\(`([\s\S]*?)`\);/)[1];
    fixture = fixture.replace(/INTEGER PRIMARY KEY/g, 'INT PRIMARY KEY AUTO_INCREMENT')
      .replace(/\bREAL\b/g, 'DECIMAL(15,2)').replace(/TEXT DEFAULT CURRENT_TIMESTAMP/g, 'TIMESTAMP DEFAULT CURRENT_TIMESTAMP')
      .replace(/fecha_apertura TEXT/g, 'fecha_apertura DATETIME').replace(/fecha_cierre TEXT/g, 'fecha_cierre DATETIME')
      .replace(/fecha TEXT/g, 'fecha DATETIME').replace(/fecha_emision TEXT/g, 'fecha_emision DATETIME');
    await q(fixture);
    const [engines] = await q('SELECT ENGINE FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?', [database]);
    assert.ok(engines.every(row => row.ENGINE === 'InnoDB'));
    await q(`ALTER TABLE ventas ADD id INT PRIMARY KEY AUTO_INCREMENT;
      ALTER TABLE productos ADD permitir_venta_negativa INT DEFAULT 1;
      CREATE TABLE empresa_config (empresa_id INT, permitir_venta_negativa INT);
      ALTER TABLE facturas_venta ADD iva DECIMAL(15,2) DEFAULT 0;
      ALTER TABLE facturas_electronicas ADD id INT PRIMARY KEY AUTO_INCREMENT, ADD cliente_id INT,
        ADD iva DECIMAL(15,2) DEFAULT 0, ADD prefijo VARCHAR(20), ADD consecutivo INT;
      ALTER TABLE cambios_factura ADD producto_devuelto_id INT, ADD producto_nuevo_id INT,
        ADD cantidad_devuelta INT, ADD cantidad_nueva INT, ADD valor_original DECIMAL(15,2), ADD valor_nuevo DECIMAL(15,2),
        MODIFY fecha DATETIME DEFAULT CURRENT_TIMESTAMP`);
    // ALTER exclusivo del fixture aleatorio, jamás del esquema aplicación.
    async function reset() {
      await q(`DELETE FROM abonos_separados; DELETE FROM movimientos_caja; DELETE FROM cambios_factura;
        DELETE FROM facturas_venta; DELETE FROM kardex; DELETE FROM productos; DELETE FROM ventas;
        DELETE FROM separados; UPDATE sesiones_caja SET estado='Abierta',fecha_cierre=NULL;
        INSERT INTO separados VALUES (1,1,1,7,2000,2000,'[]','Pendiente',CURRENT_TIMESTAMP,NULL)`);
    }
    await t.test('R1: NULL visible pendiente; cajero con único turno asignado; múltiples candidatos pendientes', async () => {
      await reset();
      await q(`INSERT INTO abonos_separados (empresa_id,separado_id,cajero_id,monto,metodo_pago,pago_efectivo,pago_transferencia)
        VALUES (1,1,NULL,1000,'Efectivo',0,0),(1,1,7,500,'Efectivo',0,0)`);
      const history = await call(separados, 'get', '/historial-abonos');
      assert.equal(history.data.abonos.length, 2);
      const unknown = history.data.abonos.find(a => a.cajero_id === null);
      assert.equal(unknown.pago_efectivo, 1000); assert.equal(unknown.pago_efectivo_crudo, 0); assert.equal(unknown.turno_id, null);
      assert.equal(Number((await totals()).total_efectivo), 500);
      assert.equal((await service.advertenciasCaja(pool.promise(), 1)).conciliacion_pendiente, true);
      await q('UPDATE usuarios_plataforma SET cajero_id=7 WHERE id=5');
      assert.equal(Number((await totals()).total_efectivo || 0), 0);
      await q('UPDATE usuarios_plataforma SET cajero_id=8 WHERE id=5');
      await q("UPDATE sesiones_caja SET fecha_apertura='2000-01-01' WHERE id=10");
      assert.equal(Number((await totals()).total_efectivo || 0), 0); // turno antiguo abierto no demuestra pertenencia
      await q('UPDATE sesiones_caja SET fecha_apertura=CURRENT_DATE WHERE id=10');
      await q("INSERT INTO abonos_separados (empresa_id,separado_id,cajero_id,monto,metodo_pago,pago_efectivo,pago_transferencia) VALUES (1,1,7,100,'Efectivo',NULL,NULL)");
      const nullable = (await call(separados, 'get', '/historial-abonos')).data.abonos.find(a => Number(a.monto) === 100);
      assert.equal(nullable.pago_efectivo_crudo, null); assert.equal(nullable.pago_efectivo, 100);
      assert.equal(Number((await totals()).total_efectivo), 600);
    });
    await t.test('R2: separado36 nominal cero, egreso desconocido y efectivo inferido marcado provisional', async () => {
      await reset();
      await q(`INSERT INTO abonos_separados (empresa_id,separado_id,cajero_id,monto,metodo_pago,pago_efectivo,pago_transferencia)
        VALUES (1,1,7,2000,'Efectivo',0,0),(1,1,7,1000,'Efectivo',0,0),(1,1,7,500,'Efectivo',0,0),(1,1,7,-3500,'Devolución Transferencia',0,0)`);
      const h = (await call(separados, 'get', '/historial-abonos')).data;
      const negative = h.abonos.find(a => a.monto < 0);
      assert.equal(negative.pago_efectivo, null); assert.equal(negative.pago_transferencia, null); assert.equal(negative.inconsistencia_historica, true);
      assert.equal(Number(h.resumen_global.total_recaudado_historico), 0);
      assert.equal(h.resumen_flujo_filtrado.efectivo_recibido, 3500);
      assert.equal(h.resumen_flujo_filtrado.efectivo_devuelto, 0);
      assert.equal(h.resumen_flujo_filtrado.movimientos_medio_desconocido, 1);
      const preview = (await call(caja, 'get', '/estado-actual')).data.sesion;
      assert.equal(preview.conciliacion_pendiente, true); assert.equal(preview.total_efectivo, 3500);
      assert.equal(Number((await q('SELECT SUM(monto) AS nominal, SUM(pago_efectivo) AS crudo FROM abonos_separados'))[0][0].nominal), 0);
      const reporte = await call(reportes, 'get', '/abonos-separados');
      assert.equal(reporte.status, 200);
      assert.equal(reporte.data.detalleAbonos.find(a => a.monto < 0).inconsistencia_historica, true);
      assert.equal(reporte.data.detalleAbonos.find(a => a.monto < 0).pago_transferencia, null);
    });
    await t.test('R3/R5: remanente en Anulado, resultado persistido y respuesta perdida/concurrente sin doble stock ni egreso', async () => {
      await reset();
      await q(`INSERT INTO productos (id,empresa_id,cantidad,es_servicio,nombre,precio_compra) VALUES (1,1,3,0,'Producto',100);
        UPDATE separados SET detalles_json='[{"id":1,"qty":2,"precio_venta":1000}]'`);
      assert.equal((await call(separados, 'post', '/:id/abonos', { monto: 1500, metodo_pago: 'Efectivo' })).status, 200);
      const payload = refund(500);
      const simultaneous = await Promise.all([call(separados, 'put', '/:id/anular', payload), call(separados, 'put', '/:id/anular', payload)]);
      assert.ok(simultaneous.every(r => r.status === 200));
      assert.equal(simultaneous.filter(r => r.data.reintento).length, 1);
      const lostResponseRetry = await call(separados, 'put', '/:id/anular', payload);
      assert.equal(lostResponseRetry.data.dinero_devuelto, 500); assert.equal(lostResponseRetry.data.pendiente_devolucion, 1000);
      assert.equal(Number((await totals()).total_devoluciones_separados), 500);
      assert.equal((await q('SELECT cantidad FROM productos'))[0][0].cantidad, 5);
      const h = (await call(separados, 'get', '/historial-abonos')).data;
      assert.equal(Number(h.resumen_global.total_recaudado_historico), 1000);
      assert.equal(h.abonos[0].pendiente_devolucion, 1000);
      assert.equal((await call(separados, 'put', '/:id/anular', { ...payload, devolucion_efectivo: 600 })).status, 400);
      assert.equal((await call(separados, 'put', '/:id/anular', { ...payload, sesion_caja_id: 11 })).status, 400);
      assert.equal((await call(separados, 'put', '/:id/anular', payload, 2)).status, 400);
      assert.equal((await call(separados, 'put', '/:id/anular', payload, 1, { id: 4, empresa_id: 2, cajero_id: 7 })).status, 400);
      assert.equal((await call(separados, 'put', '/:id/anular', payload, 1, { id: 5, empresa_id: 1, cajero_id: 8 })).status, 400);
      assert.equal((await call(separados, 'put', '/:id/anular', refund(1000))).status, 200);
      assert.equal((await call(separados, 'put', '/:id/anular', payload)).data.pendiente_devolucion, 1000); // resultado original
      assert.equal(Number((await totals()).total_efectivo), 0);
      await q("UPDATE sesiones_caja SET estado='Cerrada', fecha_cierre=CURRENT_TIMESTAMP WHERE id=10");
      assert.equal((await call(separados, 'put', '/:id/anular', payload)).data.reintento, true);
      assert.equal(Number((await totals()).total_devoluciones_separados), 1500);
    });
    await t.test('R4: collation CI no admite falsificación, turnos ajenos/cerrados, referencias duplicadas', async () => {
      await reset();
      assert.equal((await q("SELECT 'abono_separado:48' = 'ABONO_SEPARADO:48' AS igual"))[0][0].igual, 1);
      for (const descripcion of ['abono_separado:48', ' ABONO_SEPARADO:48 ', 'DeVoLuCiOn_SePaRaDo:xx', 'ABONO_SEPARADO :48']) {
        assert.equal((await call(caja, 'post', '/movimiento', { monto: 1, descripcion, tipo: 'Ingreso', sesion_caja_id: 10 })).status, 400);
      }
      assert.equal((await call(caja, 'post', '/movimiento', { monto: 1, descripcion: 'Manual', tipo: 'Ingreso', sesion_caja_id: 11 })).status, 400);
      await q("UPDATE sesiones_caja SET estado='Cerrada' WHERE id=10");
      assert.equal((await call(caja, 'post', '/movimiento', { monto: 1, descripcion: 'Manual', tipo: 'Ingreso', sesion_caja_id: 10 })).status, 400);
      await q("UPDATE sesiones_caja SET estado='Abierta' WHERE id=10");
      const r = await call(separados, 'post', '/:id/abonos', { monto: 1000, metodo_pago: 'Efectivo' }); assert.equal(r.status, 200);
      const id = (await q('SELECT id FROM abonos_separados'))[0][0].id;
      await q("INSERT INTO movimientos_caja (empresa_id,usuario_id,sesion_caja_id,tipo,monto,descripcion) VALUES (1,5,11,'Ingreso',1,?)", [`abono_separado:${id}`]);
      assert.equal(Number((await totals()).total_efectivo), 1000);
      await q("INSERT INTO movimientos_caja (empresa_id,usuario_id,sesion_caja_id,tipo,monto,descripcion) VALUES (1,5,11,'Ingreso',0,?)", [`ABONO_SEPARADO:${id}`]);
      assert.equal(Number((await totals()).total_efectivo || 0), 0);
      assert.equal((await service.advertenciasCaja(pool.promise(), 1)).conciliacion_pendiente, true);
    });
    await t.test('R6: factura convertida, cambios positivos/negativos en otros turnos y borrado protegido', async () => {
      await reset();
      await q(`INSERT INTO productos (id,empresa_id,cantidad,es_servicio,nombre,precio_compra) VALUES (1,1,3,0,'Producto',100),(2,1,5,0,'Nuevo',100);
        UPDATE separados SET detalles_json='[{"id":1,"qty":2,"precio_venta":1000}]'`);
      await call(separados, 'post', '/:id/abonos', { monto: 2000, metodo_pago: 'Efectivo' });
      const f = await call(separados, 'put', '/:id/completar'); assert.equal(f.status, 200);
      const factura = f.data.factura_id;
      assert.equal(Number((await totals()).total_efectivo), 2000);
      const user = { id: 5, empresa_id: 1, cajero_id: 8 };
      let change = await call(ventas, 'post', '/cambio-producto', { factura_id: factura, producto_devuelto_id: 1, producto_nuevo_id: 2,
        cantidad_devuelta: 2, cantidad_nueva: 2, valor_nuevo: 750, saldo_adicional: -500, metodo_pago: 'Efectivo' }, 1, user);
      assert.equal(change.status, 200, JSON.stringify(change.data));
      assert.equal(Number((await totals(11, 8)).total_efectivo), -500);
      assert.equal(Number((await totals()).total_efectivo), 2000);
      change = await call(ventas, 'post', '/cambio-producto', { factura_id: factura, producto_devuelto_id: 2, producto_nuevo_id: 1,
        cantidad_devuelta: 2, cantidad_nueva: 2, valor_nuevo: 1000, saldo_adicional: 500, metodo_pago: 'Transferencia' }, 1, user);
      assert.equal(change.status, 200, JSON.stringify(change.data));
      assert.equal(Number((await totals(11, 8)).total_transferencia), 500);
      assert.equal((await call(ventas, 'delete', '/:id', {}, factura)).status, 409);
      assert.equal((await q('SELECT COUNT(*) AS n FROM facturas_venta'))[0][0].n, 1);
      assert.equal((await q('SELECT cantidad FROM productos WHERE id=1'))[0][0].cantidad, 3);
      const [legacy] = await q("INSERT INTO facturas_venta (empresa_id,cajero_id,cliente_id,total,metodo_pago,pago_efectivo,pago_transferencia) VALUES (1,7,1,1500,'Efectivo',1500,0)");
      await q("INSERT INTO kardex (empresa_id,motivo,referencia) VALUES (1,'Conversión Separado a Venta',?)", [`FS-${legacy.insertId}`]);
      await q("INSERT INTO cambios_factura (empresa_id,cajero_id,factura_original_id,saldo_adicional,metodo_pago,fecha) VALUES (1,8,?,-250,'Efectivo',CURRENT_TIMESTAMP)", [legacy.insertId]);
      assert.equal(Number((await totals(11, 8)).total_efectivo), -750);
      const listado = await call(ventas, 'get', '/', {}, 1, undefined, { tipo_factura: 'POS', filtro: 'Separado' });
      assert.equal(listado.status, 200, JSON.stringify(listado.data));
      assert.equal(listado.data.data.length, 2);
      assert.ok(listado.data.data.every(f => f.origen_separado === 1));
    });
    await t.test('R7: DECIMAL exacto, subcentavos rechazados y medio efectivo de origen electrónico', async () => {
      await reset();
      for (const monto of [0.004, 1.0005, 'NaN']) assert.equal((await call(separados, 'post', '/:id/abonos', { monto, metodo_pago: 'Efectivo' })).status, 400);
      assert.equal((await call(separados, 'post', '/:id/abonos', { monto: '1.01', metodo_pago: 'Transferencia' })).status, 200);
      assert.equal((await call(separados, 'put', '/:id/anular', refund('1.0105'))).status, 400);
      assert.equal((await call(separados, 'put', '/:id/anular', refund('1.02'))).status, 400);
      assert.equal((await call(separados, 'put', '/:id/anular', { sesion_caja_id: 10, operacion_id: refund(0).operacion_id })).status, 400);
      const r = await call(separados, 'put', '/:id/anular', refund('1.01')); assert.equal(r.status, 200); assert.equal(r.data.pendiente_devolucion, 0);
      assert.equal(Number((await totals()).total_efectivo), -1.01);
      assert.equal(Number((await totals()).total_transferencia), 1.01);
      assert.equal(Number((await q('SELECT SUM(monto) AS n FROM abonos_separados'))[0][0].n), 0);
      await reset();
      await call(separados, 'post', '/:id/abonos', { monto: '0.10', metodo_pago: 'Efectivo' });
      await call(separados, 'post', '/:id/abonos', { monto: '0.20', metodo_pago: 'Efectivo' });
      const detail = await call(separados, 'get', '/:id');
      assert.equal(detail.data.separado.neto_abonado, 0.3);
      assert.equal((await call(separados, 'put', '/:id/anular', refund('0.30'))).data.pendiente_devolucion, 0);
    });
    console.log(`Fixture aislado ${database}; InnoDB/DECIMAL y collation utf8mb4_general_ci. Limpieza al finalizar.`);
  } finally {
    if (pool) await pool.promise().end();
    if (created) {
      await admin.query(`DROP DATABASE \`${database}\``);
      const [restante] = await admin.query('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [database]);
      assert.equal(restante.length, 0);
      console.log(`Limpieza verificada: ${database} eliminado.`);
    }
    await admin.end();
  }
});
