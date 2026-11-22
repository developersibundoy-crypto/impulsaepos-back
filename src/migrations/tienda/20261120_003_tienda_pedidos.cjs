'use strict';

const {
  TABLE_OPTIONS,
  addColumnIfMissing,
  assertTables,
} = require('./_lib.cjs');

const TABLAS = [
  'tienda_pedidos',
  'tienda_pedido_items',
  'tienda_reservas',
];

module.exports = {
  version: '20261120_003_tienda_pedidos',
  description: 'Estructura de pedidos online, copia histórica de ítems y reservas atómicas con TTL',
  tables: TABLAS,

  async up(conn) {
    // 1. Campos adicionales opcionales para la personalización y logística de la tienda
    await addColumnIfMissing(conn, 'tiendas', 'color_primario', "VARCHAR(20) NOT NULL DEFAULT '#4f46e5'");
    await addColumnIfMissing(conn, 'tiendas', 'direccion_recogida', 'VARCHAR(255) NULL');
    await addColumnIfMissing(conn, 'tiendas', 'horario_atencion', 'VARCHAR(255) NULL');
    await addColumnIfMissing(conn, 'tienda_publicaciones', 'imagen_url', 'VARCHAR(500) NULL');

    // 2. Pedidos en línea
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tienda_pedidos (
        id INT NOT NULL AUTO_INCREMENT,
        empresa_id INT NOT NULL,
        tienda_id INT NOT NULL,
        codigo_orden VARCHAR(32) NOT NULL,
        token_seguimiento VARCHAR(64) NOT NULL,
        clave_idempotencia VARCHAR(64) NULL,
        cliente_nombre VARCHAR(150) NOT NULL,
        cliente_telefono VARCHAR(50) NOT NULL,
        cliente_email VARCHAR(150) NULL,
        metodo_entrega ENUM('recogida', 'acordar_vendedor') NOT NULL DEFAULT 'recogida',
        metodo_pago ENUM('transferencia_manual', 'efectivo_recogida') NOT NULL DEFAULT 'transferencia_manual',
        estado ENUM('pendiente', 'comprobante_enviado', 'confirmado', 'preparando', 'listo_recogida', 'entregado', 'cancelado') NOT NULL DEFAULT 'pendiente',
        subtotal DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        total DECIMAL(12,2) NOT NULL DEFAULT 0.00,
        notas_cliente TEXT NULL,
        comprobante_url TEXT NULL,
        fecha_limite_pago DATETIME NULL,
        creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_tienda_pedidos_token (token_seguimiento),
        UNIQUE KEY uq_tienda_pedidos_idempresa (id, empresa_id),
        KEY idx_tienda_pedidos_empresa_estado (empresa_id, estado),
        KEY idx_tienda_pedidos_tienda_fecha (tienda_id, creado_en),
        KEY idx_tienda_pedidos_idempotencia (clave_idempotencia),
        CONSTRAINT fk_tienda_pedidos_tienda FOREIGN KEY (tienda_id, empresa_id) REFERENCES tiendas (id, empresa_id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}
    `);

    // 3. Ítems del pedido (copia inmutable histórica)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tienda_pedido_items (
        id INT NOT NULL AUTO_INCREMENT,
        pedido_id INT NOT NULL,
        producto_id INT NOT NULL,
        titulo_historico VARCHAR(200) NOT NULL,
        precio_unitario DECIMAL(12,2) NOT NULL,
        cantidad INT NOT NULL,
        subtotal DECIMAL(12,2) NOT NULL,
        PRIMARY KEY (id),
        KEY idx_tienda_items_pedido (pedido_id),
        KEY idx_tienda_items_producto (producto_id),
        CONSTRAINT fk_tienda_items_pedido FOREIGN KEY (pedido_id) REFERENCES tienda_pedidos (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}
    `);

    // 4. Reservas de inventario con expiración (TTL)
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tienda_reservas (
        id INT NOT NULL AUTO_INCREMENT,
        empresa_id INT NOT NULL,
        pedido_id INT NOT NULL,
        producto_id INT NOT NULL,
        cantidad INT NOT NULL,
        expira_en DATETIME NOT NULL,
        estado ENUM('activa', 'consolidada', 'liberada', 'cancelada') NOT NULL DEFAULT 'activa',
        creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_tienda_reservas_expiracion (expira_en, estado),
        KEY idx_tienda_reservas_pedido (pedido_id),
        KEY idx_tienda_reservas_prod (producto_id),
        CONSTRAINT fk_tienda_reservas_pedido FOREIGN KEY (pedido_id) REFERENCES tienda_pedidos (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}
    `);
  },

  async verify(conn) {
    await assertTables(conn, TABLAS);
  },
};
