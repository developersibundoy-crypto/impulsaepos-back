import './config/loadEnv';
import mysql from "mysql2";

const pool = mysql.createPool({
  host: process.env.DB_HOST || "127.0.0.1",
  user: process.env.DB_USER || "root",
  password: process.env.DB_PASSWORD || "",
  database: process.env.DB_NAME || "tienda_db",
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  timezone: "-05:00",
  dateStrings: true, // Evita que el driver desplace las fechas al convertirlas a objetos Date
  enableKeepAlive: true,
  keepAliveInitialDelay: 10000,
  connectTimeout: 20000
});

// Forzar zona horaria de la sesión en cada nueva conexión
pool.on('connection', (connection: any) => {
  connection.query("SET time_zone = '-05:00';", (err: any) => {
    if (err) console.error("Error setting time_zone:", err);
  });
});

// Test connection
pool.getConnection((err, connection) => {
  if (err) {
    if (err.code === 'PROTOCOL_CONNECTION_LOST') {
      console.error('Database connection was closed.');
    }
    if (err.code === 'ER_CON_COUNT_ERROR') {
      console.error('Database has too many connections.');
    }
    if (err.code === 'ECONNREFUSED') {
      console.error('Database connection was refused.');
    }
  } else {
    console.log("Conectado exitosamente al Pool de MySQL");
  }

  if (connection) connection.release();
});

export default pool;
