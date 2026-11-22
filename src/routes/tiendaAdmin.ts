import express from "express";
import { liberarStockPedido } from "../services/liberarStockPedido";
import pool from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

// Todas las rutas de administración de la tienda requieren sesión administrativa del comercio
router.use(verifyTokenAndTenant);

// Middleware para verificar que req.user tiene empresa_id
const getEmpresaId = (req: any): number => {
  const empresaId = Number(req.user?.empresa_id);
  if (!Number.isSafeInteger(empresaId) || empresaId < 1) {
    throw new Error("Empresa no válida en la sesión");
  }
  return empresaId;
};

// Helper para normalizar slugs (elimina acentos, caracteres especiales, espacios por guiones)
export function normalizarSlug(texto: string): string {
  return texto
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "") // quita tildes
    .replace(/[^a-z0-9]+/g, "-")     // reemplaza no alfanuméricos por guión
    .replace(/^-+|-+$/g, "")         // quita guiones en extremos
    .slice(0, 60);
}

// 1. Obtener la tienda de la empresa (o inicializar borrador si es la primera vez)
router.get("/mi-tienda", async (req: any, res: any) => {
  try {
    const empresaId = getEmpresaId(req);
    const db = pool.promise();

    // 1.1 Consultar tienda
    const [tiendas]: any = await db.query(
      `SELECT t.*, 
        (SELECT COUNT(*) FROM tienda_publicaciones p WHERE p.tienda_id = t.id AND p.visible = 1) as productos_publicados
       FROM tiendas t WHERE t.empresa_id = ?`,
      [empresaId]
    );

    let tienda = tiendas[0];

    // Si aún no existe, crear borrador inicial automático con el nombre de la empresa
    if (!tienda) {
      const [emp]: any = await db.query("SELECT nombre_comercial, correo_contacto, telefono_contacto FROM empresas_suscritas WHERE id = ?", [empresaId]);
      const empData = emp[0] || {};
      const baseNombre = empData.nombre_comercial || `Tienda ${empresaId}`;
      let baseSlug = normalizarSlug(baseNombre) || `tienda-${empresaId}`;

      // Asegurar que el slug sea único
      const [slugExistente]: any = await db.query("SELECT id FROM tiendas WHERE slug = ?", [baseSlug]);
      if (slugExistente.length > 0) {
        baseSlug = `${baseSlug}-${empresaId}`;
      }

      await db.query(
        `INSERT INTO tiendas (empresa_id, slug, nombre, correo_contacto, telefono_contacto, estado)
         VALUES (?, ?, ?, ?, ?, 'borrador')`,
        [empresaId, baseSlug, baseNombre, empData.correo_contacto || null, empData.telefono_contacto || null]
      );

      const [nuevaTienda]: any = await db.query("SELECT *, 0 as productos_publicados FROM tiendas WHERE empresa_id = ?", [empresaId]);
      tienda = nuevaTienda[0];
    }

    // 1.2 Consultar estado de contratación del complemento
    const [contrataciones]: any = await db.query(
      `SELECT id, desde, vence_en, estado, origen, DATEDIFF(vence_en, CURRENT_DATE()) as dias_restantes
       FROM tienda_contrataciones 
       WHERE empresa_id = ? AND vence_en >= CURRENT_DATE() AND estado = 'vigente'
       ORDER BY vence_en DESC LIMIT 1`,
      [empresaId]
    );

    const contratoVigente = contrataciones[0] || null;

    res.json({
      tienda,
      contrato: contratoVigente,
      vigente: Boolean(contratoVigente && contratoVigente.dias_restantes >= 0)
    });
  } catch (error: any) {
    console.error("[TIENDA_ADMIN] Error consultando tienda:", error);
    res.status(500).json({ error: error.message || "Error al obtener la configuración de la tienda." });
  }
});

