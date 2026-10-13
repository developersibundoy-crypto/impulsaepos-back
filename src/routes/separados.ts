import express from "express";
import pool from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";
import { centavos, distribuirAbono, distribuirDevolucion, registrarAbono, rastreoSeparados, normalizarHistorico, obtenerTurnoAbono, resumenFlujo } from "../services/separadosCaja";

const router = express.Router();

// Middleware de seguridad
router.use(verifyTokenAndTenant);

// GET historial global de abonos con filtros por fecha, búsqueda de cliente y estadísticas
router.get("/historial-abonos", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { fecha, fecha_inicio, fecha_fin, search, cliente_id } = req.query;

  try {
    let whereClause = "WHERE a.empresa_id = ?";
    const params: any[] = [empresa_id];

    if (fecha) {
      whereClause += " AND DATE(a.fecha_pago) = ?";
      params.push(fecha);
    } else if (fecha_inicio && fecha_fin) {
      whereClause += " AND DATE(a.fecha_pago) BETWEEN ? AND ?";
      params.push(fecha_inicio, fecha_fin);
    } else if (fecha_inicio) {
      whereClause += " AND DATE(a.fecha_pago) >= ?";
      params.push(fecha_inicio);
    } else if (fecha_fin) {
      whereClause += " AND DATE(a.fecha_pago) <= ?";
      params.push(fecha_fin);
    }

    if (cliente_id) {
      whereClause += " AND s.cliente_id = ?";
      params.push(cliente_id);
    }

    if (search) {
      whereClause += " AND (c.nombre LIKE ? OR c.documento LIKE ? OR CAST(s.id AS CHAR) LIKE ?)";
      const term = `%${search}%`;
      params.push(term, term, term);
    }

    const queryAbonos = `
      SELECT 
        a.id,
        a.separado_id,
        a.monto,
        a.metodo_pago,
        a.pago_efectivo, a.pago_transferencia,
        a.fecha_pago,
        s.cliente_id,
        c.nombre as cliente_nombre,
        c.documento as cliente_documento,
        c.telefono as cliente_telefono,
        ca.nombre as cajero_nombre,
        s.total as separado_total,
        (CASE WHEN s.estado = 'Anulado' THEN 0 ELSE s.saldo_pendiente END) as saldo_pendiente,
        s.estado as separado_estado,
        (SELECT COALESCE(SUM(monto),0) FROM abonos_separados x WHERE x.separado_id = s.id AND x.empresa_id = s.empresa_id) AS neto_abonado,
        (SELECT COALESCE(SUM(-monto),0) FROM abonos_separados x WHERE x.separado_id = s.id AND x.empresa_id = s.empresa_id AND x.monto < 0) AS total_devuelto,
        s.fecha_creacion as separado_fecha_creacion,
        s.fecha_vencimiento as separado_fecha_vencimiento
      FROM abonos_separados a
      JOIN separados s ON a.separado_id = s.id AND a.empresa_id = s.empresa_id
      LEFT JOIN clientes c ON s.cliente_id = c.id
      LEFT JOIN cajeros ca ON a.cajero_id = ca.id
      ${whereClause}
      ORDER BY a.fecha_pago DESC, a.id DESC
    `;

    const [abonos]: any = await pool.promise().query(queryAbonos, params);

    // Consulta de métricas globales de separados de la empresa
    const queryMetricas = `
      SELECT 
        COUNT(id) as total_separados_registrados,
        COALESCE(SUM(total), 0) as valor_total_separados,
        COALESCE(SUM(CASE WHEN estado = 'Pendiente' THEN saldo_pendiente ELSE 0 END), 0) as saldo_total_pendiente,
        (SELECT COALESCE(SUM(monto),0) FROM abonos_separados WHERE empresa_id = ?) as total_recaudado_historico,
        COUNT(CASE WHEN estado = 'Pendiente' THEN 1 END) as total_separados_activos,
        COALESCE(SUM(CASE WHEN estado = 'Pendiente' THEN saldo_pendiente ELSE 0 END), 0) as saldo_pendiente_activos
      FROM separados
      WHERE empresa_id = ?
    `;

    const [metricasRes]: any = await pool.promise().query(queryMetricas, [empresa_id, empresa_id]);
    const rastreo = await rastreoSeparados(pool.promise(), empresa_id);
    const porId = new Map(rastreo.map((a: any) => [a.id, a]));

    const historial = abonos.map((a: any) => ({ ...a, ...(porId.get(a.id) as any),
      pendiente_devolucion: a.separado_estado === 'Anulado' ? Math.max(0, Number(a.neto_abonado)) : 0 }));
    res.json({
      abonos: historial,
      resumen_flujo_filtrado: resumenFlujo(historial),
      resumen_global: metricasRes[0] || {}
    });
  } catch (error: any) {
    console.error("Error al consultar historial de abonos:", error);
    res.status(500).json({ error: "Error al consultar historial de abonos" });
  }
});

