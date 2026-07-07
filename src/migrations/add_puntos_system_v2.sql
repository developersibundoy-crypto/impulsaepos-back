-- =============================================================
-- MIGRACIÓN V2: Nueva arquitectura de fidelización (puntos)
-- Basada en margen de utilidad, con lotes, vencimiento y niveles
-- =============================================================
-- Ejecutar en la base de datos activa (tienda_db)
-- Este script es IDEMPOTENTE: se puede ejecutar varias veces
-- =============================================================

-- ─── 1. NUEVAS COLUMNAS EN config_fidelizacion ───────────────

ALTER TABLE config_fidelizacion
  ADD COLUMN IF NOT EXISTS porcentaje_acumulacion DECIMAL(5,2) DEFAULT 2.00 AFTER puntos_por_compra_mayor,
  ADD COLUMN IF NOT EXISTS porcentaje_redencion_max DECIMAL(5,2) DEFAULT 20.00 AFTER porcentaje_acumulacion,
  ADD COLUMN IF NOT EXISTS vigencia_dias INT DEFAULT 90 AFTER porcentaje_redencion_max,
  ADD COLUMN IF NOT EXISTS monto_minimo_acumular DECIMAL(15,2) DEFAULT 0 AFTER vigencia_dias,
  ADD COLUMN IF NOT EXISTS monto_minimo_redimir DECIMAL(15,2) DEFAULT 0 AFTER monto_minimo_acumular,
  ADD COLUMN IF NOT EXISTS valor_punto DECIMAL(10,2) DEFAULT 1.00 AFTER monto_minimo_redimir,
  ADD COLUMN IF NOT EXISTS modo_acumulacion VARCHAR(20) DEFAULT 'porcentaje' AFTER valor_punto,
  ADD COLUMN IF NOT EXISTS puntos_por_cada INT DEFAULT 1 AFTER modo_acumulacion,
  ADD COLUMN IF NOT EXISTS monto_para_cada DECIMAL(15,2) DEFAULT 50 AFTER puntos_por_cada;

-- ─── 2. NUEVAS COLUMNAS EN clientes ──────────────────────────

ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS nivel_cliente_id INT DEFAULT NULL AFTER puntos_acumulados,
  ADD COLUMN IF NOT EXISTS total_puntos_ganados INT DEFAULT 0 AFTER nivel_cliente_id,
  ADD COLUMN IF NOT EXISTS total_puntos_redimidos INT DEFAULT 0 AFTER total_puntos_ganados,
  ADD COLUMN IF NOT EXISTS total_compras INT DEFAULT 0 AFTER total_puntos_redimidos,
  ADD COLUMN IF NOT EXISTS total_gastado DECIMAL(15,2) DEFAULT 0 AFTER total_compras;

-- ─── 3. TABLA niveles_cliente ────────────────────────────────

CREATE TABLE IF NOT EXISTS niveles_cliente (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id              INT NOT NULL,
  nombre                  VARCHAR(100) NOT NULL,
  nivel                   INT NOT NULL DEFAULT 1,
  porcentaje_acumulacion  DECIMAL(5,2) NOT NULL DEFAULT 2.00,
  porcentaje_redencion_max DECIMAL(5,2) NOT NULL DEFAULT 20.00,
  vigencia_dias           INT NOT NULL DEFAULT 90,
  monto_minimo_acumular   DECIMAL(15,2) DEFAULT 0,
  monto_minimo_redimir    DECIMAL(15,2) DEFAULT 0,
  multiplicador_base      DECIMAL(5,2) NOT NULL DEFAULT 1.00,
  activo                  BOOLEAN DEFAULT 1,
  creado_en               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
  UNIQUE KEY uk_empresa_nivel (empresa_id, nivel)
);

-- ─── 4. TABLA campanias_puntos ───────────────────────────────