// 2. Actualizar datos de identidad y configuración de la tienda
router.put("/mi-tienda", async (req: any, res: any) => {
  try {
    const empresaId = getEmpresaId(req);
    const { nombre, slug, descripcion, logo_url, correo_contacto, telefono_contacto, color_primario, direccion_recogida, horario_atencion, banner_url, tagline } = req.body;

    if (!nombre || typeof nombre !== "string" || nombre.trim().length < 3) {
      return res.status(400).json({ error: "El nombre de la tienda debe tener al menos 3 caracteres." });
    }

    const cleanSlug = normalizarSlug(slug || nombre);
    if (!cleanSlug || cleanSlug.length < 3 || cleanSlug.length > 60) {
      return res.status(400).json({ error: "El enlace (slug) debe tener entre 3 y 60 caracteres alfanuméricos." });
    }

    const db = pool.promise();

    // 2.1 Verificar que no sea un slug reservado
    const [reservado]: any = await db.query("SELECT slug FROM tienda_slugs_reservados WHERE slug = ?", [cleanSlug]);
    if (reservado.length > 0) {
      return res.status(400).json({ error: `El enlace '${cleanSlug}' está reservado por el sistema. Por favor elige otro.` });
    }

    // 2.2 Verificar que el slug no pertenezca a otra tienda
    const [duplicado]: any = await db.query("SELECT id FROM tiendas WHERE slug = ? AND empresa_id != ?", [cleanSlug, empresaId]);
    if (duplicado.length > 0) {
      return res.status(409).json({ error: `El enlace '${cleanSlug}' ya está siendo utilizado por otro comercio.` });
    }

    // 2.3 Actualizar tienda
    await db.query(
      `UPDATE tiendas 
       SET nombre = ?, slug = ?, descripcion = ?, logo_url = ?, correo_contacto = ?, telefono_contacto = ?,
           color_primario = COALESCE(?, color_primario),
           direccion_recogida = ?,
           horario_atencion = ?,
           banner_url = ?,
           tagline = ?
       WHERE empresa_id = ?`,
      [
        nombre.trim(),
        cleanSlug,
        descripcion || null,
        logo_url || null,
        correo_contacto || null,
        telefono_contacto || null,
        color_primario || null,
        direccion_recogida || null,
        horario_atencion || null,
        banner_url || null,
        tagline || null,
        empresaId
      ]
    );

    // 2.4 Registrar en auditoría
    await db.query(
      `INSERT INTO tienda_auditoria (empresa_id, entidad, entidad_id, accion, actor_tipo, actor_id, detalle)
       VALUES (?, 'tienda', (SELECT id FROM tiendas WHERE empresa_id = ?), 'actualizar_perfil', 'usuario', ?, ?)`,
      [empresaId, empresaId, req.user?.id || null, JSON.stringify({ slug: cleanSlug, nombre })]
    );

    res.json({ success: true, message: "Información de la tienda actualizada correctamente.", slug: cleanSlug });
  } catch (error: any) {
    console.error("[TIENDA_ADMIN] Error actualizando tienda:", error);
    res.status(500).json({ error: error.message || "Error al actualizar la tienda." });
  }
});

// 3. Cambiar estado de la tienda (borrador -> publicada <-> pausada)
router.post("/mi-tienda/estado", async (req: any, res: any) => {
  try {
    const empresaId = getEmpresaId(req);
    const { nuevo_estado } = req.body;

    if (!["borrador", "publicada", "pausada"].includes(nuevo_estado)) {
      return res.status(400).json({ error: "Estado no válido." });
    }

    const db = pool.promise();

    // Si se desea publicar, se validan requisitos indispensables
    if (nuevo_estado === "publicada") {
      // a) Debe tener complemento vigente (o prueba activa)
      const [contratos]: any = await db.query(
        "SELECT id FROM tienda_contrataciones WHERE empresa_id = ? AND vence_en >= CURRENT_DATE() AND estado = 'vigente' LIMIT 1",
        [empresaId]
      );
      if (contratos.length === 0) {
        return res.status(403).json({ 
          error: "Para publicar tu tienda en línea necesitas tener el complemento activo o activar la prueba gratuita." 
        });
      }

      // b) Debe tener al menos 1 producto publicado visible
      const [prods]: any = await db.query(
        `SELECT COUNT(*) as total FROM tienda_publicaciones p 
         JOIN tiendas t ON p.tienda_id = t.id 
         WHERE t.empresa_id = ? AND p.visible = 1`,
        [empresaId]
      );
      if (!prods[0] || prods[0].total === 0) {
        return res.status(400).json({ 
          error: "Debes seleccionar y publicar al menos un producto en tu catálogo antes de abrir la tienda al público." 
        });
      }
    }

    await db.query("UPDATE tiendas SET estado = ? WHERE empresa_id = ?", [nuevo_estado, empresaId]);

    await db.query(
      `INSERT INTO tienda_auditoria (empresa_id, entidad, entidad_id, accion, actor_tipo, actor_id, detalle)
       VALUES (?, 'tienda', (SELECT id FROM tiendas WHERE empresa_id = ?), 'cambio_estado', 'usuario', ?, ?)`,
      [empresaId, empresaId, req.user?.id || null, JSON.stringify({ nuevo_estado })]
    );

    res.json({ success: true, message: `Estado de la tienda cambiado a '${nuevo_estado}'.` });
  } catch (error: any) {
    console.error("[TIENDA_ADMIN] Error cambiando estado:", error);
    res.status(500).json({ error: error.message || "Error al cambiar el estado de la tienda." });
  }
});