// GET all separados
router.get("/", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const sql = `
    SELECT s.*, c.nombre as cliente_nombre, c.documento as cliente_documento, ca.nombre as cajero_nombre
    FROM separados s
    LEFT JOIN clientes c ON s.cliente_id = c.id
    LEFT JOIN cajeros ca ON s.cajero_id = ca.id
    WHERE s.empresa_id = ?
    ORDER BY s.fecha_creacion DESC
  `;
  pool.query(sql, [empresa_id], (err: any, results: any) => {
    if (err) return res.status(500).json({ error: "Error obteniendo separados" });
    res.json(results);
  });
});

// GET separados by cliente_id
router.get("/cliente/:cliente_id", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { cliente_id } = req.params;
  const sql = `
    SELECT s.*, c.nombre as cliente_nombre, c.documento as cliente_documento, ca.nombre as cajero_nombre
    FROM separados s
    LEFT JOIN clientes c ON s.cliente_id = c.id
    LEFT JOIN cajeros ca ON s.cajero_id = ca.id
    WHERE s.empresa_id = ? AND s.cliente_id = ?
    ORDER BY s.fecha_creacion DESC
  `;
  pool.query(sql, [empresa_id, cliente_id], (err: any, results: any) => {
    if (err) return res.status(500).json({ error: "Error obteniendo separados del cliente" });
    res.json(results);
  });
});

// GET one separado and its abonos
router.get("/:id", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;
  pool.query(`
    SELECT s.*, c.nombre as cliente_nombre, c.documento as cliente_documento, ca.nombre as cajero_nombre
    FROM separados s 
    LEFT JOIN clientes c ON s.cliente_id = c.id 
    LEFT JOIN cajeros ca ON s.cajero_id = ca.id
    WHERE s.id = ? AND s.empresa_id = ?
  `, [id, empresa_id], (err: any, sepRes: any) => {
    if (err || sepRes.length === 0) return res.status(404).json({ error: "No encontrado" });
    
    const abonosSql = `
      SELECT a.*, c.nombre as cajero_nombre, a.fecha_pago as fecha_abono
      FROM abonos_separados a
      LEFT JOIN cajeros c ON a.cajero_id = c.id
      WHERE a.separado_id = ? AND a.empresa_id = ? 
      ORDER BY a.fecha_pago ASC
    `;
    pool.query(abonosSql, [id, empresa_id], (err2: any, abonosRes: any) => {
      if (err2) return res.status(500).json({ error: 'Error obteniendo abonos' });
      const normalizados = (abonosRes || []).map(normalizarHistorico);
      const flujo = resumenFlujo(normalizados);
      res.json({
        separado: { ...sepRes[0], neto_abonado: flujo.neto_nominal, total_devuelto: flujo.devuelto_nominal,
          pendiente_devolucion: sepRes[0].estado === 'Anulado' ? Math.max(0, flujo.neto_nominal) : 0 },
        abonos: normalizados,
        resumen_flujo: flujo
      });
    });
  });
});

