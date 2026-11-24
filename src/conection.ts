import 'dotenv/config';
import mysql from "mysql2";

const staging = process.env.DB_PROFILE === 'staging';
const prefix = staging ? 'STAGING_DB_' : 'DB_';
const valor = (campo: string) => process.env[prefix + campo];
if (staging && (valor('NAME') !== 'u311745467_STAGING_DB' ||
    ['HOST','PORT','USER','PASSWORD'].some(c => !valor(c)))) {
  throw new Error('[BD] Perfil staging incompleto o base distinta de u311745467_STAGING_DB.');
}
const host = valor('HOST') || "127.0.0.1";
const database = valor('NAME') || "tienda_db";
const port = Number(valor('PORT') || 3306);
console.info(`[BD] perfil=${staging ? 'staging' : 'DB_*'} destino=${host}:${port}/${database}`);
const pool = mysql.createPool({
  host, database, port,
  user: valor('USER') || "root",
  password: valor('PASSWORD') || "",
  ...(staging ? {ssl:{rejectUnauthorized:true,verifyIdentity:true}} : {}),
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
    console.error(`[BD] conexión fallida: ${err.code || 'ERROR_DB'} (${host}:${port}/${database})`);
  } else {
    console.log("Conectado exitosamente al Pool de MySQL");
  }

  if (connection) connection.release();
});

export default pool;
