import express from "express";
import { enteroInventario } from "../utils/enteroInventario";
import crypto from "crypto";
import pool from "../conection";
import { calcularFirmaIntegridad, validarWebhookTienda } from "../services/tiendaWompiService";


const router = express.Router();

// Helper: Resolver tienda por slug y validar estado y vigencia de contratación
async function resolverTiendaPublica(slug: string, db: any) {
  const [tiendas]: any = await db.query(
    `SELECT t.id, t.empresa_id, t.slug, t.nombre, t.descripcion, t.logo_url, 
            t.correo_contacto, t.telefono_contacto, t.estado, t.color_primario,
            t.direccion_recogida, t.horario_atencion, t.banner_url, t.tagline
     FROM tiendas t 
     WHERE t.slug = ?`,
    [slug]
  );

  if (!tiendas || tiendas.length === 0) {
    return { ok: false, status: 404, error: "TIENDA_NO_ENCONTRADA", mensaje: "La tienda solicitada no existe." };
  }

  const tienda = tiendas[0];

  if (tienda.estado !== "publicada") {
    return {
      ok: false,
      status: 403,
      error: "TIENDA_PAUSADA",
      mensaje: "Esta tienda se encuentra temporalmente cerrada o en mantenimiento."
    };
  }

  // Validar vigencia de la contratación o prueba activa
  const [contrataciones]: any = await db.query(
    `SELECT id, vence_en 
     FROM tienda_contrataciones 
     WHERE empresa_id = ? AND estado = 'vigente' AND vence_en >= CURDATE()
     ORDER BY vence_en DESC 
     LIMIT 1`,
    [tienda.empresa_id]
  );

  if (!contrataciones || contrataciones.length === 0) {
    return {
      ok: false,
      status: 403,
      error: "TIENDA_SIN_PLAN",
      mensaje: "La tienda online no tiene un plan activo en este momento."
    };
  }

  return { ok: true, tienda };
}

// 1. Obtener perfil público de la tienda
router.get("/:slug", async (req: any, res: any) => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    if (!slug) {
      return res.status(400).json({ ok: false, error: "SLUG_INVALIDO" });
    }

    const db = pool.promise();
    const resolucion = await resolverTiendaPublica(slug, db);

    if (!resolucion.ok) {
      return res.status(resolucion.status).json({
        ok: false,
        error: resolucion.error,
        mensaje: resolucion.mensaje
      });
    }

    const t = resolucion.tienda;

    // Consultar si la tienda tiene pasarela Wompi activa (solo se expone llave pública y ambiente)
    const [pasarelas]: any = await db.query(
      "SELECT activo, ambiente, public_key FROM tienda_pasarelas_config WHERE tienda_id = ? AND proveedor = 'wompi' AND activo = 1 LIMIT 1",
      [t.id]
    );
    const wompiConfig = pasarelas[0] || null;

    // Solo devolver campos públicos (sin empresa_id ni metadatos internos)
    return res.json({
      ok: true,
      tienda: {
        slug: t.slug,
        nombre: t.nombre,
        descripcion: t.descripcion || "",
        logo_url: t.logo_url || "",
        correo_contacto: t.correo_contacto || "",
        telefono_contacto: t.telefono_contacto || "",
        color_primario: t.color_primario || "#4f46e5",
        direccion_recogida: t.direccion_recogida || "",
        horario_atencion: t.horario_atencion || "",
        banner_url: t.banner_url || "",
        tagline: t.tagline || "",
        wompi: wompiConfig ? {
          activo: true,
          ambiente: wompiConfig.ambiente,
          public_key: wompiConfig.public_key
        } : null
      }
    });
  } catch (err: any) {
    console.error("Error en GET /tienda-publica/:slug:", err);
    return res.status(500).json({ ok: false, error: "ERROR_SERVIDOR" });
  }
});