// POST new separado (Con Reserva de Stock Inmediata y Aislamiento SaaS)
router.post("/", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { cliente_id, detalles, total, abono_inicial } = req.body;
  
  if (!cliente_id || !detalles || total === undefined) {
    return res.status(400).json({ error: "Faltan datos obligatorios: cliente, productos o total." });
  }

  const promisePool = pool.promise();
  const conn = await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    centavos(total);
    centavos(abono_inicial || 0);
    if (!Number.isFinite(Number(total)) || Number(total) <= 0 ||
        !Number.isFinite(Number(abono_inicial || 0)) || Number(abono_inicial || 0) < 0 || Number(abono_inicial || 0) > Number(total)) {
      throw new Error('Total o abono inicial inválido');
    }
    const saldo_pendiente = (centavos(total) - centavos(abono_inicial || 0)) / 100;

    // 1. Crear el registro del Separado (Privado por empresa_id)
    const [sepResult]: any = await conn.query(
      "INSERT INTO separados (empresa_id, cliente_id, cajero_id, total, saldo_pendiente, detalles_json, estado) VALUES (?, ?, ?, ?, ?, ?, 'Pendiente')",
      [
        empresa_id, 
        cliente_id, 
        req.user.cajero_id || req.body.cajero_id || null,
        total, 
        saldo_pendiente, 
        JSON.stringify(detalles)
      ]
    );
    const separadoId = sepResult.insertId;

    // 2. Reservar Stock de cada producto del carrito
    for (const item of detalles) {
      const qty = parseInt(item.qty || item.cantidad || 0);
      if (qty <= 0) continue;

      // Bloquear fila de producto filtrando SIEMPRE por empresa_id (SaaS Privacy)
      const [pData]: any = await conn.query(
        "SELECT cantidad, es_servicio, nombre FROM productos WHERE id = ? AND empresa_id = ? FOR UPDATE", 
        [item.id, empresa_id]
      );
      
      if (pData.length === 0) throw new Error(`El producto con ID ${item.id} no existe en su inventario.`);
      
      const producto = pData[0];
      if (!producto.es_servicio) {
        if (producto.cantidad < qty) {
          throw new Error(`Stock insuficiente para reservar "${producto.nombre}". Disponible: ${producto.cantidad}, Solicitado: ${qty}`);
        }

        // Descontar inmediatamente para "Apartar" el producto físicamente del inventario disponible
        await conn.query(
          "UPDATE productos SET cantidad = cantidad - ? WHERE id = ? AND empresa_id = ?", 
          [qty, item.id, empresa_id]
        );

        // Registrar Reserva en Kardex (Privacidad SaaS)
        await conn.query(
          "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, referencia) VALUES (?, ?, 'SALIDA', ?, ?, ?, ?, ?)",
          [item.id, empresa_id, producto.cantidad, qty, producto.cantidad - qty, 'Apartado por Separado', `SEP-${separadoId}`]
        );
      }
    }

    // 3. Registrar Abono Inicial si fue entregado
    if (abono_inicial && parseFloat(abono_inicial) > 0) {
      await registrarAbono(conn, req, separadoId, Number(abono_inicial), distribuirAbono(abono_inicial, req.body));
    }

    await conn.commit();
    // Notificar por Socket.io
    if (req.io) {
       req.io.to(`empresa_${empresa_id}`).emit('separado_created', { id: separadoId, cliente_id });
    }

    res.status(201).json({ 
        success: true, 
        message: "¡Separado registrado y stock reservado con éxito!", 
        separado_id: separadoId 
    });

  } catch (error: any) {
    await conn.rollback();
    console.error(`[ERROR SEPARADOS][EMPRESA ${empresa_id}]:`, error.message);
    res.status(400).json({ error: error.message || "Fallo técnico al procesar el separado." });
  } finally {
    conn.release();
  }
});

