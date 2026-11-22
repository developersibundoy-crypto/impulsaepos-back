'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const pool = require('../../dist/conection.js').default;
const tiendaPublica = require('../../dist/routes/tiendaPublica.js').default;
const tiendaAdmin = require('../../dist/routes/tiendaAdmin.js').default;
const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'secret';

function request(server, path, options = {}) {
  const { method = 'GET', headers = {}, body = null } = options;
  const url = new URL(path, `http://127.0.0.1:${server.address().port}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      { method, headers: { 'Content-Type': 'application/json', ...headers } },
      (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => {
          let json = null;
          try {
            json = JSON.parse(raw);
          } catch {}
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
        });
      }
    );
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function run() {
  console.log('[TEST] Iniciando pruebas integrales de Catálogo Público y Pedidos (Etapas 4 y 5)...');
  const db = pool.promise();

  // Configurar servidor Express de prueba
  const app = express();
  app.use(express.json());

  // Simular socket.io básico
  let eventosSocket = [];
  const mockIo = {
    to: (sala) => ({
      emit: (evento, payload) => {
        eventosSocket.push({ sala, evento, payload });
      }
    })
  };
  app.set('io', mockIo);

  app.use('/tienda-publica', tiendaPublica);
  app.use('/tienda-admin', tiendaAdmin);

  const server = http.createServer(app);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));

  const cleanupFns = [];

  try {
    // 1. Crear empresa de prueba
    const [resEmp] = await db.query(
      "INSERT INTO empresas_suscritas (nombre_comercial, nit, fecha_vencimiento_suscripcion, estado) VALUES ('Tienda Test Corp', 'NIT-PUB-99', '2027-01-01', 'Active')"
    );
    const empresaId = resEmp.insertId;

    // Tokens JWT para pruebas de administración
    const tokenAdmin = jwt.sign({ id: 9999, empresa_id: empresaId, rol: 'admin' }, JWT_SECRET, { expiresIn: '1h' });
    const authHeaders = { Authorization: `Bearer ${tokenAdmin}` };

    const testSlug = `test-pub-${Date.now().toString(36)}`;

    // 2. Crear tienda de prueba y productos
    const [resTienda] = await db.query(
      `INSERT INTO tiendas (empresa_id, slug, nombre, descripcion, color_primario, estado)
       VALUES (?, ?, 'Tienda de Prueba Pública', 'Descripción de prueba', '#10b981', 'borrador')
       ON DUPLICATE KEY UPDATE slug = VALUES(slug), estado = 'borrador'`,
      [empresaId, testSlug]
    );

    const [tiendasRows] = await db.query('SELECT id FROM tiendas WHERE slug = ?', [testSlug]);
    const tiendaId = tiendasRows[0].id;

    // Asegurar producto de prueba con stock conocido
    const [prodRes] = await db.query(
      `INSERT INTO productos (empresa_id, referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta)
       VALUES (?, 'REF-TEST-PUB', 'Camiseta Algodón Orgánico', 'Ropa', 10, '15000.00', '50.00', '30000.00')`,
      [empresaId]
    );
    const productoId = prodRes.insertId;

    cleanupFns.push(async () => {
      await db.query('DELETE FROM tienda_auditoria WHERE empresa_id = ?', [empresaId]);
      await db.query('DELETE FROM tienda_reservas WHERE empresa_id = ?', [empresaId]);
      await db.query('DELETE FROM tienda_pedido_items WHERE producto_id = ?', [productoId]);
      await db.query('DELETE FROM tienda_pedidos WHERE tienda_id = ?', [tiendaId]);
      await db.query('DELETE FROM tienda_publicaciones WHERE tienda_id = ?', [tiendaId]);
      await db.query('DELETE FROM productos WHERE id = ?', [productoId]);
      await db.query('DELETE FROM tienda_contrataciones WHERE empresa_id = ? AND referencia = ?', [empresaId, 'REF-TEST-VIG']);
      await db.query('DELETE FROM tiendas WHERE id = ?', [tiendaId]);
      await db.query('DELETE FROM empresas_suscritas WHERE id = ?', [empresaId]);
    });

    // Publicar producto en tienda
    await db.query(
      `INSERT INTO tienda_publicaciones (tienda_id, empresa_id, producto_id, titulo, descripcion_publica, visible)
       VALUES (?, ?, ?, 'Camiseta Especial Web', 'Camiseta premium 100% algodón', 1)`,
      [tiendaId, empresaId, productoId]
    );

    // -------------------------------------------------------------
    // PRUEBA 1: Tienda en borrador -> Debe retornar 403 TIENDA_PAUSADA
    // -------------------------------------------------------------
    const rBorrador = await request(server, `/tienda-publica/${testSlug}`);
    assert.equal(rBorrador.status, 403, 'Tienda en borrador debe rechazar acceso público con 403');
    assert.equal(rBorrador.body?.error, 'TIENDA_PAUSADA');

    // Cambiar estado a 'publicada' pero sin contratación activa
    await db.query("UPDATE tiendas SET estado = 'publicada' WHERE id = ?", [tiendaId]);

    // -------------------------------------------------------------
    // PRUEBA 2: Tienda publicada pero sin contratación -> Debe retornar 403 TIENDA_SIN_PLAN
    // -------------------------------------------------------------
    const rSinPlan = await request(server, `/tienda-publica/${testSlug}`);
    assert.equal(rSinPlan.status, 403, 'Tienda sin suscripción vigente debe retornar 403');
    assert.equal(rSinPlan.body?.error, 'TIENDA_SIN_PLAN');

    // Crear contratación vigente de prueba
    await db.query(
      `INSERT INTO tienda_contrataciones (empresa_id, desde, vence_en, estado, origen, referencia, monto_centavos)
       VALUES (?, CURDATE(), DATE_ADD(CURDATE(), INTERVAL 30 DAY), 'vigente', 'prueba', 'REF-TEST-VIG', 0)`,
      [empresaId]
    );

    // -------------------------------------------------------------
    // PRUEBA 3: Tienda publicada y vigente -> Consulta pública exitosa (sin token)
    // -------------------------------------------------------------
    const rPublica = await request(server, `/tienda-publica/${testSlug}`);
    assert.equal(rPublica.status, 200, 'Consulta pública debe responder 200');
    assert.equal(rPublica.body?.ok, true);
    assert.equal(rPublica.body?.tienda?.nombre, 'Tienda de Prueba Pública');
    assert.equal(rPublica.body?.tienda?.color_primario, '#10b981');
    assert.equal(rPublica.body?.tienda?.empresa_id, undefined, 'NUNCA debe filtrarse empresa_id');

    // -------------------------------------------------------------
    // PRUEBA 4: Catálogo público -> Proyección estricta y aislamiento de costos
    // -------------------------------------------------------------
    const rCatalogo = await request(server, `/tienda-publica/${testSlug}/productos`);
    assert.equal(rCatalogo.status, 200);
    assert.equal(rCatalogo.body?.ok, true);
    assert.ok(Array.isArray(rCatalogo.body?.productos), 'Debe devolver arreglo de productos');
    assert.equal(rCatalogo.body?.productos.length, 1);

    const prodPublicado = rCatalogo.body.productos[0];
    assert.equal(prodPublicado.producto_id, productoId);
    assert.equal(prodPublicado.titulo, 'Camiseta Especial Web');
    assert.equal(prodPublicado.precio_venta, '30000.00');
    assert.equal(prodPublicado.stock, 10);
    assert.equal(prodPublicado.disponible, 1);

    // Verificación de seguridad CRÍTICA: Ausencia total de secretos comerciales y costos
    assert.equal(prodPublicado.precio_compra, undefined, 'SEGURIDAD: precio_compra no debe existir');
    assert.equal(prodPublicado.porcentaje_ganancia, undefined, 'SEGURIDAD: porcentaje_ganancia no debe existir');
    assert.equal(prodPublicado.proveedor, undefined, 'SEGURIDAD: proveedor no debe existir');

    // -------------------------------------------------------------
    // PRUEBA 5: Crear pedido con reserva de stock e idempotencia
    // -------------------------------------------------------------
    const idempotencyKey = `idemp-${Date.now()}`;
    const pedidoPayload = {
      cliente_nombre: 'Maria Gomez',
      cliente_telefono: '3119876543',
      cliente_email: 'maria@example.com',
      metodo_entrega: 'recogida',
      metodo_pago: 'transferencia_manual',
      notas_cliente: 'Recojo hoy a las 5pm',
      clave_idempotencia: idempotencyKey,
      items: [{ producto_id: productoId, cantidad: 3 }]
    };

    const rPedido1 = await request(server, `/tienda-publica/${testSlug}/pedidos`, {
      method: 'POST',
      body: pedidoPayload
    });

    assert.equal(rPedido1.status, 201, 'Pedido debe crearse con código 201');
    assert.equal(rPedido1.body?.ok, true);
    assert.ok(rPedido1.body?.pedido?.codigo_orden, 'Debe incluir código de orden legible');
    assert.ok(rPedido1.body?.pedido?.token_seguimiento, 'Debe incluir token de seguimiento');
    assert.equal(rPedido1.body?.pedido?.total, 90000, '3 * 30000 = 90000 calculado por el servidor');

    const tokenSeguimiento = rPedido1.body.pedido.token_seguimiento;
    const pedidoId = rPedido1.body.pedido.id;

    // Verificar que el inventario se decrementó atómicamente de 10 a 7
    const [prodPost1] = await db.query('SELECT cantidad FROM productos WHERE id = ?', [productoId]);
    assert.equal(prodPost1[0].cantidad, 7, 'El stock debió decrementar de 10 a 7');

    // Verificar que se creó la reserva con TTL
    const [reservas] = await db.query('SELECT * FROM tienda_reservas WHERE pedido_id = ?', [pedidoId]);
    assert.equal(reservas.length, 1);
    assert.equal(reservas[0].cantidad, 3);
    assert.equal(reservas[0].estado, 'activa');

    // -------------------------------------------------------------
    // PRUEBA 6: Idempotencia -> Reintento con misma clave devuelve pedido existente sin descontar stock
    // -------------------------------------------------------------
    const rPedidoReintento = await request(server, `/tienda-publica/${testSlug}/pedidos`, {
      method: 'POST',
      body: pedidoPayload
    });

    assert.equal(rPedidoReintento.status, 200, 'Reintento con misma clave debe responder 200');
    assert.equal(rPedidoReintento.body?.reutilizado, true);
    assert.equal(rPedidoReintento.body?.pedido?.codigo_orden, rPedido1.body.pedido.codigo_orden);

    // Comprobar que el stock NO se volvió a descontar (sigue en 7)
    const [prodPostReintento] = await db.query('SELECT cantidad FROM productos WHERE id = ?', [productoId]);
    assert.equal(prodPostReintento[0].cantidad, 7, 'Stock no debe cambiar en petición idempotente repetida');

    // -------------------------------------------------------------
    // PRUEBA 7: Rechazo de pedido por stock insuficiente
    // -------------------------------------------------------------
    const rSinStock = await request(server, `/tienda-publica/${testSlug}/pedidos`, {
      method: 'POST',
      body: {
        cliente_nombre: 'Comprador Excesivo',
        clave_idempotencia: require('crypto').randomUUID(),
        cliente_telefono: '3000000000',
        items: [{ producto_id: productoId, cantidad: 50 }] // Disponible 7
      }
    });
    assert.equal(rSinStock.status, 400, 'Debe rechazar con 400 cuando falta stock');
    assert.equal(rSinStock.body?.error, 'STOCK_INSUFICIENTE');

    // -------------------------------------------------------------
    // PRUEBA 8: Consulta de seguimiento por token criptográfico
    // -------------------------------------------------------------
    const rTracking = await request(server, `/tienda-publica/${testSlug}/pedidos/${tokenSeguimiento}`);
    assert.equal(rTracking.status, 200);
    assert.equal(rTracking.body?.ok, true);
    assert.equal(rTracking.body?.pedido?.cliente_nombre, 'Maria Gomez');
    assert.equal(rTracking.body?.pedido?.items?.length, 1);
    assert.equal(rTracking.body?.pedido?.items[0].titulo_historico, 'Camiseta Especial Web');

    // -------------------------------------------------------------
    // PRUEBA 9: Gestión en el POS -> Listar pedidos y actualizar estado
    // -------------------------------------------------------------
    const rAdminPedidos = await request(server, '/tienda-admin/pedidos', {
      headers: authHeaders
    });
    assert.equal(rAdminPedidos.status, 200);
    assert.equal(rAdminPedidos.body?.ok, true);
    assert.ok(rAdminPedidos.body?.pedidos?.length >= 1);
    assert.ok(rAdminPedidos.body?.contadores?.pendientes >= 1);

    // Cancelar el pedido desde el POS -> Debe reintegrar el stock de 7 a 10
    const rCancelar = await request(server, `/tienda-admin/pedidos/${pedidoId}/estado`, {
      method: 'PUT',
      headers: authHeaders,
      body: { nuevo_estado: 'cancelado' }
    });
    assert.equal(rCancelar.status, 200);
    assert.equal(rCancelar.body?.success, true);
    assert.equal(rCancelar.body?.nuevo_estado, 'cancelado');

    // Verificar restitución de stock a 10
    const [prodRestituido] = await db.query('SELECT cantidad FROM productos WHERE id = ?', [productoId]);
    assert.equal(prodRestituido[0].cantidad, 10, 'El stock cancelado debe restituirse a 10');

    // Verificar que la reserva pasó a 'cancelada'
    const [reservaCancelada] = await db.query('SELECT estado FROM tienda_reservas WHERE pedido_id = ?', [pedidoId]);
    assert.equal(reservaCancelada[0].estado, 'cancelada');

    console.log('✅ [TEST] Catálogo Público y Pedidos (Etapas 4 y 5): ¡Todas las pruebas pasaron satisfactoriamente!');
  } finally {
    for (const fn of cleanupFns) {
      try {
        await fn();
      } catch (e) {
        console.warn('Error en limpieza:', e.message);
      }
    }
    server.close();
    process.exit(0);
  }
}

run().catch((err) => {
  console.error('❌ [TEST] Error en pruebas de Catálogo Público y Pedidos:', err);
  process.exit(1);
});
