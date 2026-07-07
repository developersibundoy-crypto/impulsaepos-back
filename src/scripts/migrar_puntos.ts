import mysql from "mysql2";
import dotenv from "dotenv";

dotenv.config();

const connection = mysql.createConnection({
  host: process.env.DB_HOST || "localhost",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "tienda_db",
  multipleStatements: true
});

const queries = [
  // 1. Agregar columna puntos_acumulados a clientes (idempotente)
  `ALTER TABLE clientes ADD COLUMN puntos_acumulados INT DEFAULT 0 COMMENT 'Puntos acumulados en el programa de fidelizacion'`,

  // 2. Configuración del programa de fidelización por empresa
  `CREATE TABLE IF NOT EXISTS config_fidelizacion (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa_id INT NOT NULL UNIQUE,
    puntos_por_compra INT NOT NULL DEFAULT 1 COMMENT 'Puntos acumulados por cada compra menor a 50000',
    puntos_por_compra_mayor INT NOT NULL DEFAULT 50 COMMENT 'Puntos acumulados cuando la compra es igual o superior a 50000',
    monto_umbral DECIMAL(15,2) NOT NULL DEFAULT 50000.00 COMMENT 'Monto minimo para recibir puntos_por_compra_mayor',
    meta_puntos INT NOT NULL DEFAULT 10 COMMENT 'Puntos necesarios para ganar el premio',
    descripcion_premio VARCHAR(255) NOT NULL DEFAULT 'Premio de fidelizacion',
    activo BOOLEAN NOT NULL DEFAULT 1,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE
  )`,

  // 3. Historial de acumulación de puntos
  `CREATE TABLE IF NOT EXISTS historial_puntos (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa_id INT NOT NULL,
    cliente_id INT NOT NULL,
    factura_id INT NULL COMMENT 'ID de la factura que generó los puntos',
    factura_tipo VARCHAR(20) NOT NULL DEFAULT 'POS' COMMENT 'POS | ELECTRONICA | MAYORISTA',
    puntos_ganados INT NOT NULL DEFAULT 1,
    puntos_antes INT NOT NULL DEFAULT 0,
    puntos_despues INT NOT NULL DEFAULT 0,
    total_venta DECIMAL(15,2) NOT NULL DEFAULT 0,
    fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cliente_empresa (empresa_id, cliente_id),
    INDEX idx_fecha (fecha),
    FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
    FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
  )`,

  // 4. Historial de premios ganados/canjeados
  `CREATE TABLE IF NOT EXISTS historial_premios (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa_id INT NOT NULL,
    cliente_id INT NOT NULL,
    puntos_canjeados INT NOT NULL,
    descripcion_premio VARCHAR(255) NOT NULL DEFAULT 'Premio de fidelizacion',
    cajero_id INT NULL COMMENT 'Cajero que registró el canje',
    fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_cliente_empresa (empresa_id, cliente_id),
    FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
    FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE CASCADE
  )`
];

const runMigration = async () => {
  return new Promise<void>((resolve, reject) => {
    connection.connect((err) => {
      if (err) {
        console.error("❌ Error conectando a MySQL:", err.message);
        reject(err);
        return;
      }
      console.log("✅ Conectado a MySQL. Iniciando migración del sistema de puntos...\n");

      let completed = 0;
      const total = queries.length;

      const labels = [
        "Columna puntos_acumulados en clientes",
        "Tabla config_fidelizacion",
        "Tabla historial_puntos",
        "Tabla historial_premios"
      ];

      const runNext = (index: number) => {
        if (index >= total) {
          console.log("\n🎉 Migración completada exitosamente.");
          console.log("📌 Recuerda ejecutar el seed de config_fidelizacion para la empresa principal si es necesario.");
          connection.end();
          resolve();
          return;
        }

        connection.query(queries[index], (err) => {
          if (err) {
            if (err.code === "ER_DUP_FIELDNAME") {
              console.log(`⚠️  [${labels[index]}] Ya existe — omitiendo.`);
            } else if (err.code === "ER_TABLE_EXISTS_ERROR") {
              console.log(`⚠️  [${labels[index]}] Tabla ya existe — omitiendo.`);
            } else {
              console.error(`❌ [${labels[index]}] Error:`, err.message);
            }
          } else {
            completed++;
            console.log(`✅ [${labels[index]}] Creado/Aplicado correctamente.`);
          }
          runNext(index + 1);
        });
      };

      runNext(0);
    });
  });
};

runMigration().catch((err) => {
  console.error("Error fatal en migración:", err);
  process.exit(1);
});
