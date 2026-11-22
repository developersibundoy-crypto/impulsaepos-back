'use strict';

const { TABLE_OPTIONS, tableExists, assertTables, assertUniqueIndex, tableHasRows } = require('./_lib.cjs');

module.exports = {
  version: '20261120_001_pagos_saas_eventos',
  description: 'Registro idempotente de eventos de pasarela (pagos SaaS) y saas_gastos sin DDL en peticiones',
  tables: ['pagos_saas_eventos', 'saas_gastos'],

  async up(conn) {
    // Un evento de pasarela se identifica por (proveedor, evento_id). La restricción UNIQUE es la
    // garantía de "exactamente una vez" incluso con reintentos o procesos concurrentes.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS pagos_saas_eventos (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        proveedor VARCHAR(30) NOT NULL,
        evento_id VARCHAR(100) NOT NULL,
        referencia VARCHAR(255) NOT NULL DEFAULT '',
        empresa_id INT NULL,
        monto_centavos BIGINT NOT NULL,
        moneda CHAR(3) NOT NULL DEFAULT 'COP',
        dias INT NULL,
        estado ENUM('aplicado','conciliar','rechazado') NOT NULL,
        detalle VARCHAR(255) NULL,
        creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_pagos_saas_eventos_evento (proveedor, evento_id),
        KEY idx_pagos_saas_eventos_empresa (empresa_id, creado_en),
        KEY idx_pagos_saas_eventos_estado (estado, creado_en)
      ) ${TABLE_OPTIONS}
    `);

    // Misma definición que el DDL que antes se ejecutaba en cada petición (pagosSaaS.ts).
    await conn.query(`
      CREATE TABLE IF NOT EXISTS saas_gastos (
        id INT NOT NULL AUTO_INCREMENT,
        categoria VARCHAR(100) NOT NULL,
        descripcion TEXT NOT NULL,
        monto DECIMAL(15,2) NOT NULL,
        fecha DATE NOT NULL,
        metodo_pago VARCHAR(100) DEFAULT 'Transferencia',
        comprobante_url LONGTEXT NULL,
        creado_por VARCHAR(100) DEFAULT 'superadmin',
        fecha_registro TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id)
      ) ${TABLE_OPTIONS}
    `);
  },

  async verify(conn) {
    await assertTables(conn, ['pagos_saas_eventos', 'saas_gastos']);
    await assertUniqueIndex(conn, 'pagos_saas_eventos', 'uq_pagos_saas_eventos_evento', ['proveedor', 'evento_id']);
  },

  // Solo para entornos locales. Se niega a borrar si hay datos: no se descartan pagos reales.
  async down(conn) {
    if (await tableExists(conn, 'pagos_saas_eventos')) {
      if (await tableHasRows(conn, 'pagos_saas_eventos')) throw new Error('pagos_saas_eventos tiene datos: no se elimina');
      await conn.query('DROP TABLE pagos_saas_eventos');
    }
    // saas_gastos existía antes de esta migración: nunca se elimina desde aquí.
  },
};