// 4. Activar prueba gratuita de 14 días para la tienda
router.post("/mi-tienda/activar-prueba", async (req: any, res: any) => {
  try {
    const empresaId = getEmpresaId(req);
    const db = pool.promise();

    // Verificar si ya disfrutó de una prueba previa
    const [previo]: any = await db.query(
      "SELECT id FROM tienda_contrataciones WHERE empresa_id = ? AND origen = 'prueba'",
      [empresaId]
    );

    if (previo.length > 0) {
      return res.status(409).json({ error: "Esta empresa ya utilizó su periodo de prueba gratuita para la Tienda Online." });
    }

    // Insertar 14 días de prueba
    await db.query(
      `INSERT INTO tienda_contrataciones (empresa_id, desde, vence_en, estado, origen, referencia, monto_centavos)
       VALUES (?, CURRENT_DATE(), DATE_ADD(CURRENT_DATE(), INTERVAL 14 DAY), 'vigente', 'prueba', ?, 0)`,
      [empresaId, `PRUEBA_TIENDA_${empresaId}_${Date.now()}`]
    );

    await db.query(
      `INSERT INTO tienda_auditoria (empresa_id, entidad, accion, actor_tipo, actor_id, detalle)
       VALUES (?, 'contratacion', 'activar_prueba_14_dias', 'usuario', ?, 'Prueba gratuita de 14 días activada')`,
      [empresaId, req.user?.id || null]
    );

    res.json({ success: true, message: "¡Prueba gratuita de 14 días activada con éxito para tu tienda en línea!" });
  } catch (error: any) {
    console.error("[TIENDA_ADMIN] Error activando prueba:", error);
    res.status(500).json({ error: error.message || "Error al activar la prueba gratuita." });
  }
});

// 5. Listar productos del inventario con su estado de publicación en la tienda
router.get("/productos", async (req: any, res: any) => {
  try {
    const empresaId = getEmpresaId(req);
    const q = String(req.query.q || "").trim();
    const soloPublicados = req.query.publicados === "1";
    const db = pool.promise();

    // Obtener id de la tienda
    const [tiendas]: any = await db.query("SELECT id FROM tiendas WHERE empresa_id = ?", [empresaId]);
    if (tiendas.length === 0) {
      return res.json({ productos: [] });
    }
    const tiendaId = tiendas[0].id;

    let sql = `
      SELECT p.id, p.referencia, p.nombre, p.categoria, p.precio_venta, p.cantidad,
             pub.id as publicacion_id,
             pub.visible as publicado,
             pub.titulo as titulo_publico,
             pub.descripcion_publica,
             pub.orden
      FROM productos p
      LEFT JOIN tienda_publicaciones pub ON pub.producto_id = p.id AND pub.tienda_id = ?
      WHERE p.empresa_id = ?
    `;
    const params: any[] = [tiendaId, empresaId];

    if (q) {
      sql += " AND (LOCATE(?, p.nombre) > 0 OR LOCATE(?, p.referencia) > 0 OR LOCATE(?, p.categoria) > 0)";
      params.push(q, q, q);
    }

    if (soloPublicados) {
      sql += " AND pub.id IS NOT NULL AND pub.visible = 1";
    }

    sql += " ORDER BY pub.id IS NOT NULL DESC, p.nombre ASC LIMIT 100";

    const [productos]: any = await db.query(sql, params);

    res.json({ productos });
  } catch (error: any) {
    console.error("[TIENDA_ADMIN] Error consultando productos:", error);
    res.status(500).json({ error: error.message || "Error al listar productos para la tienda." });
  }
});