CREATE TABLE IF NOT EXISTS campanias_puntos (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id              INT NOT NULL,
  nombre                  VARCHAR(200) NOT NULL,
  tipo                    ENUM('multiplicador','puntos_fijos','descuento') NOT NULL DEFAULT 'multiplicador',
  multiplicador           DECIMAL(5,2) NOT NULL DEFAULT 1.00,
  puntos_fijos_por_cada   INT DEFAULT NULL,
  monto_para_puntos_fijos DECIMAL(15,2) DEFAULT NULL,
  nivel_cliente_id        INT DEFAULT NULL,
  producto_id             INT DEFAULT NULL,
  categoria               VARCHAR(100) DEFAULT NULL,
  marca                   VARCHAR(100) DEFAULT NULL,
  fecha_inicio            DATE NOT NULL,
  fecha_fin               DATE NOT NULL,
  activo                  BOOLEAN DEFAULT 1,
  creado_en               TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
  FOREIGN KEY (nivel_cliente_id) REFERENCES niveles_cliente(id) ON DELETE SET NULL,
  FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL,
  INDEX idx_empresa_activo_fechas (empresa_id, activo, fecha_inicio, fecha_fin)
);

-- ─── 5. TABLA lotes_puntos ───────────────────────────────────

CREATE TABLE IF NOT EXISTS lotes_puntos (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id          INT NOT NULL,
  cliente_id          INT NOT NULL,
  factura_id          INT DEFAULT NULL,
  factura_tipo        VARCHAR(20) DEFAULT 'POS',
  puntos_generados    INT NOT NULL DEFAULT 0,
  puntos_disponibles  INT NOT NULL DEFAULT 0,
  fecha_generacion    DATE DEFAULT (CURDATE()),
  fecha_vencimiento   DATE NOT NULL,
  estado              ENUM('ACTIVO','EXPIRADO','CANCELADO') NOT NULL DEFAULT 'ACTIVO',
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
  FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
  INDEX idx_cliente_estado (cliente_id, estado),
  INDEX idx_vencimiento (fecha_vencimiento),
  INDEX idx_empresa_cliente (empresa_id, cliente_id, estado)
);

-- ─── 6. TABLA movimientos_puntos ─────────────────────────────

CREATE TABLE IF NOT EXISTS movimientos_puntos (
  id                INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id        INT NOT NULL,
  cliente_id        INT NOT NULL,
  cliente_nombre    VARCHAR(255) DEFAULT NULL,
  lote_id           INT DEFAULT NULL,
  tipo_movimiento   ENUM('GENERACION','REDENCION','EXPIRACION','AJUSTE','BONIFICACION','CANCELACION','REVERSION') NOT NULL,
  puntos            INT NOT NULL,
  saldo_anterior    INT NOT NULL DEFAULT 0,
  saldo_posterior   INT NOT NULL DEFAULT 0,
  referencia_id     INT DEFAULT NULL,
  referencia_tipo   VARCHAR(50) DEFAULT NULL,
  descripcion       VARCHAR(500) DEFAULT NULL,
  cajero_id         INT DEFAULT NULL,
  fecha             TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
  FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
  FOREIGN KEY (lote_id) REFERENCES lotes_puntos(id) ON DELETE SET NULL,
  FOREIGN KEY (cajero_id) REFERENCES cajeros(id) ON DELETE SET NULL,
  INDEX idx_empresa_cliente (empresa_id, cliente_id),
  INDEX idx_tipo (tipo_movimiento),
  INDEX idx_fecha (fecha)
);

-- ─── 7. TABLA breakage_puntos ────────────────────────────────

CREATE TABLE IF NOT EXISTS breakage_puntos (
  id                  INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id          INT NOT NULL,
  fecha               DATE NOT NULL,
  puntos_emitidos     INT NOT NULL DEFAULT 0,
  puntos_redimidos    INT NOT NULL DEFAULT 0,
  puntos_expirados    INT NOT NULL DEFAULT 0,
  puntos_activos      INT NOT NULL DEFAULT 0,
  porcentaje_redencion DECIMAL(5,2) DEFAULT 0,
  porcentaje_breakage DECIMAL(5,2) DEFAULT 0,
  calculado_en        TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
  UNIQUE KEY uk_empresa_fecha (empresa_id, fecha)
);

-- =============================================================
-- NOTA: Esta migración NO elimina tablas/columnas antiguas
-- (historial_puntos, historial_premios, config_fidelizacion.*)
-- para mantener compatibilidad hacia atrás.
-- =============================================================
