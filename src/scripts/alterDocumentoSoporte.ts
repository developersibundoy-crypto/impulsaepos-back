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
  ALTER TABLE documentos_soporte ADD COLUMN archivo_adjunto LONGTEXT NULL;
  `;
  connection.query(q, (err) => {
    if (err) {
        if(err.code === 'ER_DUP_FIELDNAME') {
            console.log("✅ La columna archivo_adjunto ya existe.");
        } else {
            console.error("Error alterando tabla:", err.message);
        }
    } else {
        console.log("✅ Columna archivo_adjunto agregada exitosamente.");
    }
    connection.end();
    process.exit(0);
  });
});
