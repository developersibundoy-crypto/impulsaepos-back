import mysql from "mysql2";

const connection = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "tienda_db",
  multipleStatements: true
});

connection.connect((err) => {
  if (err) {
    console.error("Error conectando a MySQL:", err);
    process.exit(1);
  }
  
  const q = `
  CREATE TABLE IF NOT EXISTS documentos_soporte (
    id INT AUTO_INCREMENT PRIMARY KEY,
    empresa_id INT NOT NULL,
    proveedor_nombre VARCHAR(255) NOT NULL,
    proveedor_documento VARCHAR(50),
    prefijo VARCHAR(10) DEFAULT 'DS',
    numero_documento INT NOT NULL,
    datos_json LONGTEXT,
    subtotal DECIMAL(15,2) DEFAULT 0,
    impuestos DECIMAL(15,2) DEFAULT 0,
    total DECIMAL(15,2) DEFAULT 0,
    estado VARCHAR(50) DEFAULT 'Emitido',
    cajero_id INT NULL,
    fecha TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
    FOREIGN KEY (cajero_id) REFERENCES cajeros(id) ON DELETE SET NULL,
    UNIQUE KEY uq_empresa_numero (empresa_id, numero_documento)
  );
  `;
  connection.query(q, (err) => {
    if (err) {
        console.error("Error creando tabla:", err.message);
    } else {
        console.log("✅ Tabla documentos_soporte creada o verificada exitosamente.");
    }
    connection.end();
    process.exit(0);
  });
});