// POST abono a separado (Atómico y Seguro)
router.post("/:id/abonos", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;
  const { monto } = req.body;

  if (!monto || monto <= 0) return res.status(400).json({ error: "Monto de abono inválido" });

  const promisePool = pool.promise();
  const conn = await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    // Bloquear el separado para evitar doble abono simultáneo
    const [results]: any = await conn.query("SELECT saldo_pendiente, estado FROM separados WHERE id = ? AND empresa_id = ? FOR UPDATE", [id, empresa_id]);
    
    if (results.length === 0) throw new Error("Separado no encontrado");
    
    const { saldo_pendiente, estado } = results[0];
    if (estado !== "Pendiente") throw new Error(`El separado no admite abonos porque está ${estado}`);
    if (Number(monto) > Number(saldo_pendiente)) throw new Error(`El abono (${monto}) supera el saldo pendiente (${saldo_pendiente})`);
    
    // 1. Insertar Registro de Abono Detallado
    await registrarAbono(conn, req, id, Number(monto), distribuirAbono(monto, req.body));
    
    // 2. Actualizar Saldo atómicamente
    await conn.query("UPDATE separados SET saldo_pendiente = saldo_pendiente - ? WHERE id = ? AND empresa_id = ?", [monto, id, empresa_id]);

    await conn.commit();
    
    // Notificar por Socket
    if (req.io) {
       req.io.to(`empresa_${empresa_id}`).emit('abono_added', { separado_id: id, monto });
    }

    res.json({ success: true, message: "Abono registrado correctamente", nuevo_saldo: (centavos(saldo_pendiente) - centavos(monto)) / 100 });

  } catch (error: any) {
    await conn.rollback();
    res.status(400).json({ error: error.message });
  } finally {
    conn.release();
  }
});

// PUT update separado (Agregar más productos o modificar cantidades)
router.put("/:id", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;
  const { detalles, total } = req.body;

  if (!detalles || total === undefined) {
    return res.status(400).json({ error: "Faltan datos obligatorios: productos o total." });
  }

  const promisePool = pool.promise();
  const conn = await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Obtener el separado actual para comparar stock
    const [sepResults]: any = await conn.query("SELECT * FROM separados WHERE id = ? AND empresa_id = ? FOR UPDATE", [id, empresa_id]);
    if (sepResults.length === 0) throw new Error("Separado no encontrado");
    const separado = sepResults[0];

    if (separado.estado !== "Pendiente") throw new Error("No se puede editar un separado que no esté pendiente");

    const oldDetalles = typeof separado.detalles_json === 'string' ? JSON.parse(separado.detalles_json) : separado.detalles_json;

    // 2. Ajustar stock (Comparar old vs new por producto)
    const allProductIds = new Set([
      ...oldDetalles.map((p: any) => p.id),
      ...detalles.map((p: any) => p.id)
    ]);

    for (const prodId of Array.from(allProductIds) as number[]) {
      const oldItem = oldDetalles.find((p: any) => p.id === prodId);
      const newItem = detalles.find((p: any) => p.id === prodId);

      const oldQty = oldItem ? (oldItem.qty || oldItem.cantidad || 0) : 0;
      const newQty = newItem ? (newItem.qty || newItem.cantidad || 0) : 0;

      const delta = newQty - oldQty;

      if (delta === 0) continue;

      // Consultar stock actual
      const [pData]: any = await conn.query(
        "SELECT cantidad, es_servicio, nombre FROM productos WHERE id = ? AND empresa_id = ? FOR UPDATE", 
        [prodId, empresa_id]
      );

      if (pData.length === 0) throw new Error(`El producto con ID ${prodId} no existe en su inventario.`);
      const producto = pData[0];

      if (!producto.es_servicio) {
        if (delta > 0 && producto.cantidad < delta) {
          throw new Error(`Stock insuficiente para "${producto.nombre}". Disponible: ${producto.cantidad}, Necesario adicional: ${delta}`);
        }

        // Actualizar stock
        await conn.query(
          "UPDATE productos SET cantidad = cantidad - ? WHERE id = ? AND empresa_id = ?", 
          [delta, prodId, empresa_id]
        );

        // Registrar en Kardex
        const tipoMov = delta > 0 ? 'SALIDA' : 'ENTRADA';
        const cantMod = Math.abs(delta);

        await conn.query(
          "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
          [prodId, empresa_id, tipoMov, producto.cantidad, cantMod, producto.cantidad - delta, 'Edición de Separado (Ajuste)', `SEP-${id}`]
        );
      }
    }

    // 3. Recalcular saldo pendiente basado en el nuevo total y abonos previos
    const [abonosRes]: any = await conn.query("SELECT SUM(monto) as total_abonos FROM abonos_separados WHERE separado_id = ? AND empresa_id = ?", [id, empresa_id]);
    const totalAbonos = parseFloat(abonosRes[0].total_abonos) || 0;
    const newSaldo = (centavos(total) - centavos(totalAbonos)) / 100;

    if (newSaldo < 0) throw new Error("El nuevo total no puede ser inferior a los abonos ya realizados.");

    // 4. Actualizar el registro
    await conn.query(
      "UPDATE separados SET total = ?, saldo_pendiente = ?, detalles_json = ? WHERE id = ? AND empresa_id = ?",
      [total, newSaldo, JSON.stringify(detalles), id, empresa_id]
    );

    await conn.commit();
    
    if (req.io) {
       req.io.to(`empresa_${empresa_id}`).emit('separado_updated', { id });
    }

    res.json({ success: true, message: "Separado actualizado y stock ajustado correctamente." });

  } catch (error: any) {
    await conn.rollback();
    console.error("Error editando separado:", error);
    res.status(400).json({ error: error.message });
  } finally {
    conn.release();
  }
});

