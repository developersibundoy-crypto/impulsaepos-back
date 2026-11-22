'use strict';

const assert = require('node:assert');
const mysql = require('mysql2/promise');
const { registrarPagoAprobado, activarManual } = require('../../dist/services/pagosSaasService');

async function testPagosSaasTransaccional() {
  console.log('[TEST] Iniciando pruebas de pagos SaaS transaccionales e idempotencia...');

  const host = process.env.DB_HOST || '127.0.0.1';
  const port = Number(process.env.DB_PORT) || 3307;
  const user = process.env.DB_USER || 'impulsa_dev';
  const password = process.env.DB_PASSWORD || 'u88uAsA7dbPIDDIDoFDVlHHexhb7IfAFHxYFi4gin00=';
  const database = process.env.DB_NAME || 'impulsaepos_dev';

  const pool = mysql.createPool({ host, port, user, password, database, connectionLimit: 5 });
  const precios = { mes: 7000000, semestre: 37800000, anio: 67200000 };

  let empresaId = null;

  try {
    // 1. Crear empresa sintética de prueba
    const [resEmp] = await pool.query(`
      INSERT INTO empresas_suscritas (nombre_comercial, nit, fecha_vencimiento_suscripcion, estado)
      VALUES ('Empresa Test Transaccional', 'NIT_TEST_TX_999', '2026-01-01', 'Trial')
    `);
    empresaId = resEmp.insertId;

    // 2. Primer pago aprobado legítimo (Plan Mensual: 70.000 COP -> 7.000.000 centavos)
    const txId = `tx_test_${Date.now()}_abc`;
    const resPago1 = await registrarPagoAprobado(pool, {
      proveedor: 'wompi',
      eventoId: txId,
      referencia: `SUB_30_${empresaId}_1700000000`,
      montoCentavos: 7000000,
      moneda: 'COP'
    }, precios);

    assert.strictEqual(resPago1.estado, 'aplicado', 'El primer intento debe ser aplicado');
    assert.strictEqual(resPago1.dias, 30, 'Debe otorgar 30 días');

    // Verificar en BD que se actualizó vencimiento y se guardó evento
    const [empRows] = await pool.query('SELECT estado, fecha_vencimiento_suscripcion FROM empresas_suscritas WHERE id = ?', [empresaId]);
    assert.strictEqual(empRows[0].estado, 'Active', 'El estado de la empresa debe pasar a Active');
    const vencimiento1 = new Date(empRows[0].fecha_vencimiento_suscripcion).toISOString().slice(0, 10);

    // 3. Intento duplicado (mismo eventoId) - Debe responder 'duplicado' y NO sumar días
    const resPagoDuplicado = await registrarPagoAprobado(pool, {
      proveedor: 'wompi',
      eventoId: txId,
      referencia: `SUB_30_${empresaId}_1700000000`,
      montoCentavos: 7000000,
      moneda: 'COP'
    }, precios);

    assert.strictEqual(resPagoDuplicado.estado, 'duplicado', 'Reintento con mismo eventoId debe ser detectado como duplicado');

    const [empRows2] = await pool.query('SELECT fecha_vencimiento_suscripcion FROM empresas_suscritas WHERE id = ?', [empresaId]);
    const vencimiento2 = new Date(empRows2[0].fecha_vencimiento_suscripcion).toISOString().slice(0, 10);
    assert.strictEqual(vencimiento1, vencimiento2, 'La fecha de vencimiento no debe cambiar tras un evento duplicado');

    // 4. Pago con monto adulterado / no asociado a ningún plan -> debe registrar 'conciliar'
    const txIdAdulterado = `tx_test_fraud_${Date.now()}`;
    const resPagoFraude = await registrarPagoAprobado(pool, {
      proveedor: 'wompi',
      eventoId: txIdAdulterado,
      referencia: `SUB_30_${empresaId}_1700000000`,
      montoCentavos: 1000, // $10 pesos
      moneda: 'COP'
    }, precios);

    assert.strictEqual(resPagoFraude.estado, 'conciliar', 'Monto no correspondiente a un plan debe quedar en conciliar');

    const [eventoRows] = await pool.query('SELECT estado, detalle FROM pagos_saas_eventos WHERE evento_id = ?', [txIdAdulterado]);
    assert.strictEqual(eventoRows[0].estado, 'conciliar');

    // 5. Activación manual por superadmin
    const resManual = await activarManual(pool, {
      empresaId,
      dias: 15,
      monto: 35000,
      operador: 'superadmin_test',
      idOperacion: `MANUAL_TEST_${Date.now()}`
    });
    assert.strictEqual(resManual.ok, true, 'Activación manual legítima debe ser exitosa');

    const [pagosManual] = await pool.query('SELECT metodo_pago, dias_agregados FROM pagos_suscripcion WHERE empresa_id = ? AND metodo_pago LIKE "Manual%"', [empresaId]);
    assert.ok(pagosManual.length >= 1, 'El pago manual debe constar en pagos_suscripcion');
    assert.strictEqual(pagosManual[0].dias_agregados, 15);

    console.log('✅ [TEST] Pagos SaaS Transaccionales: Idempotencia y transacciones verificadas con éxito.');
  } finally {
    if (empresaId) {
      // Limpieza de datos sintéticos de prueba
      await pool.query('DELETE FROM pagos_saas_eventos WHERE empresa_id = ?', [empresaId]);
      await pool.query('DELETE FROM empresas_suscritas WHERE id = ?', [empresaId]);
    }
    await pool.end();
  }
}

testPagosSaasTransaccional().catch(err => {
  console.error('❌ [TEST] Error en Pagos SaaS Transaccionales:', err);
  process.exit(1);
});
