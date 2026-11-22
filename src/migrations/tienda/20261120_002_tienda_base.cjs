'use strict';

const {
  TABLE_OPTIONS, tableExists, assertTables, assertUniqueIndex, assertForeignKey, tableHasRows,
} = require('./_lib.cjs');

// Nombres de enlace que nunca puede tomar un comercio.
const SLUGS_RESERVADOS = [
  'admin', 'api', 'app', 'www', 'tienda', 'tiendas', 'login', 'registro', 'dashboard', 'static',
  'assets', 'impulsa', 'impulsaepos', 'soporte', 'ayuda', 'pedido', 'pedidos', 'carrito', 'checkout',
  'backup', 'auth', 'public', 'health', 'status', 'mail', 'panel', 'pago', 'pagos', 'catalogo',
];

const TABLAS = [
  'tiendas', 'tienda_slugs_reservados', 'tienda_contrataciones', 'tienda_publicaciones', 'tienda_auditoria',
];

module.exports = {
  version: '20261120_002_tienda_base',
  description: 'Tienda por empresa, enlaces reservados, contratación del complemento, publicaciones y auditoría',
  tables: TABLAS,

  async up(conn) {
    // Una tienda por empresa y un enlace único. El UNIQUE (id, empresa_id) permite claves foráneas
    // compuestas: una publicación no puede apuntar a una tienda de otra empresa.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tiendas (
        id INT NOT NULL AUTO_INCREMENT,
        empresa_id INT NOT NULL,
        slug VARCHAR(60) NOT NULL,
        nombre VARCHAR(120) NOT NULL,
        descripcion VARCHAR(500) NULL,
        logo_url VARCHAR(500) NULL,
        correo_contacto VARCHAR(120) NULL,
        telefono_contacto VARCHAR(40) NULL,
        estado ENUM('borrador','publicada','pausada') NOT NULL DEFAULT 'borrador',
        creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_tiendas_empresa (empresa_id),
        UNIQUE KEY uq_tiendas_slug (slug),
        UNIQUE KEY uq_tiendas_id_empresa (id, empresa_id),
        CONSTRAINT fk_tiendas_empresa FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas (id) ON DELETE CASCADE,
        CONSTRAINT ck_tiendas_slug CHECK (slug REGEXP '^[a-z0-9]+(-[a-z0-9]+)*$')
      ) ${TABLE_OPTIONS}
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS tienda_slugs_reservados (
        slug VARCHAR(60) NOT NULL,
        motivo VARCHAR(100) NOT NULL DEFAULT 'reservado por la plataforma',
        PRIMARY KEY (slug)
      ) ${TABLE_OPTIONS}
    `);
    for (const slug of SLUGS_RESERVADOS) {
      await conn.query('INSERT IGNORE INTO tienda_slugs_reservados (slug) VALUES (?)', [slug]);
    }

    // Vigencia del complemento, independiente del POS (empresas_suscritas). Historial: una fila por periodo.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tienda_contrataciones (
        id INT NOT NULL AUTO_INCREMENT,
        empresa_id INT NOT NULL,
        desde DATE NOT NULL,
        vence_en DATE NOT NULL,
        estado ENUM('pendiente','vigente','vencida','cancelada') NOT NULL DEFAULT 'pendiente',
        origen ENUM('manual','pasarela','prueba') NOT NULL DEFAULT 'manual',
        referencia VARCHAR(100) NULL,
        monto_centavos BIGINT NOT NULL DEFAULT 0,
        creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_tienda_contrataciones_ref (origen, referencia),
        KEY idx_tienda_contrataciones_vigencia (empresa_id, vence_en),
        CONSTRAINT fk_tienda_contrataciones_empresa FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas (id) ON DELETE CASCADE,
        CONSTRAINT ck_tienda_contrataciones_fechas CHECK (vence_en >= desde)
      ) ${TABLE_OPTIONS}
    `);

    // Publicación explícita de productos. empresa_id se repite a propósito para la FK compuesta.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tienda_publicaciones (
        id INT NOT NULL AUTO_INCREMENT,
        tienda_id INT NOT NULL,
        empresa_id INT NOT NULL,
        producto_id INT NOT NULL,
        titulo VARCHAR(160) NULL,
        descripcion_publica TEXT NULL,
        orden INT NOT NULL DEFAULT 0,
        visible TINYINT(1) NOT NULL DEFAULT 1,
        creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        actualizado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        UNIQUE KEY uq_tienda_publicaciones_producto (tienda_id, producto_id),
        KEY idx_tienda_publicaciones_empresa (empresa_id),
        KEY idx_tienda_publicaciones_producto (producto_id),
        CONSTRAINT fk_tienda_publicaciones_tienda FOREIGN KEY (tienda_id, empresa_id) REFERENCES tiendas (id, empresa_id) ON DELETE CASCADE,
        CONSTRAINT fk_tienda_publicaciones_producto FOREIGN KEY (producto_id) REFERENCES productos (id) ON DELETE CASCADE
      ) ${TABLE_OPTIONS}
    `);

    // Auditoría de cambios de estado. Sin FK a propósito: debe sobrevivir al borrado de la entidad.
    await conn.query(`
      CREATE TABLE IF NOT EXISTS tienda_auditoria (
        id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
        empresa_id INT NOT NULL,
        entidad VARCHAR(40) NOT NULL,
        entidad_id BIGINT NULL,
        accion VARCHAR(60) NOT NULL,
        actor_tipo ENUM('usuario','sistema','publico') NOT NULL DEFAULT 'usuario',
        actor_id INT NULL,
        detalle TEXT NULL,
        creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_tienda_auditoria_entidad (empresa_id, entidad, entidad_id, creado_en)
      ) ${TABLE_OPTIONS}
    `);
  },

  async verify(conn) {
    await assertTables(conn, TABLAS);
    await assertUniqueIndex(conn, 'tiendas', 'uq_tiendas_empresa', ['empresa_id']);
    await assertUniqueIndex(conn, 'tiendas', 'uq_tiendas_slug', ['slug']);
    await assertUniqueIndex(conn, 'tiendas', 'uq_tiendas_id_empresa', ['id', 'empresa_id']);
    await assertUniqueIndex(conn, 'tienda_publicaciones', 'uq_tienda_publicaciones_producto', ['tienda_id', 'producto_id']);
    await assertForeignKey(conn, 'tiendas', 'fk_tiendas_empresa');
    await assertForeignKey(conn, 'tienda_publicaciones', 'fk_tienda_publicaciones_tienda');
    await assertForeignKey(conn, 'tienda_publicaciones', 'fk_tienda_publicaciones_producto');
    const [reservados] = await conn.query('SELECT COUNT(*) n FROM tienda_slugs_reservados');
    if (Number(reservados[0].n) < SLUGS_RESERVADOS.length) throw new Error('Verificación fallida: faltan enlaces reservados');
  },

  // Solo para entornos locales. Nunca elimina tablas con datos.
  async down(conn) {
    for (const table of ['tienda_auditoria', 'tienda_publicaciones', 'tienda_contrataciones', 'tienda_slugs_reservados', 'tiendas']) {
      if (!(await tableExists(conn, table))) continue;
      if (table !== 'tienda_slugs_reservados' && (await tableHasRows(conn, table))) {
        throw new Error(`${table} tiene datos: no se elimina`);
      }
      await conn.query(`DROP TABLE ${table}`);
    }
  },
};