// PUT completar separado (Convertir Reserva en Venta Final)
router.put("/:id/completar", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;
  const { cajero_id } = req.body;

  const promisePool = pool.promise();
  const conn = await promisePool.getConnection();
  
  try {
    await conn.beginTransaction();

    // 1. Validar estado (Bloquear transacción)
    const [sepResults]: any = await conn.query("SELECT * FROM separados WHERE id = ? AND empresa_id = ? FOR UPDATE", [id, empresa_id]);
    if (sepResults.length === 0) throw new Error("Separado no encontrado");
    const separado = sepResults[0];

    if (separado.estado !== "Pendiente") throw new Error("Este separado ya ha sido procesado o anulado");
    if (separado.saldo_pendiente > 0) throw new Error(`Aún queda un saldo de ${separado.saldo_pendiente}. Liquídalo antes de facturar.`);

    const items = typeof separado.detalles_json === 'string' ? JSON.parse(separado.detalles_json) : separado.detalles_json;

    // 2. Crear Factura Final de Venta
    const [fRes]: any = await conn.query(
      "INSERT INTO facturas_venta (empresa_id, cajero_id, cliente_id, total, metodo_pago, pago_efectivo, pago_transferencia) VALUES (?, ?, ?, ?, ?, ?, ?)", 
      [empresa_id, req.user.cajero_id || cajero_id || null, separado.cliente_id, separado.total, 'Separado', 0, 0]
    );
    const facturaId = fRes.insertId;

    // 3. Registrar detalles (Sin descontar stock de nuevo, ya se descontó al reservar)
    for (const item of items) {
      const qty = item.qty || item.cantidad;
      const [pData]: any = await conn.query("SELECT precio_compra FROM productos WHERE id = ? AND empresa_id = ?", [item.id, empresa_id]);
      const costo = pData[0]?.precio_compra || 0;

      await conn.query(
        "INSERT INTO ventas (empresa_id, factura_id, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?, ?)", 
        [empresa_id, facturaId, item.id, qty, item.precio_venta, costo]
      );

      // Solo registro en Kardex que la reserva se convirtió en factura
      await conn.query(
        "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, referencia) VALUES (?, ?, 'SALIDA', 0, 0, 0, ?, ?)",
        [item.id, empresa_id, `Conversión Separado SEP-${id} a Venta`, `FS-${facturaId}`]
      );
    }

    // 4. Marcar Separado como Pagado
    await conn.query("UPDATE separados SET estado = 'Pagado', saldo_pendiente = 0 WHERE id = ? AND empresa_id = ?", [id, empresa_id]);

    await conn.commit();

    // Notificar por Socket
    if (req.io) {
       req.io.to(`empresa_${empresa_id}`).emit('separado_updated', { id, estado: 'Pagado' });
    }

    res.json({ success: true, message: "Separado facturado con éxito", factura_id: facturaId });

  } catch (error: any) {
    await conn.rollback();
    console.error("Error completando separado:", error);
    res.status(400).json({ error: error.message || "Error procesando el cierre de separado" });
  } finally {
    conn.release();
  }
});

