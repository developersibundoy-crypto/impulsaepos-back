'use strict';

const assert = require('node:assert');
const http = require('node:http');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');

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

async function testTiendaAdmin() {
  console.log('[TEST] Iniciando pruebas de endpoints de administración de tienda (Etapa 3)...');

  const host = process.env.DB_HOST || '127.0.0.1';
  const port = Number(process.env.DB_PORT) || 3307;
  const user = process.env.DB_USER || 'impulsa_dev';
  const password = process.env.DB_PASSWORD || 'u88uAsA7dbPIDDIDoFDVlHHexhb7IfAFHxYFi4gin00=';
  const database = process.env.DB_NAME || 'impulsaepos_dev';

  const pool = mysql.createPool({ host, port, user, password, database });

  let empA = null;
  let prodA = null;

  process.env.JWT_SECRET = JWT_SECRET;
  process.env.DB_HOST = host;
  process.env.DB_PORT = String(port);
  process.env.DB_USER = user;
  process.env.DB_PASSWORD = password;
  process.env.DB_NAME = database;

  const TEST_PORT = 49152 + Math.floor(Math.random() * 5000);
  process.env.PORT = String(TEST_PORT);

  require('../../dist/server.js');
  await new Promise(r => setTimeout(r, 1500));

  try {
    // 1. Crear Empresa sintética
    const [resEmp] = await pool.query("INSERT INTO empresas_suscritas (nombre_comercial, nit, fecha_vencimiento_suscripcion, estado) VALUES ('Ferreteria Test Alfa', 'NIT_FERR_123', '2027-01-01', 'Active')");
    empA = resEmp.insertId;

    const [resProd] = await pool.query("INSERT INTO productos (empresa_id, nombre, categoria, precio_compra, precio_venta, cantidad) VALUES (?, 'Martillo Profesional', 'Herramientas', 20000, 35000, 10)", [empA]);
    prodA = resProd.insertId;

    const tokenA = jwt.sign({ id: 99, username: 'admin_ferr', empresa_id: empA, role: 'admin', permisos: 'all' }, JWT_SECRET, { expiresIn: '1h' });

    // 2. GET /tienda-admin/mi-tienda (debe crear borrador automático inicial)
    const getTienda = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/tienda-admin/mi-tienda',
      method: 'GET',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(getTienda.statusCode, 200);
    const dataTienda = JSON.parse(getTienda.body);
    assert.ok(dataTienda.tienda, 'Debe devolver el objeto tienda');
    assert.strictEqual(dataTienda.tienda.estado, 'borrador');
    assert.strictEqual(dataTienda.vigente, false, 'No debe estar vigente antes de contratar o activar prueba');

    // 3. PUT /tienda-admin/mi-tienda con slug reservado -> Debe ser rechazado (400)
    const updateSlugReservado = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/tienda-admin/mi-tienda',
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' }
    }, {
      nombre: 'Ferreteria Alfa',
      slug: 'admin', // Slug reservado
      descripcion: 'Venta de herramientas'
    });
    assert.strictEqual(updateSlugReservado.statusCode, 400, 'Debe rechazar un slug reservado');

    // 4. PUT /tienda-admin/mi-tienda con slug válido y tildes -> Debe normalizar y guardar
    const updateSlugValido = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/tienda-admin/mi-tienda',
      method: 'PUT',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' }
    }, {
      nombre: 'Ferretería El Tornillo',
      slug: 'ferreteria-el-tornillo-bogota',
      telefono_contacto: '3001234567'
    });
    assert.strictEqual(updateSlugValido.statusCode, 200);
    const dataSlug = JSON.parse(updateSlugValido.body);
    assert.strictEqual(dataSlug.slug, 'ferreteria-el-tornillo-bogota');

    // 5. Intentar publicar sin prueba ni productos -> Debe fallar (403 o 400)
    const publicarSinRequisitos = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/tienda-admin/mi-tienda/estado',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' }
    }, { nuevo_estado: 'publicada' });
    assert.strictEqual(publicarSinRequisitos.statusCode, 403, 'No se puede publicar sin contratación/prueba');

    // 6. Activar 14 días de prueba gratuita
    const activarPrueba = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/tienda-admin/mi-tienda/activar-prueba',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(activarPrueba.statusCode, 200, 'La activación de prueba debe ser exitosa');

    // 6.1 Intentar activar prueba por segunda vez -> Debe ser rechazado (409)
    const activarPruebaDoble = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/tienda-admin/mi-tienda/activar-prueba',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}` }
    });
    assert.strictEqual(activarPruebaDoble.statusCode, 409, 'No debe permitir doble prueba gratuita');

    // 7. Toggle producto para publicarlo en la tienda
    const togglePub = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/tienda-admin/publicaciones/toggle',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' }
    }, { producto_id: prodA, publicar: true });
    assert.strictEqual(togglePub.statusCode, 200);

    // 8. Publicar tienda ahora que cumple los requisitos
    const publicarExitosa = await httpRequest({
      hostname: '127.0.0.1',
      port: TEST_PORT,
      path: '/tienda-admin/mi-tienda/estado',
      method: 'POST',
      headers: { Authorization: `Bearer ${tokenA}`, 'Content-Type': 'application/json' }
    }, { nuevo_estado: 'publicada' });
    assert.strictEqual(publicarExitosa.statusCode, 200, 'Debe permitir publicar con prueba y producto');

    console.log('✅ [TEST] TiendaAdmin: Todas las validaciones de administración de tienda pasaron exitosamente.');
  } finally {
    if (empA) {
      await pool.query('DELETE FROM tienda_auditoria WHERE empresa_id = ?', [empA]);
      await pool.query('DELETE FROM tienda_publicaciones WHERE empresa_id = ?', [empA]);
      await pool.query('DELETE FROM tienda_contrataciones WHERE empresa_id = ?', [empA]);
      await pool.query('DELETE FROM tiendas WHERE empresa_id = ?', [empA]);
      await pool.query('DELETE FROM productos WHERE empresa_id = ?', [empA]);
      await pool.query('DELETE FROM empresas_suscritas WHERE id = ?', [empA]);
    }
    await pool.end();
    process.exit(0);
  }
}

testTiendaAdmin().catch(err => {
  console.error('❌ [TEST] Error en TiendaAdmin:', err);
  process.exit(1);
});
