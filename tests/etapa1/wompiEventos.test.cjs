'use strict';

const assert = require('node:assert');
const {
  checksumEsperado,
  firmaValida,
  parsearReferencia,
  resolverPlan
} = require('../../dist/services/wompiEventos');

async function testWompiService() {
  console.log('[TEST] Iniciando pruebas unitarias de WompiEventos...');

  const secreto = 'test_event_secret_12345';
  const eventoValido = {
    event: 'transaction.updated',
    data: {
      transaction: {
        id: '12345-67890-test',
        status: 'APPROVED',
        amount_in_cents: 7000000,
        currency: 'COP',
        reference: 'SUB_30_10_1700000000'
      }
    },
    timestamp: 1700000000,
    signature: {
      properties: ['transaction.id', 'transaction.status', 'transaction.amount_in_cents'],
      checksum: ''
    }
  };

  // 1. Cálculo correcto de checksum
  const esperado = checksumEsperado(eventoValido, secreto);
  assert.ok(esperado && esperado.length === 64, 'El checksum esperado debe ser un SHA256 hex de 64 caracteres');

  // 2. Firma válida
  eventoValido.signature.checksum = esperado;
  assert.strictEqual(firmaValida(eventoValido, secreto), true, 'La firma debe ser válida cuando coincide con el secreto');

  // 3. Firma inválida (secreto incorrecto)
  assert.strictEqual(firmaValida(eventoValido, 'secreto_falso'), false, 'Firma debe fallar con secreto equivocado');

  // 4. Firma inválida (payload alterado)
  const eventoAlterado = JSON.parse(JSON.stringify(eventoValido));
  eventoAlterado.data.transaction.amount_in_cents = 100000;
  assert.strictEqual(firmaValida(eventoAlterado, secreto), false, 'Firma debe fallar si se altera el monto');

  // 5. Parseo de referencias
  const ref1 = parsearReferencia('SUB_30_5_1732000000');
  assert.deepStrictEqual(ref1, { empresaId: 5, diasDeclarados: 30, feDeclarada: false });

  const refFE = parsearReferencia('SUB_180_FE_12_1732000000');
  assert.deepStrictEqual(refFE, { empresaId: 12, diasDeclarados: 180, feDeclarada: true });

  const refLogin = parsearReferencia('SUB_LOGIN_7_1732000000');
  assert.deepStrictEqual(refLogin, { empresaId: 7, diasDeclarados: null, feDeclarada: false });

  const refInvalida = parsearReferencia('MALICIOSO_1_2');
  assert.strictEqual(refInvalida, null, 'Referencias desconocidas deben retornar null');

  // 6. Resolución de planes por centavos
  const precios = { mes: 7000000, semestre: 37800000, anio: 67200000 };
  const p1 = resolverPlan(7000000, precios);
  assert.deepStrictEqual(p1, { dias: 30, fe: false });

  const pFE = resolverPlan(54000000, precios);
  assert.deepStrictEqual(pFE, { dias: 180, fe: true });

  const pInvalido = resolverPlan(123456, precios);
  assert.strictEqual(pInvalido, null, 'Montos extraños no deben asociarse a planes');

  console.log('✅ [TEST] WompiEventos: Todas las aserciones pasaron correctamente.');
}

testWompiService().catch(err => {
  console.error('❌ [TEST] Error en WompiEventos:', err);
  process.exit(1);
});