// Función central para anular separado, devolver dinero (impactando cierre de caja) y registrar en Kardex con auditor
async function anularSeparadoConDevolucion(req: any, res: any) {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;
  const { motivo, usuario_nombre } = req.body || {};
  const auditor_nombre = usuario_nombre || req.user.username || 'Usuario';
  const motivo_anulacion = motivo || 'Anulación de separado y devolución de dinero';

  const promisePool = pool.promise();
  const conn = await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    const [sepResults]: any = await conn.query("SELECT * FROM separados WHERE id = ? AND empresa_id = ? FOR UPDATE", [id, empresa_id]);
    if (sepResults.length === 0) throw new Error("Separado no encontrado");
    const separado = sepResults[0];

    // 1. Calcular dinero abonado por el cliente hasta la fecha
    const clave = String(req.body.operacion_id || '');
    const turnoSolicitado = Number(req.body.sesion_caja_id);
    if (!Number.isSafeInteger(turnoSolicitado) || !new RegExp(`^${Number(id)}\\.${turnoSolicitado}\\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$`).test(clave)) {
      throw new Error('Identificador de devolución y turno obligatorios');
    }
    const prefijo = `DEVOLUCION_SEPARADO:${clave}:`;
    const [previas]: any = await conn.query(`SELECT m.descripcion, m.usuario_id FROM movimientos_caja m
      JOIN sesiones_caja sc ON sc.id = m.sesion_caja_id AND sc.empresa_id = m.empresa_id AND sc.usuario_id = m.usuario_id
      WHERE m.empresa_id = ? AND m.sesion_caja_id = ? AND m.monto = 0 AND m.tipo = 'Ingreso'
      AND BINARY LEFT(m.descripcion, ?) = BINARY ?`, [empresa_id, turnoSolicitado, prefijo.length, prefijo]);
    if (previas.length) {
      if (previas.length !== 1 || Number(previas[0].usuario_id) !== Number(req.user.id)) throw new Error('Operación no pertenece al usuario');
      const anterior = JSON.parse(previas[0].descripcion.slice(prefijo.length));
      if (anterior.ef !== centavos(req.body.devolucion_efectivo || 0) || anterior.tr !== centavos(req.body.devolucion_transferencia || 0)) throw new Error('La clave ya fue usada con otros importes');
      await conn.commit();
      return res.json({ ...anterior.respuesta, reintento: true });
    }
    const turno = await obtenerTurnoAbono(conn, req);
    if (Number(turno.id) !== turnoSolicitado) throw new Error('El turno solicitado no es el turno abierto del usuario');
    const [abonosRes]: any = await conn.query(
      `SELECT COALESCE(SUM(monto), 0) as total_abonado
        FROM abonos_separados WHERE separado_id = ? AND empresa_id = ?`,
      [id, empresa_id]
    );

    const totalAbonado = parseFloat(abonosRes[0]?.total_abonado) || 0;
    if (req.body.devolucion_efectivo === undefined && req.body.devolucion_transferencia === undefined) throw new Error('Indique monto y medio real de devolución');
    if (totalAbonado < 0 || (totalAbonado === 0 && (centavos(req.body.devolucion_efectivo || 0) !== 0 || centavos(req.body.devolucion_transferencia || 0) !== 0))) throw new Error('No hay remanente nominal para esa devolución');

    if (separado.estado !== "Pendiente" && !(separado.estado === "Anulado" && totalAbonado > 0)) {
      throw new Error(`No se puede anular un separado que está ${separado.estado} y no tiene abonos pendientes por devolver.`);
    }

    let dineroDevuelto = 0;
    // 2. Registrar únicamente el dinero realmente devuelto; permite saldar devoluciones parciales.
    if (totalAbonado > 0) {
      const dev = distribuirDevolucion(totalAbonado, 0, 0, req.body || {});
      dineroDevuelto = dev.monto;
      await registrarAbono(conn, req, id, -dev.monto, {
        metodo: dev.metodo, efectivo: -dev.efectivo, transferencia: -dev.transferencia
      });
    }

    // 3. Liberar Stock de cada ítem solo si estaba Pendiente (para evitar duplicar si ya fue anulado)
    if (separado.estado === "Pendiente") {
      const items = typeof separado.detalles_json === 'string' ? JSON.parse(separado.detalles_json) : separado.detalles_json;
      if (Array.isArray(items)) {
        for (const item of items) {
          const qty = item.qty || item.cantidad;
          const [pData]: any = await conn.query("SELECT cantidad, es_servicio FROM productos WHERE id = ? AND empresa_id = ? FOR UPDATE", [item.id, empresa_id]);

          if (pData.length > 0 && !pData[0].es_servicio) {
             const stock_antes = pData[0].cantidad;
             await conn.query("UPDATE productos SET cantidad = cantidad + ? WHERE id = ? AND empresa_id = ?", [qty, item.id, empresa_id]);

             // Registrar Liberación en Kardex incluyendo usuario_nombre (quién eliminó)
             await conn.query(
               "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, 'ENTRADA', ?, ?, ?, ?, ?, ?)",
               [item.id, empresa_id, stock_antes, qty, stock_antes + qty, `Anulación Separado: ${motivo_anulacion}`, auditor_nombre, `SEP-${id}-ANUL`]
             );
          }
        }
      }
    }

    // 4. Marcar separado como Anulado y saldo_pendiente = 0
    await conn.query("UPDATE separados SET estado = 'Anulado', saldo_pendiente = 0 WHERE id = ? AND empresa_id = ?", [id, empresa_id]);

    const respuesta = { success: true,
      message: `Separado anulado. Devolución registrada: $${dineroDevuelto}. Pendiente por devolver: $${(centavos(totalAbonado) - centavos(dineroDevuelto)) / 100}.`,
      dinero_devuelto: dineroDevuelto, pendiente_devolucion: (centavos(totalAbonado) - centavos(dineroDevuelto)) / 100 };
    await conn.query("INSERT INTO movimientos_caja (empresa_id, usuario_id, sesion_caja_id, tipo, monto, descripcion) VALUES (?, ?, ?, 'Ingreso', 0, ?)",
      [empresa_id, req.user.id, turno.id, prefijo + JSON.stringify({ ef: centavos(req.body.devolucion_efectivo || 0), tr: centavos(req.body.devolucion_transferencia || 0), respuesta })]);
    await conn.commit();

    // Notificar por Socket
    if (req.io) {
       try { req.io.to(`empresa_${empresa_id}`).emit('separado_updated', { id, estado: 'Anulado' }); }
       catch (error) { console.error('Devolución confirmada; notificación pendiente', error); }
    }

    res.json(respuesta);

  } catch (error: any) {
    await conn.rollback();
    res.status(400).json({ error: error.message });
  } finally {
    conn.release();
  }
}

// PUT anular separado (Liberar Reserva de Stock y devolver dinero)
router.put("/:id/anular", anularSeparadoConDevolucion);

// DELETE separado (Alias para anulación con devolución y trazabilidad)
router.delete("/:id", anularSeparadoConDevolucion);

export default router;

