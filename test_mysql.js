const mysql = require('mysql2');
const pool = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: '',
  database: 'tienda_db',
  port: 3306,
  connectTimeout: 5000
});

pool.getConnection((err, conn) => {
  if (err) {
    console.error("Localhost error:", err.message);
  } else {
    console.log("Localhost connected!");
    conn.release();
  }
  
  const pool2 = mysql.createPool({
    host: '127.0.0.1',
    user: 'root',
    password: '',
    database: 'tienda_db',
    port: 3306,
    connectTimeout: 5000
  });
  
  pool2.getConnection((err2, conn2) => {
    if (err2) {
      console.error("127.0.0.1 error:", err2.message);
    } else {
      console.log("127.0.0.1 connected!");
      conn2.release();
    }
    process.exit(0);
  });
});