// 2. Obtener catálogo de productos públicos
router.get("/:slug/productos", async (req: any, res: any) => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const db = pool.promise();

    const resolucion = await resolverTiendaPublica(slug, db);
    if (!resolucion.ok) {
      return res.status(resolucion.status).json({
        ok: false,
        error: resolucion.error,
        mensaje: resolucion.mensaje
      });
    }

    const tienda = resolucion.tienda;

    // Filtros
    const q = String(req.query.q || "").trim();
    const categoria = String(req.query.categoria || "").trim();
    const pagina = Math.max(1, parseInt(String(req.query.pagina || "1"), 10) || 1);
    const limite = Math.min(50, Math.max(1, parseInt(String(req.query.limite || "24"), 10) || 24));
    const offset = (pagina - 1) * limite;
    const orden = String(req.query.orden || "orden_asc");

    let whereClause = "WHERE tp.tienda_id = ? AND tp.visible = 1";
    const params: any[] = [tienda.id];

    if (categoria) {
      whereClause += " AND p.categoria = ?";
      params.push(categoria);
    }

    if (q) {
      whereClause += " AND (tp.titulo LIKE ? OR p.nombre LIKE ? OR tp.descripcion_publica LIKE ?)";
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    // Ordenamiento seguro
    let orderSql = "ORDER BY tp.orden ASC, p.id DESC";
    if (orden === "precio_asc") orderSql = "ORDER BY CAST(p.precio_venta AS DECIMAL(12,2)) ASC, p.id DESC";
    else if (orden === "precio_desc") orderSql = "ORDER BY CAST(p.precio_venta AS DECIMAL(12,2)) DESC, p.id DESC";
    else if (orden === "nombre_asc") orderSql = "ORDER BY COALESCE(NULLIF(tp.titulo, ''), p.nombre) ASC";

    // Conteo total
    const [countRows]: any = await db.query(
      `SELECT COUNT(*) as total
       FROM tienda_publicaciones tp
       JOIN productos p ON p.id = tp.producto_id AND p.empresa_id = tp.empresa_id
       ${whereClause}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);
    const paginas = Math.ceil(total / limite) || 1;

    // Consulta de productos estrictamente proyectada (sin costos, ganancias ni proveedores)
    const [productos]: any = await db.query(
      `SELECT 
         p.id AS producto_id,
         COALESCE(NULLIF(tp.titulo, ''), p.nombre) AS titulo,
         COALESCE(tp.descripcion_publica, '') AS descripcion,
         p.precio_venta,
         p.categoria,
         p.cantidad AS stock,
         (p.cantidad > 0) AS disponible,
         tp.imagen_url
       FROM tienda_publicaciones tp
       JOIN productos p ON p.id = tp.producto_id AND p.empresa_id = tp.empresa_id
       ${whereClause}
       ${orderSql}
       LIMIT ? OFFSET ?`,
      [...params, limite, offset]
    );

    // Obtener lista de categorías únicas disponibles con productos publicados
    const [categoriasRows]: any = await db.query(
      `SELECT DISTINCT p.categoria
       FROM tienda_publicaciones tp
       JOIN productos p ON p.id = tp.producto_id AND p.empresa_id = tp.empresa_id
       WHERE tp.tienda_id = ? AND tp.visible = 1 AND p.categoria IS NOT NULL AND TRIM(p.categoria) != ''
       ORDER BY p.categoria ASC`,
      [tienda.id]
    );
    const categorias = categoriasRows.map((r: any) => r.categoria);

    return res.json({
      ok: true,
      productos,
      categorias,
      paginacion: {
        total,
        pagina,
        paginas,
        limite
      }
    });
  } catch (err: any) {
    console.error("Error en GET /tienda-publica/:slug/productos:", err);
    return res.status(500).json({ ok: false, error: "ERROR_SERVIDOR" });
  }
});

// 3. Obtener detalle de un producto individual público
router.get("/:slug/productos/:productoId", async (req: any, res: any) => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const productoId = parseInt(String(req.params.productoId), 10);
    if (!Number.isSafeInteger(productoId) || productoId < 1) {
      return res.status(400).json({ ok: false, error: "PRODUCTO_ID_INVALIDO" });
    }

    const db = pool.promise();
    const resolucion = await resolverTiendaPublica(slug, db);
    if (!resolucion.ok) {
      return res.status(resolucion.status).json({
        ok: false,
        error: resolucion.error,
        mensaje: resolucion.mensaje
      });
    }

    const tienda = resolucion.tienda;

    const [rows]: any = await db.query(
      `SELECT 
         p.id AS producto_id,
         COALESCE(NULLIF(tp.titulo, ''), p.nombre) AS titulo,
         COALESCE(tp.descripcion_publica, '') AS descripcion,
         p.precio_venta,
         p.categoria,
         p.cantidad AS stock,
         (p.cantidad > 0) AS disponible,
         tp.imagen_url
       FROM tienda_publicaciones tp
       JOIN productos p ON p.id = tp.producto_id AND p.empresa_id = tp.empresa_id
       WHERE tp.tienda_id = ? AND tp.visible = 1 AND p.id = ?
       LIMIT 1`,
      [tienda.id, productoId]
    );

    if (!rows || rows.length === 0) {
      return res.status(404).json({ ok: false, error: "PRODUCTO_NO_ENCONTRADO" });
    }

    return res.json({ ok: true, producto: rows[0] });
  } catch (err: any) {
    console.error("Error en GET /tienda-publica/:slug/productos/:productoId:", err);
    return res.status(500).json({ ok: false, error: "ERROR_SERVIDOR" });
  }
});

// 4. Crear pedido de compra (Checkout invitado con reserva de inventario)
router.post("/:slug/pedidos", async (req: any, res: any) => {
  const db = pool.promise();
  let conn: any = null;

  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const resolucion = await resolverTiendaPublica(slug, db);
    if (!resolucion.ok) {
      return res.status(resolucion.status).json({
        ok: false,
        error: resolucion.error,
        mensaje: resolucion.mensaje
      });
    }

    const tienda = resolucion.tienda;
    const body = req.body || {};

    const clienteNombre = String(body.cliente_nombre || "").trim().slice(0, 150);
    const clienteTelefono = String(body.cliente_telefono || "").trim().slice(0, 50);
    const clienteEmail = body.cliente_email ? String(body.cliente_email).trim().slice(0, 150) : null;
    const metodoEntrega = body.metodo_entrega === "acordar_vendedor" ? "acordar_vendedor" : "recogida";
    const metodoPago = body.metodo_pago === "efectivo_recogida" 
      ? "efectivo_recogida" 
      : body.metodo_pago === "wompi" 
        ? "wompi" 
        : "transferencia_manual";
    const notasCliente = body.notas_cliente ? String(body.notas_cliente).trim().slice(0, 500) : null;
    const claveIdempotencia = body.clave_idempotencia;
    if(typeof claveIdempotencia!=="string" || !/^[a-zA-Z0-9_-]{16,64}$/.test(claveIdempotencia)){
      return res.status(400).json({ok:false,error:"CLAVE_INVALIDA",mensaje:"Falta una clave de checkout válida."});
    }

    // Si el método es Wompi, verificar que la tienda tenga la pasarela configurada y activa
    let wompiConfig: any = null;
    if (metodoPago === "wompi") {
      const [pasarelas]: any = await db.query(
        "SELECT activo, ambiente, public_key, integrity_secret FROM tienda_pasarelas_config WHERE tienda_id = ? AND proveedor = 'wompi' AND activo = 1 LIMIT 1",
        [tienda.id]
      );
      if (!pasarelas.length || !pasarelas[0].public_key || !pasarelas[0].integrity_secret) {
        return res.status(400).json({ ok: false, error: "WOMPI_NO_CONFIGURADO", mensaje: "El pago en línea con Wompi no está disponible para esta tienda." });
      }
      wompiConfig = pasarelas[0];
    }
    const rawItems = Array.isArray(body.items) ? body.items : [];

    if (!clienteNombre || clienteNombre.length < 2) {
      return res.status(400).json({ ok: false, error: "NOMBRE_REQUERIDO", mensaje: "Por favor ingresa tu nombre completo." });
    }
    if (!clienteTelefono || clienteTelefono.length < 7) {
      return res.status(400).json({ ok: false, error: "TELEFONO_REQUERIDO", mensaje: "Por favor ingresa un teléfono de contacto válido." });
    }
    if (!rawItems.length || rawItems.length > 50) {
      return res.status(400).json({ ok: false, error: "ITEMS_INVALIDOS", mensaje: "El carrito debe contener entre 1 y 50 productos." });
    }

    // Normalizar y deduplicar items
    const itemsMap = new Map<number, number>();
    for (const item of rawItems) {
      const pid = enteroInventario(item?.producto_id);
      const qty = enteroInventario(item?.cantidad);
      if (!pid || !qty || !enteroInventario((itemsMap.get(pid) || 0) + qty)) {
        return res.status(400).json({ ok: false, error: "ITEM_INVALIDO", mensaje: "Revisa los productos y cantidades seleccionadas." });
      }
      itemsMap.set(pid, (itemsMap.get(pid) || 0) + qty);
    }

    // Manejo de idempotencia: Si ya existe un pedido con esta clave para la tienda, devolverlo sin duplicar
    const huella=crypto.createHash("sha256").update(JSON.stringify([clienteNombre,clienteTelefono,clienteEmail,metodoEntrega,metodoPago,notasCliente,[...itemsMap].sort(([a],[b])=>a-b)])).digest("hex");
    const recuperar=async (conexion:any)=>{
      const [pedidosExistentes]: any = await conexion.query(
        `SELECT id, codigo_orden, token_seguimiento, total, estado, creado_en, huella_checkout, metodo_pago
         FROM tienda_pedidos 
         WHERE tienda_id = ? AND clave_idempotencia = ?
         LIMIT 1`,
        [tienda.id, claveIdempotencia]
      );
      if (pedidosExistentes && pedidosExistentes.length > 0) {
        const existente = pedidosExistentes[0];
        if(existente.huella_checkout!==huella){
          res.status(409).json({ok:false,error:"INTENTO_DISTINTO",mensaje:"La clave ya corresponde a otro pedido. Revisa tu compra."});
          return true;
        }

        let wompiRecuperado: any = null;
        if (existente.metodo_pago === "wompi" && existente.estado === "pendiente") {
          const [pas]: any = await conexion.query(
            "SELECT public_key, ambiente, integrity_secret FROM tienda_pasarelas_config WHERE tienda_id = ? AND proveedor = 'wompi' AND activo = 1 LIMIT 1",
            [tienda.id]
          );
          if (pas.length && pas[0].integrity_secret) {
            const montoCentavos = Math.round(Number(existente.total) * 100);
            wompiRecuperado = {
              public_key: pas[0].public_key,
              referencia: existente.codigo_orden,
              monto_centavos: montoCentavos,
              moneda: "COP",
              firma_integridad: calcularFirmaIntegridad(existente.codigo_orden, montoCentavos, "COP", pas[0].integrity_secret),
              ambiente: pas[0].ambiente
            };
          }
        }

        res.json({
          ok: true,
          reutilizado: true,
          pedido: {
            id: existente.id,
            codigo_orden: existente.codigo_orden,
            token_seguimiento: existente.token_seguimiento,
            total: existente.total,
            estado: existente.estado,
            creado_en: existente.creado_en
          },
          wompi: wompiRecuperado
        });
        return true;
      }
      return false;
    };
    if(await recuperar(db))return;

    // Iniciar transacción para garantizar consistencia atómica de stock y pedido
    conn = await pool.promise().getConnection();
    await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await conn.beginTransaction();

    // Adquirir primero la clave única: un reintento espera al COMMIT o ROLLBACK del
    // primer envío, antes de evaluar un stock que ese envío podría haber agotado.
    const fechaStr = new Date().toISOString().slice(2, 10).replace(/-/g, "");
    const codigoOrden = `PED-${fechaStr}-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;
    const tokenSeguimiento = crypto.randomBytes(32).toString("hex");
    const fechaLimitePago = new Date(Date.now() + 2 * 60 * 60 * 1000);
    let pedidoId:number;
    try{
      const [r]=await conn.execute(`INSERT INTO tienda_pedidos
        (empresa_id,tienda_id,codigo_orden,token_seguimiento,clave_idempotencia,huella_checkout,
         cliente_nombre,cliente_telefono,cliente_email,metodo_entrega,metodo_pago,notas_cliente,fecha_limite_pago)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,[tienda.empresa_id,tienda.id,codigoOrden,tokenSeguimiento,claveIdempotencia,huella,
          clienteNombre,clienteTelefono,clienteEmail,metodoEntrega,metodoPago,notasCliente,fechaLimitePago]);
      pedidoId=r.insertId;
    }catch(err:any){
      if(err.code==="ER_DUP_ENTRY"){await conn.rollback();if(await recuperar(conn))return;}
      throw err;
    }

    // 1. Bloquear y verificar los productos publicados y disponibles
    const productIds = Array.from(itemsMap.keys());
    const [prodRows]: any = await conn.query(
      `SELECT p.id, p.nombre, p.precio_venta, p.cantidad, tp.visible, tp.titulo
       FROM productos p
       INNER JOIN tienda_publicaciones tp ON tp.producto_id = p.id AND tp.empresa_id = p.empresa_id
       WHERE tp.tienda_id = ? AND p.empresa_id = ? AND p.id IN (?)
       FOR UPDATE`,
      [tienda.id, tienda.empresa_id, productIds]
    );

    if (prodRows.length !== productIds.length) {
      await conn.rollback();
      return res.status(400).json({
        ok: false,
        error: "PRODUCTO_NO_DISPONIBLE",
        mensaje: "Uno o más productos ya no están publicados en esta tienda."
      });
    }

    // Verificar visibilidad y stock suficiente
    let subtotalCalculado = 0;
    const itemsParaGuardar: Array<{
      producto_id: number;
      titulo_historico: string;
      precio_unitario: number;
      cantidad: number;
      subtotal: number;
    }> = [];

    for (const prod of prodRows) {
      if (prod.visible !== 1) {
        await conn.rollback();
        return res.status(400).json({
          ok: false,
          error: "PRODUCTO_NO_VISIBLE",
          mensaje: `El producto "${prod.nombre}" no está disponible actualmente.`
        });
      }

      const cantSolicitada = itemsMap.get(prod.id)!;
      const stockDisponible = Number(prod.cantidad);

      if (cantSolicitada > stockDisponible) {
        await conn.rollback();
        return res.status(400).json({
          ok: false,
          error: "STOCK_INSUFICIENTE",
          mensaje: `Stock insuficiente para "${prod.nombre}". Disponible: ${stockDisponible}, solicitado: ${cantSolicitada}.`
        });
      }

      const precioUnit = parseFloat(String(prod.precio_venta)) || 0;
      const itemSubtotal = precioUnit * cantSolicitada;
      subtotalCalculado += itemSubtotal;

      itemsParaGuardar.push({
        producto_id: prod.id,
        titulo_historico: prod.titulo || prod.nombre,
        precio_unitario: precioUnit,
        cantidad: cantSolicitada,
        subtotal: itemSubtotal
      });
    }

    const totalCalculado = subtotalCalculado; // Recogida en tienda tiene costo de envío 0

    await conn.execute('UPDATE tienda_pedidos SET subtotal=?,total=? WHERE id=?',[subtotalCalculado,totalCalculado,pedidoId]);

    // 3. Insertar items y registrar reservas descontando stock
    for (const item of itemsParaGuardar) {
      await conn.query(
        `INSERT INTO tienda_pedido_items 
          (pedido_id, producto_id, titulo_historico, precio_unitario, cantidad, subtotal)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [pedidoId, item.producto_id, item.titulo_historico, item.precio_unitario, item.cantidad, item.subtotal]
      );

      // Reserva de stock con TTL
      await conn.query(
        `INSERT INTO tienda_reservas 
          (empresa_id, pedido_id, producto_id, cantidad, expira_en, estado)
         VALUES (?, ?, ?, ?, ?, 'activa')`,
        [tienda.empresa_id, pedidoId, item.producto_id, item.cantidad, fechaLimitePago]
      );

      // Descontar inventario disponible de forma segura
      await conn.query(
        `UPDATE productos 
         SET cantidad = cantidad - ? 
         WHERE id = ? AND empresa_id = ?`,
        [item.cantidad, item.producto_id, tienda.empresa_id]
      );
      const antes = Number(prodRows.find(p=>p.id===item.producto_id).cantidad);
      await conn.query(`INSERT INTO kardex
        (empresa_id,producto_id,tipo_movimiento,motivo,referencia,cantidad_antes,cantidad_modificada,cantidad_despues)
        VALUES (?,?,'SALIDA','Reserva pedido web',?,?,?,?)`,
        [tienda.empresa_id,item.producto_id,codigoOrden,antes,-item.cantidad,antes-item.cantidad]);
    }

    await conn.commit();

    // 4. Notificar a través de Socket.IO a la sala de la empresa en tiempo real
    try {
      const io = req.app.get("io");
      if (io) {
        io.to(`empresa_${tienda.empresa_id}`).emit("nuevo_pedido_tienda", {
          pedido_id: pedidoId,
          codigo_orden: codigoOrden,
          cliente_nombre: clienteNombre,
          cliente_telefono: clienteTelefono,
          total: totalCalculado,
          metodo_pago: metodoPago,
          metodo_entrega: metodoEntrega,
          creado_en: new Date()
        });
      }
    } catch (socketErr) {
      console.warn("No se pudo emitir evento socket de nuevo pedido:", socketErr);
    }

    let wompiPayload: any = null;
    if (metodoPago === "wompi" && wompiConfig) {
      const montoCentavos = Math.round(totalCalculado * 100);
      const firma = calcularFirmaIntegridad(codigoOrden, montoCentavos, "COP", wompiConfig.integrity_secret);
      wompiPayload = {
        public_key: wompiConfig.public_key,
        referencia: codigoOrden,
        monto_centavos: montoCentavos,
        moneda: "COP",
        firma_integridad: firma,
        ambiente: wompiConfig.ambiente
      };
    }

    return res.status(201).json({
      ok: true,
      pedido: {
        id: pedidoId,
        codigo_orden: codigoOrden,
        token_seguimiento: tokenSeguimiento,
        estado: "pendiente",
        cliente_nombre: clienteNombre,
        cliente_telefono: clienteTelefono,
        metodo_entrega: metodoEntrega,
        metodo_pago: metodoPago,
        subtotal: subtotalCalculado,
        total: totalCalculado,
        fecha_limite_pago: fechaLimitePago,
        items: itemsParaGuardar
      },
      wompi: wompiPayload
    });
  } catch (err: any) {
    if (conn) await conn.rollback();
    console.error("Error en POST /tienda-publica/:slug/pedidos:", err);
    return res.status(500).json({ ok: false, error: "ERROR_SERVIDOR", mensaje: "No se pudo procesar el pedido." });
  } finally {
    if (conn) conn.release();
  }
});

