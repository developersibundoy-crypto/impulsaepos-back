'use strict';

const assert = require('node:assert');
const http = require('node:http');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
let ioClient;
try {
  ioClient = require('socket.io-client').io;
} catch {
  ioClient = require('c:/src/Proyectos Oficiales/impulsaepos/impulsaepos-front/node_modules/socket.io-client').io;
}

const JWT_SECRET = process.env.JWT_SECRET || 'JQbriq60gr0Sz100d4u6IPyA9uqOoKF3VKCB55ldVTw=';

function httpRequest(options, postData = null) {
  return new Promise((resolve, reject) => {
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        resolve({ statusCode: res.statusCode, headers: res.headers, body: data });
      });
    });
    req.on('error', reject);
    if (postData) {
      req.write(typeof postData === 'string' ? postData : JSON.stringify(postData));
    }
    req.end();
  });
}

async function testSeguridadAislamiento() {
  console.log('[TEST] Iniciando pruebas de seguridad y aislamiento multi-tenant...');

  const host = process.env.DB_HOST || '127.0.0.1';
  const port = Number(process.env.DB_PORT) || 3307;
  const user = process.env.DB_USER || 'impulsa_dev';
  const password = process.env.DB_PASSWORD || 'u88uAsA7dbPIDDIDoFDVlHHexhb7IfAFHxYFi4gin00=';
  const database = process.env.DB_NAME || 'impulsaepos_dev';

  const pool = mysql.createPool({ host, port, user, password, database });

  let empA = null;
  let empB = null;
  let prodA = null;
  let prodB = null;

  // Arrancar servidor de prueba en puerto efímero usando la app real
  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DB_HOST = host;
  process.env.DB_PORT = String(port);
  process.env.DB_USER = user;
  process.env.DB_PASSWORD = password;
  process.env.DB_NAME = database;

  // Importar server compilado
  // Nota: dist/server.js arranca en process.env.PORT
  const TEST_PORT = 49152 + Math.floor(Math.random() * 5000);
  process.env.PORT = String(TEST_PORT);

  // Requerir server.js
  require('../../dist/server.js');
  await new Promise(r => setTimeout(r, 1500)); // Esperar inicialización de express y socket.io

  try {
    // 1. Crear Empresas A y B
    const [resA] = await pool.query("INSERT INTO empresas_suscritas (nombre_comercial, nit, fecha_vencimiento_suscripcion, estado) VALUES ('Empresa Alfa', 'NIT_ALFA_111', '2027-01-01', 'Active')");
    empA = resA.insertId;

    const [resB] = await pool.query("INSERT INTO empresas_suscritas (nombre_comercial, nit, fecha_vencimiento_suscripcion, estado) VALUES ('Empresa Beta', 'NIT_BETA_222', '2027-01-01', 'Active')");
    empB = resB.insertId;

    // Crear producto para A y para B
    const [pA] = await pool.query("INSERT INTO productos (empresa_id, nombre, categoria, precio_compra, precio_venta) VALUES (?, 'Producto Alfa Exclusivo', 'CatA', 10, 20)", [empA]);
    prodA = pA.insertId;

    const [pB] = await pool.query("INSERT INTO productos (empresa_id, nombre, categoria, precio_compra, precio_venta) VALUES (?, 'Producto Beta Secreto', 'CatB', 50, 100)", [empB]);
    prodB = pB.insertId;

    // Tokens JWT para usuarios de cada empresa
    const tokenA = jwt.sign({ id: 101, username: 'admin_alfa', empresa_id: empA, role: 'admin', permisos: 'all' }, JWT_SECRET, { expiresIn: '1h' });
    const tokenB = jwt.sign({ id: 102, username: 'admin_beta', empresa_id: empB, role: 'admin', permisos: 'all' }, JWT_SECRET, { expiresIn: '1h' });

    // 2. PRUEBA AISLAMIENTO BACKUP:
    // 2.1 Backup sin token -> debe ser rechazado (403)
    const sinToken = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/backup/download',
      method: 'GET'
    });
    assert.strictEqual(sinToken.statusCode, 403, 'Petición sin token a /backup/download debe retornar 403');

    // 2.2 Backup con token Empresa A -> Solo debe contener productos de Empresa A, NUNCA los de B
    const backupA = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/backup/download',
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(backupA.statusCode, 200, 'Backup con token legítimo debe responder 200');
    const jsonA = JSON.parse(backupA.body);
    assert.strictEqual(jsonA.empresa_id, empA, 'El respaldo debe etiquetar la empresa correcta');
    const prodsInBackupA = jsonA.datos.productos || [];
    assert.ok(prodsInBackupA.some(p => p.id === prodA), 'El backup debe contener los productos de la empresa A');
    assert.ok(!prodsInBackupA.some(p => p.id === prodB), 'SEGURIDAD: El backup de A NO debe contener los productos de B');

    // 3. PRUEBA SEGURIDAD SOCKET.IO:
    const serverUrl = `http://127.0.0.1:${TEST_PORT}`;

    // 3.1 Conexión sin token -> debe ser rechazada por el handshake
    const socketSinAuth = ioClient(serverUrl, {
      autoConnect: true,
      reconnection: false,
      auth: {}
    });

    const errorRechazo = await new Promise((resolve) => {
      socketSinAuth.on('connect_error', (err) => resolve(err.message));
      socketSinAuth.on('connect', () => resolve('conectado_inadecuadamente'));
    });
    socketSinAuth.disconnect();
    assert.strictEqual(errorRechazo, 'No autorizado', 'Socket sin token debe ser rechazado');

    // 3.2 Conexión con token de Empresa A -> Aceptada
    const socketA = ioClient(serverUrl, {
      autoConnect: true,
      reconnection: false,
      auth: { token: tokenA }
    });

    const conectado = await new Promise((resolve) => {
      socketA.on('connect', () => resolve(true));
      socketA.on('connect_error', () => resolve(false));
    });
    socketA.disconnect();
    assert.strictEqual(conectado, true, 'Socket con token válido debe conectar exitosamente');

    console.log('✅ [TEST] Seguridad y Aislamiento Multi-Tenant: Todas las pruebas pasaron satisfactoriamente.');
  } finally {
    // Limpieza
    if (empA) {
      await pool.query('DELETE FROM productos WHERE empresa_id = ?', [empA]);
      await pool.query('DELETE FROM empresas_suscritas WHERE id = ?', [empA]);
    }
    if (empB) {
      await pool.query('DELETE FROM productos WHERE empresa_id = ?', [empB]);
      await pool.query('DELETE FROM empresas_suscritas WHERE id = ?', [empB]);
    }
    await pool.end();
    process.exit(0);
  }
}

testSeguridadAislamiento().catch(err => {
  console.error('❌ [TEST] Error en Seguridad y Aislamiento:', err);
  process.exit(1);
});