// 6. Publicar o retirar un producto de la tienda (Toggle)
router.post("/publicaciones/toggle", async (req: any, res: any) => {
  try {
    const empresaId = getEmpresaId(req);
    const productoId = Number(req.body?.producto_id);
    const publicar = Boolean(req.body?.publicar);

    if (!Number.isSafeInteger(productoId) || productoId < 1) {
      return res.status(400).json({ error: "producto_id inválido." });
    }

    const db = pool.promise();

    // Verificar que el producto pertenece a la empresa
    const [prod]: any = await db.query("SELECT id, nombre FROM productos WHERE id = ? AND empresa_id = ?", [productoId, empresaId]);
    if (prod.length === 0) {
      return res.status(404).json({ error: "Producto no encontrado en tu inventario." });
    }

    // Obtener id de la tienda
    const [tienda]: any = await db.query("SELECT id FROM tiendas WHERE empresa_id = ?", [empresaId]);
    if (tienda.length === 0) {
      return res.status(404).json({ error: "Primero debes configurar tu tienda." });
    }
    const tiendaId = tienda[0].id;

    if (publicar) {
      // Inserción idempotente
      await db.query(
        `INSERT INTO tienda_publicaciones (tienda_id, empresa_id, producto_id, titulo, visible)
         VALUES (?, ?, ?, ?, 1)
         ON DUPLICATE KEY UPDATE visible = 1`,
        [tiendaId, empresaId, productoId, prod[0].nombre]
      );
    } else {
      // Retirar publicación
      await db.query(
        "DELETE FROM tienda_publicaciones WHERE tienda_id = ? AND producto_id = ?",
        [tiendaId, productoId]
      );
    }

    res.json({ success: true, publicado: publicar });
  } catch (error: any) {
    console.error("[TIENDA_ADMIN] Error en toggle de producto:", error);
    res.status(500).json({ error: error.message || "Error al modificar la publicación." });
  }
});

// 7. Editar detalles públicos del producto en la tienda
router.put("/publicaciones/:productoId", async (req: any, res: any) => {
  try {
    const empresaId = getEmpresaId(req);
    const productoId = Number(req.params.productoId);
    const { titulo, descripcion_publica, orden, visible } = req.body;

    const db = pool.promise();
    const [tienda]: any = await db.query("SELECT id FROM tiendas WHERE empresa_id = ?", [empresaId]);
    if (tienda.length === 0) return res.status(404).json({ error: "Tienda no encontrada" });

    const tiendaId = tienda[0].id;

    await db.query(
      `UPDATE tienda_publicaciones 
       SET titulo = ?, descripcion_publica = ?, orden = COALESCE(?, orden), visible = COALESCE(?, visible)
       WHERE tienda_id = ? AND producto_id = ?`,
      [titulo || null, descripcion_publica || null, orden ?? null, visible !== undefined ? (visible ? 1 : 0) : null, tiendaId, productoId]
    );

    res.json({ success: true, message: "Detalles de publicación actualizados." });
  } catch (error: any) {
    console.error("[TIENDA_ADMIN] Error actualizando publicación:", error);
    res.status(500).json({ error: error.message || "Error al actualizar publicación." });
  }
});