// 5. Consultar estado del pedido mediante token de seguimiento seguro
router.get("/:slug/pedidos/:token", async (req: any, res: any) => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const token = String(req.params.token || "").trim();

    if (!token || token.length < 20) {
      return res.status(400).json({ ok: false, error: "TOKEN_INVALIDO" });
    }

    const db = pool.promise();

    // Consultar pedido y su tienda
    const [pedidos]: any = await db.query(
      `SELECT p.*, t.nombre AS tienda_nombre, t.telefono_contacto AS tienda_telefono,
              t.correo_contacto AS tienda_correo, t.direccion_recogida, t.color_primario
       FROM tienda_pedidos p
       JOIN tiendas t ON t.id = p.tienda_id
       WHERE t.slug = ? AND p.token_seguimiento = ?
       LIMIT 1`,
      [slug, token]
    );

    if (!pedidos || pedidos.length === 0) {
      return res.status(404).json({ ok: false, error: "PEDIDO_NO_ENCONTRADO", mensaje: "El pedido no fue encontrado o el enlace es incorrecto." });
    }

    const p = pedidos[0];

    // Consultar items históricos del pedido
    const [items]: any = await db.query(
      `SELECT id, producto_id, titulo_historico, precio_unitario, cantidad, subtotal
       FROM tienda_pedido_items
       WHERE pedido_id = ?
       ORDER BY id ASC`,
      [p.id]
    );

    return res.json({
      ok: true,
      pedido: {
        codigo_orden: p.codigo_orden,
        token_seguimiento: p.token_seguimiento,
        estado: p.estado,
        cliente_nombre: p.cliente_nombre,
        cliente_telefono: p.cliente_telefono,
        cliente_email: p.cliente_email,
        metodo_entrega: p.metodo_entrega,
        metodo_pago: p.metodo_pago,
        subtotal: p.subtotal,
        total: p.total,
        notas_cliente: p.notas_cliente,
        comprobante_url: p.comprobante_url,
        wompi_transaction_id: p.wompi_transaction_id,
        wompi_estado: p.wompi_estado,
        fecha_limite_pago: p.fecha_limite_pago,
        creado_en: p.creado_en,
        items,
        tienda: {
          nombre: p.tienda_nombre,
          telefono_contacto: p.tienda_telefono,
          correo_contacto: p.tienda_correo,
          direccion_recogida: p.direccion_recogida,
          color_primario: p.color_primario || "#4f46e5"
        }
      }
    });
  } catch (err: any) {
    console.error("Error en GET /tienda-publica/:slug/pedidos/:token:", err);
    return res.status(500).json({ ok: false, error: "ERROR_SERVIDOR" });
  }
});

