'use strict';

const assert = require('node:assert');
const crypto = require('node:crypto');
const {
  calcularFirmaIntegridad,
  enmascararSecreto,
  validarFormatoLlaves,
  validarWebhookTienda
} = require('../../dist/services/tiendaWompiService');

async function testTiendaWompi() {
  console.log('[TEST] Iniciando pruebas unitarias de tiendaWompiService...');

  // 1. Cálculo de firma de integridad (SHA-256 oficial Wompi)
  const referencia = 'PED-20261122-TEST1';
  const montoCentavos = 4500000; // $45.000 COP
  const secretoIntegridad = 'test_integrity_abcdef12345';
  const firmaGenerada = calcularFirmaIntegridad(referencia, montoCentavos, 'COP', secretoIntegridad);

  const firmaEsperada = crypto
    .createHash('sha256')
    .update(`${referencia}${montoCentavos}COP${secretoIntegridad}`)
    .digest('hex');

  assert.strictEqual(firmaGenerada, firmaEsperada, 'La firma de integridad debe coincidir exactamente con el SHA256 oficial');
  assert.strictEqual(firmaGenerada.length, 64, 'La firma de integridad debe ser de 64 caracteres');

  // Parámetros inválidos
  assert.throws(() => calcularFirmaIntegridad('', montoCentavos, 'COP', secretoIntegridad), /Parámetros inválidos/);
  assert.throws(() => calcularFirmaIntegridad(referencia, 0, 'COP', secretoIntegridad), /Parámetros inválidos/);
  assert.throws(() => calcularFirmaIntegridad(referencia, -50, 'COP', secretoIntegridad), /Parámetros inválidos/);
  assert.throws(() => calcularFirmaIntegridad(referencia, montoCentavos, 'COP', ''), /Parámetros inválidos/);

  // 2. Enmascaramiento de secretos
  assert.strictEqual(enmascararSecreto(null), '');
  assert.strictEqual(enmascararSecreto(''), '');
  assert.strictEqual(enmascararSecreto('123'), '••••');
  assert.strictEqual(enmascararSecreto('test_integrity_9999'), '••••••••9999');

  // 3. Validación de formatos según ambiente
  // Sandbox válido
  const sbOk = validarFormatoLlaves('sandbox', 'pub_test_123', 'test_integrity_abc', 'test_events_xyz');
  assert.strictEqual(sbOk.valido, true);

  // Sandbox con llave prod -> error
  const sbError = validarFormatoLlaves('sandbox', 'pub_prod_123');
  assert.strictEqual(sbError.valido, false);
  assert.ok(sbError.error.includes('pub_test_'));

  // Producción válido
  const prodOk = validarFormatoLlaves('produccion', 'pub_prod_999', 'prod_integrity_abc', 'prod_events_xyz');
  assert.strictEqual(prodOk.valido, true);

  // Producción con llave test -> error
  const prodError = validarFormatoLlaves('produccion', 'pub_test_999');
  assert.strictEqual(prodError.valido, false);
  assert.ok(prodError.error.includes('pub_prod_'));

  // Manejo de secretos enmascarados al actualizar (no deben dar error de formato)
  const maskedOk = validarFormatoLlaves('sandbox', 'pub_test_123', '••••••••abcd', '••••••••wxyz');
  assert.strictEqual(maskedOk.valido, true, 'Secretos ya enmascarados no deben generar error de validación');

  // 4. Validación de webhook de tienda con secreto de eventos
  const secretoTiendaA = 'test_events_secret_tienda_A';
  const secretoTiendaB = 'test_events_secret_tienda_B';

  const eventoWompi = {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: 'tx-wompi-1001',
        status: 'APPROVED',
        amount_in_cents: 4500000,
        currency: 'COP',
        reference: 'PED-20261122-TEST1'
      }
    },
    timestamp: 1732280000,
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum: ''
    }
  };

  // Firmar con el secreto de la tienda A
  const propValues = 'tx-wompi-1001' + 'APPROVED' + '4500000' + '1732280000' + secretoTiendaA;
  eventoWompi.signature.checksum = crypto.createHash('sha256').update(propValues).digest('hex');

  // Validación con la tienda A: VÁLIDO
  assert.strictEqual(validarWebhookTienda(eventoWompi, secretoTiendaA), true, 'Firma debe ser válida para la tienda dueña del secreto');

  // Validación con la tienda B: INVÁLIDO (Aislamiento entre tiendas)
  assert.strictEqual(validarWebhookTienda(eventoWompi, secretoTiendaB), false, 'Tienda B no debe poder validar eventos de tienda A');

  // Modificación maliciosa del importe
  const eventoAlterado = JSON.parse(JSON.stringify(eventoWompi));
  eventoAlterado.data.transaction.amount_in_cents = 1000;
  assert.strictEqual(validarWebhookTienda(eventoAlterado, secretoTiendaA), false, 'Evento alterado debe ser rechazado');

  console.log('✅ [TEST] Todas las pruebas de tiendaWompiService pasaron exitosamente.');
}

testTiendaWompi().catch(err => {
  console.error('❌ [TEST] Error en tiendaWompiService:', err);
  process.exit(1);
});