// 8. Listar pedidos web de la empresa (Bandeja de pedidos del POS)
router.get("/pedidos", async (req: any, res: any) => {
  try {
    const empresaId = getEmpresaId(req);
    const db = pool.promise();

    const estado = String(req.query.estado || "").trim();
    const q = String(req.query.q || "").trim();
    const pagina = Math.max(1, parseInt(String(req.query.pagina || "1"), 10) || 1);
    const limite = Math.min(50, Math.max(1, parseInt(String(req.query.limite || "20"), 10) || 20));
    const offset = (pagina - 1) * limite;

    let whereSql = "WHERE p.empresa_id = ?";
    const params: any[] = [empresaId];

    if (estado) {
      whereSql += " AND p.estado = ?";
      params.push(estado);
    }

    if (q) {
      whereSql += " AND (p.codigo_orden LIKE ? OR p.cliente_nombre LIKE ? OR p.cliente_telefono LIKE ?)";
      const like = `%${q}%`;
      params.push(like, like, like);
    }

    const [countRows]: any = await db.query(
      `SELECT COUNT(*) as total FROM tienda_pedidos p ${whereSql}`,
      params
    );
    const total = Number(countRows[0]?.total || 0);

    const [pedidos]: any = await db.query(
      `SELECT p.*,
              (SELECT COUNT(*) FROM tienda_pedido_items pi WHERE pi.pedido_id = p.id) as cantidad_items
       FROM tienda_pedidos p
       ${whereSql}
       ORDER BY p.id DESC
       LIMIT ? OFFSET ?`,
      [...params, limite, offset]
    );

    // Adjuntar items a cada pedido para visualización rápida
    if (pedidos.length > 0) {
      const pedidoIds = pedidos.map((p: any) => p.id);
      const [itemsRows]: any = await db.query(
        `SELECT pi.id, pi.pedido_id, pi.producto_id, pi.titulo_historico, pi.precio_unitario, pi.cantidad, pi.subtotal
         FROM tienda_pedido_items pi
         WHERE pi.pedido_id IN (?)
         ORDER BY pi.id ASC`,
        [pedidoIds]
      );

      const itemsPorPedido = new Map<number, any[]>();
      for (const item of itemsRows) {
        if (!itemsPorPedido.has(item.pedido_id)) itemsPorPedido.set(item.pedido_id, []);
        itemsPorPedido.get(item.pedido_id)!.push(item);
      }

      for (const pedido of pedidos) {
        pedido.items = itemsPorPedido.get(pedido.id) || [];
      }
    }

    // Contadores por estado para badges de la interfaz
    const [stats]: any = await db.query(
      `SELECT estado, COUNT(*) as cantidad 
       FROM tienda_pedidos 
       WHERE empresa_id = ? 
       GROUP BY estado`,
      [empresaId]
    );

    const contadores: Record<string, number> = {
      pendientes: 0,
      comprobante_enviado: 0,
      confirmados: 0,
      preparando: 0,
      listo_recogida: 0,
      entregados: 0,
      cancelados: 0
    };
    for (const s of stats) {
      if (s.estado === "pendiente") contadores.pendientes = Number(s.cantidad);
      else if (s.estado === "comprobante_enviado") contadores.comprobante_enviado = Number(s.cantidad);
      else if (s.estado === "confirmado") contadores.confirmados = Number(s.cantidad);
      else if (s.estado === "preparando") contadores.preparando = Number(s.cantidad);
      else if (s.estado === "listo_recogida") contadores.listo_recogida = Number(s.cantidad);
      else if (s.estado === "entregado") contadores.entregados = Number(s.cantidad);
      else if (s.estado === "cancelado") contadores.cancelados = Number(s.cantidad);
    }

    res.json({
      ok: true,
      pedidos,
      contadores,
      paginacion: {
        total,
        pagina,
        paginas: Math.ceil(total / limite) || 1,
        limite
      }
    });
  } catch (error: any) {
    console.error("[TIENDA_ADMIN] Error consultando pedidos:", error);
    res.status(500).json({ error: error.message || "Error al consultar pedidos web." });
  }
});

