'use strict';

const {
  TABLE_OPTIONS,
  addColumnIfMissing,
  assertTables,
  assertUniqueIndex,
  assertForeignKey,
} = require('./_lib.cjs');

const TABLAS = ['tienda_pasarelas_config'];

module.exports = {
  version: '20261122_006_tienda_pasarela_wompi',
  description: 'Configuración de pasarelas de pago (Wompi) por tienda y soporte en pedidos',
  tables: TABLAS,

  async up(conn) {
    // 1. Tabla para configuración de pasarela por tienda (Wompi y futuros proveedores)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tienda_pasarelas_config (
        id INT NOT NULL AUTO_INCREMENT,
        tienda_id INT NOT NULL,
        empresa_id INT NOT NULL,
        proveedor VARCHAR(40) NOT NULL DEFAULT 'wompi',
        activo TINYINT(1) NOT NULL DEFAULT 0,
        ambiente ENUM('sandbox', 'produccion') NOT NULL DEFAULT 'sandbox',
        public_key VARCHAR(255) NULL,
        integrity_secret VARCHAR(255) NULL,
        event_secret VARCHAR(255) NULL,
        creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_pasarela_tienda (tienda_id, proveedor),
        KEY idx_pasarela_empresa (empresa_id),
        CONSTRAINT fk_pasarela_tienda FOREIGN KEY (tienda_id, empresa_id) REFERENCES tiendas (id, empresa_id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}
    `);

    // 2. Extender método de pago en pedidos para admitir 'wompi'
    await conn.query(`
      ALTER TABLE tienda_pedidos
      MODIFY COLUMN metodo_pago ENUM('transferencia_manual', 'efectivo_recogida', 'wompi') NOT NULL DEFAULT 'transferencia_manual'
    `);

    // 3. Columnas de auditoría de transacción Wompi en tienda_pedidos
    await addColumnIfMissing(conn, 'tienda_pedidos', 'wompi_transaction_id', 'VARCHAR(100) NULL AFTER comprobante_url');
    await addColumnIfMissing(conn, 'tienda_pedidos', 'wompi_estado', 'VARCHAR(50) NULL AFTER wompi_transaction_id');
  },

  async verify(conn) {
    await assertTables(conn, TABLAS);
    await assertUniqueIndex(conn, 'tienda_pasarelas_config', 'uq_pasarela_tienda', ['tienda_id', 'proveedor']);
    await assertForeignKey(conn, 'tienda_pasarelas_config', 'fk_pasarela_tienda');
  },
};
