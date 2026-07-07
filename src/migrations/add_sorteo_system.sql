-- =============================================================
-- MIGRACIÓN: Sistema de Sorteo / Ruleta de Premios
-- =============================================================
-- Ejecutar en la base de datos activa (tienda_db)
-- Este script es IDEMPOTENTE: se puede ejecutar varias veces
-- =============================================================

-- ─── 1. TABLA premios_sorteo ─────────────────────────────────

CREATE TABLE IF NOT EXISTS premios_sorteo (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id              INT NOT NULL,
  nombre                  VARCHAR(200) NOT NULL,
  descripcion             TEXT DEFAULT NULL,
  cantidad_disponible     INT NOT NULL DEFAULT 0,
  cantidad_max_ganadores  INT DEFAULT NULL,
  estado                  ENUM('Activo','Inactivo') NOT NULL DEFAULT 'Activo',
  imagen                  VARCHAR(500) DEFAULT NULL,
  orden_entrega           INT NOT NULL DEFAULT 0,
  fecha_vigencia          DATE DEFAULT NULL,
  creado_en               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
  INDEX idx_empresa_estado (empresa_id, estado),
  INDEX idx_empresa_orden (empresa_id, orden_entrega)
);

-- ─── 2. TABLA sorteo_historial ────────────────────────────────

CREATE TABLE IF NOT EXISTS sorteo_historial (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id        INT NOT NULL,
  cliente_id        INT NOT NULL,
  cliente_nombre    VARCHAR(255) NOT NULL,
  premio_id         INT DEFAULT NULL,
  premio_nombre     VARCHAR(200) DEFAULT NULL,
  fecha             DATE NOT NULL,
  hora              TIME NOT NULL,
  usuario_id        INT DEFAULT NULL,
  usuario_nombre    VARCHAR(255) DEFAULT NULL,
  numero_sorteo     INT NOT NULL DEFAULT 1,
  estado_entrega    ENUM('Pendiente','Entregado') NOT NULL DEFAULT 'Pendiente',
  creado_en         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
  FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
  FOREIGN KEY (premio_id) REFERENCES premios_sorteo(id) ON DELETE SET NULL,
  INDEX idx_empresa_cliente (empresa_id, cliente_id),
  INDEX idx_empresa_fecha (empresa_id, fecha),
  INDEX idx_empresa_numero (empresa_id, numero_sorteo)
);

-- ─── 3. TABLA sorteo_config ───────────────────────────────────

CREATE TABLE IF NOT EXISTS sorteo_config (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id        INT NOT NULL,
  estado            ENUM('Activo','Inactivo','Finalizado') NOT NULL DEFAULT 'Activo',
  numero_sorteo     INT NOT NULL DEFAULT 1,
  fecha_inicio      DATE DEFAULT (CURDATE()),
  fecha_fin         DATE DEFAULT NULL,
  filtro_monto_min  DECIMAL(15,2) DEFAULT NULL,
  filtro_compras_min INT DEFAULT NULL,
  filtro_fecha_inicio DATE DEFAULT NULL,
  filtro_fecha_fin   DATE DEFAULT NULL,
  creado_en         TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
  UNIQUE KEY uk_empresa (empresa_id)
);

-- Si la tabla ya existe y no tiene las nuevas columnas, agregarlas
ALTER TABLE sorteo_config
  ADD COLUMN IF NOT EXISTS filtro_fecha_inicio DATE DEFAULT NULL AFTER filtro_compras_min;

ALTER TABLE sorteo_config
  ADD COLUMN IF NOT EXISTS filtro_fecha_fin DATE DEFAULT NULL AFTER filtro_fecha_inicio;
