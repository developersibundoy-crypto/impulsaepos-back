import mysql from "mysql2";

const connection = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  multipleStatements: true
});

connection.connect((err: any) => {
  if (err) {
    console.error("Error conectando a MySQL:", err);
    process.exit(1);
  }
  
  connection.query("CREATE DATABASE IF NOT EXISTS tienda_db", (err: any) => {
    if (err) throw err;
    connection.query("USE tienda_db", (err: any) => {
      if (err) throw err;
      
      const setupQueries = [
        "SET FOREIGN_KEY_CHECKS = 0",
        "DROP TABLE IF EXISTS historial_premios",
        "DROP TABLE IF EXISTS historial_puntos",
        "DROP TABLE IF EXISTS config_fidelizacion",
        "DROP TABLE IF EXISTS kardex",
        "DROP TABLE IF EXISTS empresa_config",
        "DROP TABLE IF EXISTS pagos_suscripcion",
        "DROP TABLE IF EXISTS usuarios_plataforma",
        "DROP TABLE IF EXISTS pagos_empleados",
        "DROP TABLE IF EXISTS ventas",
        "DROP TABLE IF EXISTS abonos_separados",
        "DROP TABLE IF EXISTS separados",
        "DROP TABLE IF EXISTS abonos_cxp",
        "DROP TABLE IF EXISTS cuentas_por_pagar",
        "DROP TABLE IF EXISTS abonos_cxc",
        "DROP TABLE IF EXISTS cuentas_por_cobrar",
        "DROP TABLE IF EXISTS cambios_factura",
        "DROP TABLE IF EXISTS facturas_venta",
        "DROP TABLE IF EXISTS facturas_borrador",
        "DROP TABLE IF EXISTS facturas_compra",
        "DROP TABLE IF EXISTS documentos_soporte",
        "DROP TABLE IF EXISTS productos",
        "DROP TABLE IF EXISTS cajeros",
        "DROP TABLE IF EXISTS clientes",
        "DROP TABLE IF EXISTS proveedores",
        "DROP TABLE IF EXISTS empresas_suscritas",
        "DROP TABLE IF EXISTS plataforma_config",
        "SET FOREIGN_KEY_CHECKS = 1",
        `CREATE TABLE empresas_suscritas (
          id INT AUTO_INCREMENT PRIMARY KEY,
          nombre_comercial VARCHAR(255) NOT NULL,
          nit VARCHAR(100) UNIQUE DEFAULT '',
          correo_contacto VARCHAR(100),
          telefono_contacto VARCHAR(50),
          fecha_registro TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          fecha_vencimiento_suscripcion DATE NOT NULL,
          estado VARCHAR(50) DEFAULT 'Trial',
          wompi_subscription_id VARCHAR(255) NULL
        )`,
        `CREATE TABLE usuarios_plataforma (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          username VARCHAR(100) NOT NULL UNIQUE,
          password_hash VARCHAR(255) NOT NULL,
          role VARCHAR(50) DEFAULT 'dueño',
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE empresa_config (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL UNIQUE,
          nombre_empresa VARCHAR(255) NOT NULL,
          nit VARCHAR(100) DEFAULT '',
          direccion VARCHAR(255) DEFAULT '',
          correo VARCHAR(100) DEFAULT '',
          telefono VARCHAR(100) DEFAULT '',
          resolucion TEXT,
          representante_legal VARCHAR(255) DEFAULT '',
          logo LONGTEXT NULL,
          permitir_venta_negativa BOOLEAN DEFAULT 1,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE pagos_suscripcion (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          wompi_transaction_id VARCHAR(255) NOT NULL,
          monto DECIMAL(15,2) NOT NULL,
          fecha_pago TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          metodo_pago VARCHAR(100) DEFAULT 'Wompi',
          dias_agregados INT DEFAULT 30,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE proveedores (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          nombre VARCHAR(255) NOT NULL,
          nit VARCHAR(100) DEFAULT '',
          contacto VARCHAR(100),
          direccion VARCHAR(255),
          telefono VARCHAR(50),
          email VARCHAR(100),
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE productos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          referencia VARCHAR(100) DEFAULT '',
          nombre VARCHAR(255) NOT NULL,
          categoria VARCHAR(100) NOT NULL,
          cantidad INT NOT NULL DEFAULT 0,
          cantidad_reservada INT NOT NULL DEFAULT 0,
          precio_compra DECIMAL(15,2) NOT NULL,
          porcentaje_ganancia DECIMAL(5,2) NOT NULL DEFAULT 40,
          precio_venta DECIMAL(15,2) NOT NULL,
          es_servicio BOOLEAN DEFAULT 0,
          permitir_venta_negativa BOOLEAN DEFAULT 1,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE cajeros (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          nombre VARCHAR(255) NOT NULL,
          documento VARCHAR(50),
          telefono VARCHAR(50),
          direccion VARCHAR(255),
          fecha_contrato DATE DEFAULT NULL,
          salario DECIMAL(15,2) DEFAULT 0,
          paga_comisiones BOOLEAN DEFAULT 0,
          porcentaje_comision_base DECIMAL(5,2) DEFAULT 0,
          meta_comision DECIMAL(15,2) DEFAULT 0,
          porcentaje_comision_meta DECIMAL(5,2) DEFAULT 0,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE clientes (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          nombre VARCHAR(255) NOT NULL,
          documento VARCHAR(50),
          telefono VARCHAR(50),
          correo VARCHAR(100),
          direccion VARCHAR(255),
          puntos_acumulados INT DEFAULT 0,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE config_fidelizacion (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL UNIQUE,
          puntos_por_compra INT DEFAULT 1,
          puntos_por_compra_mayor INT DEFAULT 50,
          monto_umbral DECIMAL(15,2) DEFAULT 50000,
          meta_puntos INT DEFAULT 10,
          descripcion_premio VARCHAR(255) DEFAULT 'Premio de fidelización',
          activo BOOLEAN DEFAULT 0,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE historial_puntos (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          cliente_id INT NOT NULL,
          factura_id INT NULL,
          factura_tipo VARCHAR(20) DEFAULT 'POS',
          puntos_ganados INT NOT NULL DEFAULT 0,
          puntos_antes INT NOT NULL DEFAULT 0,
          puntos_despues INT NOT NULL DEFAULT 0,
          total_venta DECIMAL(15,2) DEFAULT 0,
          fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE historial_premios (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          cliente_id INT NOT NULL,
          puntos_canjeados INT NOT NULL DEFAULT 0,
          descripcion_premio VARCHAR(255),
          cajero_id INT NULL,
          fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
          FOREIGN KEY (cajero_id) REFERENCES cajeros(id) ON DELETE SET NULL
        )`,
        `CREATE TABLE facturas_venta (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          cajero_id INT NULL,
          cliente_id INT NULL,
          total DECIMAL(15,2) NOT NULL,
          metodo_pago VARCHAR(50) NOT NULL,
          pago_efectivo DECIMAL(15,2) DEFAULT 0,
          pago_transferencia DECIMAL(15,2) DEFAULT 0,
          fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (cajero_id) REFERENCES cajeros(id) ON DELETE SET NULL,
          FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL
        )`,
        `CREATE TABLE ventas (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          factura_id INT NOT NULL,
          producto_id INT,
          cantidad INT NOT NULL,
          precio_unitario DECIMAL(15,2) NOT NULL,
          costo_unitario DECIMAL(15,2) DEFAULT 0,
          comision DECIMAL(15,2) DEFAULT 0,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (factura_id) REFERENCES facturas_venta(id) ON DELETE CASCADE,
          FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL
        )`,
        `CREATE TABLE cambios_factura (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          factura_original_id INT NOT NULL,
          cajero_id INT,
          producto_devuelto_id INT NOT NULL,
          producto_nuevo_id INT NOT NULL,
          cantidad_devuelta INT NOT NULL,
          cantidad_nueva INT NOT NULL,
          valor_original DECIMAL(15,2) NOT NULL,
          valor_nuevo DECIMAL(15,2) NOT NULL,
          saldo_adicional DECIMAL(15,2) NOT NULL,
          metodo_pago VARCHAR(50) NOT NULL,
          fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (factura_original_id) REFERENCES facturas_venta(id) ON DELETE CASCADE,
          FOREIGN KEY (producto_devuelto_id) REFERENCES productos(id) ON DELETE CASCADE,
          FOREIGN KEY (producto_nuevo_id) REFERENCES productos(id) ON DELETE CASCADE,
          FOREIGN KEY (cajero_id) REFERENCES cajeros(id) ON DELETE SET NULL
        )`,
        `CREATE TABLE facturas_borrador (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          proveedor VARCHAR(255),
          numero_factura VARCHAR(100),
          datos_json LONGTEXT,
          fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE facturas_compra (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          proveedor VARCHAR(255),
          numero_factura VARCHAR(100),
          total DECIMAL(15,2),
          datos_json LONGTEXT,
          fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE documentos_soporte (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          proveedor_nombre VARCHAR(255) NOT NULL,
          proveedor_documento VARCHAR(50),
          prefijo VARCHAR(10) DEFAULT 'DS',
          numero_documento INT NOT NULL,
          datos_json LONGTEXT,
          archivo_adjunto LONGTEXT NULL,
          subtotal DECIMAL(15,2) DEFAULT 0,
          impuestos DECIMAL(15,2) DEFAULT 0,
          total DECIMAL(15,2) DEFAULT 0,
          estado VARCHAR(50) DEFAULT 'Emitido',
          cajero_id INT NULL,
          fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (cajero_id) REFERENCES cajeros(id) ON DELETE SET NULL,
          UNIQUE KEY uq_empresa_numero (empresa_id, numero_documento)
        )`,
        `CREATE TABLE separados (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          cliente_id INT NOT NULL,
          producto_id INT NOT NULL,
          cantidad INT NOT NULL,
          total DECIMAL(15,2) NOT NULL,
          abono_inicial DECIMAL(15,2) DEFAULT 0,
          saldo_pendiente DECIMAL(15,2) NOT NULL,
          estado VARCHAR(50) DEFAULT 'Pendiente',
          fecha_inicio TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          fecha_vencimiento DATE,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE,
          FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE abonos_separados (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          separado_id INT NOT NULL,
          monto DECIMAL(15,2) NOT NULL,
          fecha_pago TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (separado_id) REFERENCES separados(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE kardex (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          producto_id INT,
          tipo_movimiento VARCHAR(50) NOT NULL,
          cantidad_antes INT DEFAULT 0,
          cantidad_modificada INT DEFAULT 0,
          cantidad_despues INT DEFAULT 0,
          motivo VARCHAR(255),
          usuario_nombre VARCHAR(100),
          fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          referencia VARCHAR(100),
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL
        )`,
        `CREATE TABLE pagos_empleados (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          cajero_id INT NOT NULL,
          mes INT NOT NULL,
          anio INT NOT NULL,
          salario_base DECIMAL(15,2) NOT NULL,
          comisiones DECIMAL(15,2) DEFAULT 0,
          total_pagado DECIMAL(15,2) NOT NULL,
          fecha_pago TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          metodo_pago VARCHAR(100) DEFAULT 'Efectivo',
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (cajero_id) REFERENCES cajeros(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE cuentas_por_cobrar (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          factura_venta_id INT NULL,
          cliente_id INT NOT NULL,
          monto_total DECIMAL(15,2) NOT NULL,
          saldo_pendiente DECIMAL(15,2) NOT NULL,
          estado VARCHAR(50) DEFAULT 'Pendiente',
          fecha_vencimiento DATE NULL,
          fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (factura_venta_id) REFERENCES facturas_venta(id) ON DELETE SET NULL,
          FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE abonos_cxc (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          cxc_id INT NOT NULL,
          monto DECIMAL(15,2) NOT NULL,
          metodo_pago VARCHAR(50) NOT NULL,
          fecha_pago TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (cxc_id) REFERENCES cuentas_por_cobrar(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE cuentas_por_pagar (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          factura_compra_id INT NULL,
          proveedor VARCHAR(255) NOT NULL,
          numero_factura VARCHAR(100) NULL,
          monto_total DECIMAL(15,2) NOT NULL,
          saldo_pendiente DECIMAL(15,2) NOT NULL,
          estado VARCHAR(50) DEFAULT 'Pendiente',
          fecha_vencimiento DATE NULL,
          fecha_creacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (factura_compra_id) REFERENCES facturas_compra(id) ON DELETE SET NULL
        )`,
        `CREATE TABLE abonos_cxp (
          id INT AUTO_INCREMENT PRIMARY KEY,
          empresa_id INT NOT NULL,
          cxp_id INT NOT NULL,
          monto DECIMAL(15,2) NOT NULL,
          metodo_pago VARCHAR(50) NOT NULL,
          fecha_pago TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
          FOREIGN KEY (cxp_id) REFERENCES cuentas_por_pagar(id) ON DELETE CASCADE
        )`,
        `CREATE TABLE plataforma_config (
          id INT PRIMARY KEY,
          wompi_public_key VARCHAR(255) DEFAULT '',
          wompi_private_key VARCHAR(255) DEFAULT '',
          wompi_integrity_secret VARCHAR(255) DEFAULT '',
          wompi_event_secret VARCHAR(255) DEFAULT '',
          precio_mes_centavos BIGINT DEFAULT 7000000,
          precio_semestre_centavos BIGINT DEFAULT 37800000,
          precio_anio_centavos BIGINT DEFAULT 67200000
        )`,
        "INSERT INTO plataforma_config (id) VALUES (1)",
        "INSERT INTO empresas_suscritas (id, nombre_comercial, fecha_vencimiento_suscripcion, estado) VALUES (1, 'PAPELERIA REDCOGRAF', '2030-12-31', 'Active')",
        "INSERT INTO empresa_config (empresa_id, nombre_empresa) VALUES (1, 'PAPELERIA REDCOGRAF')",
        "INSERT INTO usuarios_plataforma (empresa_id, username, password_hash, role) VALUES (1, 'redcograf', '$2b$10$Srhb7e3.J9LRn24/QPx0CuyLqJhQ.zR.utVqd7af2F2SBoejy3ruy', 'superadmin')"
      ];

      const runSync = async () => {
        for (const q of setupQueries) {
          try {
            await connection.promise().query(q);
          } catch (e: any) {
            console.error("Error en query:", q);
            console.error(e.message);
          }
        }
        console.log("✅ Base de datos reconstruida con acceso SuperAdmin.");
        connection.end();
      };
      
      runSync();
    });
  });
});