// 6. Subir comprobante o referencia de pago por parte del cliente
router.post("/:slug/pedidos/:token/comprobante", async (req: any, res: any) => {
  try {
    const slug = String(req.params.slug || "").trim().toLowerCase();
    const token = String(req.params.token || "").trim();
    const referencia = String(req.body?.referencia || "").trim().slice(0, 500);

    if (!referencia) {
      return res.status(400).json({ ok: false, error: "REFERENCIA_REQUERIDA", mensaje: "Ingresa el número de comprobante o referencia de transferencia." });
    }

    const db = pool.promise();
    const [pedidos]: any = await db.query(
      `SELECT p.id, p.empresa_id, p.codigo_orden, p.estado 
       FROM tienda_pedidos p
       JOIN tiendas t ON t.id = p.tienda_id
       WHERE t.slug = ? AND p.token_seguimiento = ?
       LIMIT 1`,
      [slug, token]
    );

    if (!pedidos || pedidos.length === 0) {
      return res.status(404).json({ ok: false, error: "PEDIDO_NO_ENCONTRADO" });
    }

    const pedido = pedidos[0];

    // Actualizar pedido
    await db.query(
      `UPDATE tienda_pedidos 
       SET comprobante_url = ?, 
           estado = CASE WHEN estado = 'pendiente' THEN 'comprobante_enviado' ELSE estado END
       WHERE id = ?`,
      [referencia, pedido.id]
    );

    // Notificar al POS
    try {
      const io = req.app.get("io");
      if (io) {
        io.to(`empresa_${pedido.empresa_id}`).emit("comprobante_pedido_tienda", {
          pedido_id: pedido.id,
          codigo_orden: pedido.codigo_orden,
          referencia
        });
      }
    } catch (e) {
      // Ignorar fallo de socket
    }

    return res.json({ ok: true, mensaje: "Comprobante registrado con éxito." });
  } catch (err: any) {
    console.error("Error en POST /tienda-publica/:slug/pedidos/:token/comprobante:", err);
    return res.status(500).json({ ok: false, error: "ERROR_SERVIDOR" });
  }
});