// 9. Actualizar estado de un pedido (Transición autorizada con liberación o consolidación de stock)
router.put("/pedidos/:id/estado", async (req: any, res: any) => {
  let conn: any = null;
  try {
    const empresaId = getEmpresaId(req);
    const pedidoId = parseInt(String(req.params.id), 10);
    const { nuevo_estado } = req.body;

    const estadosValidos = [
      "pendiente",
      "comprobante_enviado",
      "confirmado",
      "preparando",
      "listo_recogida",
      "entregado",
      "cancelado"
    ];

    if (!estadosValidos.includes(nuevo_estado)) {
      return res.status(400).json({ error: `Estado no válido. Opciones: ${estadosValidos.join(", ")}` });
    }

    conn = await pool.promise().getConnection();
    await conn.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
    await conn.beginTransaction();

    // 9.1 Bloquear pedido y verificar que pertenece a la empresa
    const [pedidos]: any = await conn.query(
      `SELECT id, empresa_id, estado, codigo_orden 
       FROM tienda_pedidos 
       WHERE id = ? AND empresa_id = ? 
       FOR UPDATE`,
      [pedidoId, empresaId]
    );

    if (!pedidos || pedidos.length === 0) {
      await conn.rollback();
      return res.status(404).json({ error: "Pedido no encontrado o no pertenece a tu comercio." });
    }

    const pedido = pedidos[0];
    const estadoAnterior = pedido.estado;

    if (estadoAnterior === nuevo_estado) {
      await conn.rollback();
      return res.json({ success: true, message: "El pedido ya se encuentra en ese estado." });
    }

    // 9.2 Tratamiento especial al cancelar: Reintegrar stock y liberar reserva
    const siguientes: Record<string,string[]> = {
      pendiente:["confirmado","cancelado"], comprobante_enviado:["confirmado","cancelado"],
      confirmado:["preparando","listo_recogida","cancelado"], preparando:["listo_recogida","cancelado"],
      listo_recogida:["entregado","cancelado"]
    };
    if (!siguientes[estadoAnterior]?.includes(nuevo_estado)) {
      await conn.rollback();
      return res.status(409).json({error:`No se puede pasar de ${estadoAnterior} a ${nuevo_estado}.`});
    }
    if (nuevo_estado === "cancelado") {
      await liberarStockPedido(conn,pedidoId,empresaId,pedido.codigo_orden,"cancelada");
    }

    // 9.3 Tratamiento especial al entregar: Consolidar reserva
    if (nuevo_estado === "entregado") {
      await conn.query(
        "UPDATE tienda_reservas SET estado = 'consolidada' WHERE pedido_id = ? AND empresa_id = ? AND estado='activa'",
        [pedidoId, empresaId]
      );
    }

    // 9.4 Actualizar estado del pedido
    await conn.query(
      "UPDATE tienda_pedidos SET estado = ? WHERE id = ? AND empresa_id = ?",
      [nuevo_estado, pedidoId, empresaId]
    );

    // 9.5 Registrar en auditoría
    await conn.query(
      `INSERT INTO tienda_auditoria (empresa_id, entidad, entidad_id, accion, actor_tipo, actor_id, detalle)
       VALUES (?, 'pedido', ?, 'cambio_estado', 'usuario', ?, ?)`,
      [
        empresaId,
        pedidoId,
        req.user?.id || null,
        JSON.stringify({ estado_anterior: estadoAnterior, nuevo_estado })
      ]
    );

    await conn.commit();

    // 9.6 Emitir actualización por Socket.IO a la sala del comercio
    try {
      const io = req.app.get("io");
      if (io) {
        io.to(`empresa_${empresaId}`).emit("pedido_estado_actualizado", {
          pedido_id: pedidoId,
          codigo_orden: pedido.codigo_orden,
          nuevo_estado
        });
      }
    } catch (socketErr) {
      // Ignorar fallo no crítico
    }

    res.json({
      success: true,
      message: `Pedido ${pedido.codigo_orden} actualizado a estado "${nuevo_estado}".`,
      nuevo_estado
    });
  } catch (error: any) {
    if (conn) await conn.rollback();
    console.error("[TIENDA_ADMIN] Error actualizando estado de pedido:", error);
    res.status(500).json({ error: error.message || "Error al actualizar estado del pedido." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
