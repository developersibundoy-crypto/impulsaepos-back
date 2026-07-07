-- =============================================================
-- MIGRACIÓN: Sistema de Acumulación de Puntos (Fidelización)
-- Archivo : add_puntos_system.sql
-- Proyecto: Redcograf POS
-- Fecha   : 2026-07-01
-- Descripción:
--   Migración SEGURA (idempotente) para agregar el sistema de
--   puntos a una base de datos existente (tienda_db).
--   Usa IF NOT EXISTS / ADD COLUMN IF NOT EXISTS para que pueda
--   ejecutarse varias veces sin errores.
-- =============================================================

USE tienda_db;

-- -------------------------------------------------------------
-- 1. Columna puntos_acumulados en tabla clientes
-- -------------------------------------------------------------
ALTER TABLE clientes
  ADD COLUMN IF NOT EXISTS puntos_acumulados INT DEFAULT 0;

-- -------------------------------------------------------------
-- 2. Columna comision en tabla ventas
-- -------------------------------------------------------------
ALTER TABLE ventas
  ADD COLUMN IF NOT EXISTS comision DECIMAL(15,2) DEFAULT 0;

-- -------------------------------------------------------------
-- 3. Tabla config_fidelizacion
--    Una fila por empresa que configura el programa de puntos.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS config_fidelizacion (
  id                      INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id              INT NOT NULL UNIQUE,
  puntos_por_compra       INT DEFAULT 1,
  puntos_por_compra_mayor INT DEFAULT 50,
  monto_umbral            DECIMAL(15,2) DEFAULT 50000,
  meta_puntos             INT DEFAULT 10,
  descripcion_premio      VARCHAR(255) DEFAULT 'Premio de fidelización',
  activo                  BOOLEAN DEFAULT 0,
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
);

-- -------------------------------------------------------------
-- 4. Tabla historial_puntos
--    Registro de cada transacción que genera o descuenta puntos.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historial_puntos (
  id             INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id     INT NOT NULL,
  cliente_id     INT NOT NULL,
  factura_id     INT NULL,
  factura_tipo   VARCHAR(20) DEFAULT 'POS',
  puntos_ganados INT NOT NULL DEFAULT 0,
  puntos_antes   INT NOT NULL DEFAULT 0,
  puntos_despues INT NOT NULL DEFAULT 0,
  total_venta    DECIMAL(15,2) DEFAULT 0,
  fecha          TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
  FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
);

-- -------------------------------------------------------------
-- 5. Tabla historial_premios
--    Registro de cada canje de puntos por un premio.
-- -------------------------------------------------------------
CREATE TABLE IF NOT EXISTS historial_premios (
  id                 INT AUTO_INCREMENT PRIMARY KEY,
  empresa_id         INT NOT NULL,
  cliente_id         INT NOT NULL,
  puntos_canjeados   INT NOT NULL DEFAULT 0,
  descripcion_premio VARCHAR(255),
  cajero_id          INT NULL,
  fecha              TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
  FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
  FOREIGN KEY (cajero_id)  REFERENCES cajeros(id) ON DELETE SET NULL
);

-- =============================================================
-- FIN DE MIGRACIÓN
-- =============================================================