// 7. Webhook universal para eventos de Wompi de tiendas en línea
router.post("/wompi-webhook", async (req: any, res: any) => {
  try {
    const evento = req.body;
    const dataTx = evento?.data?.transaction;
    const reference = dataTx?.reference;

    if (!reference || typeof reference !== "string") {
      return res.status(200).json({ received: true, ignored: "SIN_REFERENCIA" });
    }

    const db = pool.promise();

    // 1. Localizar el pedido por el código de orden
    const [pedidos]: any = await db.query(
      `SELECT p.id, p.empresa_id, p.tienda_id, p.codigo_orden, p.total, p.estado, p.wompi_transaction_id
       FROM tienda_pedidos p 
       WHERE p.codigo_orden = ? LIMIT 1`,
      [reference]
    );

    if (!pedidos || pedidos.length === 0) {
      return res.status(200).json({ received: true, ignored: "PEDIDO_NO_ENCONTRADO" });
    }

    const pedido = pedidos[0];

    // 2. Obtener el secreto de eventos de la tienda
    const [pasarelas]: any = await db.query(
      `SELECT event_secret FROM tienda_pasarelas_config 
       WHERE tienda_id = ? AND empresa_id = ? AND proveedor = 'wompi' LIMIT 1`,
      [pedido.tienda_id, pedido.empresa_id]
    );

    if (!pasarelas || pasarelas.length === 0 || !pasarelas[0].event_secret) {
      console.warn(`[WOMPI_TIENDA_WEBHOOK] Pedido ${reference} recibido pero la tienda no tiene event_secret configurado.`);
      return res.status(200).json({ received: true, ignored: "PASARELA_SIN_SECRETO" });
    }

    const eventSecret = pasarelas[0].event_secret;

    // 3. Validar la firma criptográfica del webhook
    const esValido = validarWebhookTienda(evento, eventSecret);
    if (!esValido) {
      console.warn(`[WOMPI_TIENDA_WEBHOOK] Firma inválida rechazada para pedido ${reference} en tienda ${pedido.tienda_id}`);
      return res.status(400).json({ error: "FIRMA_INVALIDA" });
    }

    // 4. Procesar el estado de la transacción
    const txId = String(dataTx.id || "");
    const status = String(dataTx.status || "");
    const amountInCents = Number(dataTx.amount_in_cents);
    const montoEsperadoCentavos = Math.round(Number(pedido.total) * 100);

    if (status === "APPROVED") {
      if (amountInCents !== montoEsperadoCentavos) {
        console.warn(`[WOMPI_TIENDA_WEBHOOK] Inconsistencia de importe en pedido ${reference}: esperado ${montoEsperadoCentavos}, recibido ${amountInCents}`);
      }

      // Si no ha sido confirmado aún, pasarlo a confirmado y consolidar la reserva de stock
      if (!["confirmado", "preparando", "listo_recogida", "entregado"].includes(pedido.estado)) {
        const conn = await pool.promise().getConnection();
        try {
          await conn.beginTransaction();

          await conn.query(
            `UPDATE tienda_pedidos 
             SET estado = 'confirmado', wompi_transaction_id = ?, wompi_estado = 'APPROVED'
             WHERE id = ?`,
            [txId, pedido.id]
          );

          await conn.query(
            `UPDATE tienda_reservas 
             SET estado = 'consolidada' 
             WHERE pedido_id = ? AND estado = 'activa'`,
            [pedido.id]
          );

          await conn.query(
            `INSERT INTO tienda_auditoria (empresa_id, entidad, entidad_id, accion, actor_tipo, detalle)
             VALUES (?, 'pedido', ?, 'pago_wompi_aprobado', 'sistema', ?)`,
            [pedido.empresa_id, pedido.id, JSON.stringify({ wompi_id: txId, total_centavos: amountInCents, referencia: reference })]
          );

          await conn.commit();

          // Notificar vía Socket al POS de la empresa
          try {
            const io = req.app.get("io");
            if (io) {
              io.to(`empresa_${pedido.empresa_id}`).emit("pedido_pagado_tienda", {
                pedido_id: pedido.id,
                codigo_orden: pedido.codigo_orden,
                wompi_transaction_id: txId,
                total: pedido.total
              });
            }
          } catch (e) {}
        } catch (txErr) {
          await conn.rollback();
          throw txErr;
        } finally {
          conn.release();
        }
      }
    } else {
      // Estado no aprobado (DECLINED, VOIDED, ERROR)
      await db.query(
        `UPDATE tienda_pedidos 
         SET wompi_transaction_id = ?, wompi_estado = ? 
         WHERE id = ?`,
        [txId, status, pedido.id]
      );

      await db.query(
        `INSERT INTO tienda_auditoria (empresa_id, entidad, entidad_id, accion, actor_tipo, detalle)
         VALUES (?, 'pedido', ?, 'pago_wompi_fallido', 'sistema', ?)`,
        [pedido.empresa_id, pedido.id, JSON.stringify({ wompi_id: txId, status, referencia: reference })]
      );
    }

    return res.json({ success: true, reference, status });
  } catch (err: any) {
    console.error("[WOMPI_TIENDA_WEBHOOK] Error procesando webhook:", err);
    return res.status(500).json({ error: "ERROR_SERVIDOR" });
  }
});

export default router;
