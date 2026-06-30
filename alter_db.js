const mysql = require('mysql2');

const connection = mysql.createConnection({
  host: "localhost",
  user: "root",
  password: "",
  database: "tienda_db"
});

connection.connect((err) => {
  if (err) {
    console.error("Error conectando a MySQL:", err);
    process.exit(1);
  }

  connection.query(
    "ALTER TABLE facturas_compra ADD COLUMN archivo_factura LONGTEXT NULL",
    (err, results) => {
      if (err) {
        if (err.code === 'ER_DUP_FIELDNAME') {
          console.log("La columna archivo_factura ya existe.");
        } else {
          console.error("Error alterando tabla:", err);
        }
      } else {
        console.log("Columna archivo_factura añadida exitosamente.");
      }
      connection.end();
    }
  );
});
