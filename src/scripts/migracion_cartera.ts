import mysql from "mysql2";
import dotenv from "dotenv";
dotenv.config();

const connection = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "tienda_db",
  multipleStatements: true
});

connection.connect((err: any) => {
  if (err) {
    console.error("Error conectando a MySQL:", err);
    process.exit(1);
  }

  const queries = [
    `CREATE TABLE IF NOT EXISTS cuentas_por_cobrar (
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
    `CREATE TABLE IF NOT EXISTS abonos_cxc (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empresa_id INT NOT NULL,
      cxc_id INT NOT NULL,
      monto DECIMAL(15,2) NOT NULL,
      metodo_pago VARCHAR(50) NOT NULL,
      fecha_pago TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
      FOREIGN KEY (cxc_id) REFERENCES cuentas_por_cobrar(id) ON DELETE CASCADE
    )`,
    `CREATE TABLE IF NOT EXISTS cuentas_por_pagar (
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
    `CREATE TABLE IF NOT EXISTS abonos_cxp (
      id INT AUTO_INCREMENT PRIMARY KEY,
      empresa_id INT NOT NULL,
      cxp_id INT NOT NULL,
      monto DECIMAL(15,2) NOT NULL,
      metodo_pago VARCHAR(50) NOT NULL,
      fecha_pago TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (empresa_id) REFERENCES empresas_suscritas(id) ON DELETE CASCADE,
      FOREIGN KEY (cxp_id) REFERENCES cuentas_por_pagar(id) ON DELETE CASCADE
    )`
  ];

  const runSync = async () => {
    for (const q of queries) {
      try {
        await connection.promise().query(q);
        console.log("Migración ejecutada con éxito para una tabla.");
      } catch (e: any) {
        console.error("Error en query:", e.message);
      }
    }
    console.log("✅ Tablas de Cartera inyectadas en tienda_db.");
    connection.end();
  };

  runSync();
});
