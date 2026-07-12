import express from "express";
import pool from "../conection";
import { verifyTokenAndTenant, verifyPermission } from "../middlewares/authMiddleware";
import puntosService from "../services/puntosService";

const router = express.Router();

// Middleware de seguridad básico
router.use(verifyTokenAndTenant);

// Realizar una venta - Requiere permiso de venta
router.post("/", verifyPermission("venta"), async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { items, metodoPago, cajeroId, clienteId, total, iva, efectivoEntregado, transferenciaEntregada, vuelto } = req.body;
  
  if (!items || items.length === 0) return res.status(400).json({ error: "Carrito vacío" });

  const promisePool = pool.promise();
  let conn;

  try {
    conn = await promisePool.getConnection();
    await conn.beginTransaction();

    // 0. Consultar configuración específica de la empresa
    const [configs]: any = await conn.query(
      "SELECT permitir_venta_negativa FROM empresa_config WHERE empresa_id = ?", 
      [empresa_id]
    );
    const permitirNegativoGlobal = configs && configs[0] ? !!configs[0].permitir_venta_negativa : true;

    // Priorizamos el cajero_id del token (usuario logueado) para evitar selección manual errónea
    const cId = req.user.cajero_id || ((cajeroId && !isNaN(parseInt(cajeroId))) ? parseInt(cajeroId) : null);
    const clId = (clienteId && !isNaN(parseInt(clienteId))) ? parseInt(clienteId) : null;

    // --- NUEVO: Obtener porcentaje de comisión del cajero para desglose itemizado ---
    let percComision = 0;
    if (cId) {
      const [cData]: any = await conn.query("SELECT paga_comisiones, porcentaje_comision FROM cajeros WHERE id = ?", [cId]);
      if (cData.length > 0 && cData[0].paga_comisiones) {
        percComision = parseFloat(cData[0].porcentaje_comision) || 0;
      }
    }
    
    // Cálculo de ingreso neto real en efectivo (restando el vuelto)
    const vlt = parseFloat(vuelto) || 0;
    const pefRaw = parseFloat(efectivoEntregado) || 0;
    const pef = Math.max(0, pefRaw - vlt); 
    const ptr = parseFloat(transferenciaEntregada) || 0;
    const ivaVal = Math.round((parseFloat(iva) || 0) * 100) / 100;
    const totalVal = Math.round((parseFloat(total) || 0) * 100) / 100;

    // 1. Insertar Cabecera de Factura
    const [resCab]: any = await conn.query(
      "INSERT INTO facturas_venta (empresa_id, cajero_id, cliente_id, total, iva, metodo_pago, pago_efectivo, pago_transferencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [empresa_id, cId, clId, totalVal, ivaVal, metodoPago, pef, ptr]
    );
    const facturaId = resCab.insertId;

    // --- NUEVO: Automatización Cuentas por Cobrar (CxC) ---
    const totalPagado = pef + ptr;
    const saldoPendiente = Math.round((totalVal - totalPagado) * 100) / 100;
    
    if ((metodoPago === 'Credito' || saldoPendiente > 0) && clId) {
      const saldoFinal = saldoPendiente > 0 ? saldoPendiente : totalVal;
      await conn.query(
        "INSERT INTO cuentas_por_cobrar (empresa_id, factura_venta_id, cliente_id, monto_total, saldo_pendiente, estado) VALUES (?, ?, ?, ?, ?, ?)",
        [empresa_id, facturaId, clId, totalVal, saldoFinal, 'Pendiente']
      );
    }
    // --------------------------------------------------------

    // 2. Insertar Detalles y Actualizar Inventario
    for (const item of items) {
      if (!item.id || !item.qty) {
        throw new Error("Datos de producto inválidos en el carrito.");
      }

      // Validar stock antes de vender (si no es servicio y no se permite negativo)
      const [prodData]: any = await conn.query(
        "SELECT cantidad, es_servicio, permitir_venta_negativa, precio_compra, nombre FROM productos WHERE id = ? AND empresa_id = ?",
        [item.id, empresa_id]
      );

      if (prodData.length === 0) {
        throw new Error(`Producto ${item.id} no encontrado.`);
      }

      const producto = prodData[0];
      const permitirNegativoProd = !!producto.permitir_venta_negativa;
      const stockDisponible = producto.cantidad;
      const esServicio = !!producto.es_servicio;

      // Solo bloquear si no es servicio Y no se permite negativo (global o por producto)
      if (!esServicio && !permitirNegativoGlobal && !permitirNegativoProd) {
        if (stockDisponible < item.qty) {
          throw new Error(`Stock insuficiente para: ${producto.nombre}. Disponible: ${stockDisponible}`);
        }
      }

      // --- CÁLCULO DE COMISIÓN ITEMIZADA ---
      const subtotalItem = item.precio_venta * item.qty;
      const comisionItem = Math.round((subtotalItem * (percComision / 100)) * 100) / 100;

      // Insertar detalle de venta con comisión calculada
      await conn.query(
        "INSERT INTO ventas (empresa_id, factura_id, producto_id, cantidad, precio_unitario, costo_unitario, comision) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [empresa_id, facturaId, item.id, item.qty, item.precio_venta, producto.precio_compra || 0, comisionItem]
      );

      // Actualizar Stock (Restar para productos, Sumar para servicios como acumulador de uso si fuera necesario, pero aquí restamos por defecto)
      // Ajuste: Para servicios, generalmente no se resta stock físico, pero el sistema puede llevar un conteo.
      const stockChange = esServicio ? 0 : item.qty;
      if (stockChange !== 0) {
        await conn.query(
          "UPDATE productos SET cantidad = cantidad - ? WHERE id = ? AND empresa_id = ?",
          [stockChange, item.id, empresa_id]
        );

        // Registrar en Kardex
        const usuario_venta = req.user.username || 'Cajero';
        await conn.query(
          "INSERT INTO kardex (empresa_id, producto_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            empresa_id, 
            item.id, 
            'SALIDA', 
            stockDisponible, 
            -item.qty, 
            stockDisponible - item.qty, 
            `Venta POS / Factura: ${facturaId}`, 
            usuario_venta, 
            `FAC-${facturaId}`
          ]
        );
      }
    }

    await conn.commit();

    // ─────────────────────────────────────────────────────────────────────────
    // SISTEMA DE PUNTOS: Acumular puntos usando el service financiero
    // ─────────────────────────────────────────────────────────────────────────
    let puntos_info = null;
    let puntos_error: string | null = null;
    if (clId && clId !== 1) {
      try {
        const result = await puntosService.acumular(
          empresa_id,
          clId,
          totalVal,
          items,
          facturaId,
          "POS",
          req.io
        );

        if (result) {
          puntos_info = {
            puntosAntes: result.puntos_totales - result.puntos_ganados,
            puntosGanados: result.puntos_ganados,
            puntosDespues: result.puntos_totales,
            meta: result.puntos_totales,
            premio: "",
            gano_premio: false,
            descuento_puntos: result.descuento_puntos,
            puntos_redimidos: result.puntos_redimidos,
          };
        }
      } catch (puntosError: any) {
        puntos_error = puntosError?.message || "Error desconocido acumulando puntos.";
        console.error("[PUNTOS] Error acumulando puntos (no crítico):", puntos_error);
      }
    }

    res.status(201).json({ success: true, factura_id: facturaId, puntos_info, puntos_error });

  } catch (error: any) {
    if (conn) await conn.rollback();
    console.error("Error en procesamiento de venta:", error);
    res.status(500).json({ error: error.message || "Error al procesar la venta" });
  } finally {
    if (conn) conn.release();
  }
});


// Listar facturas de venta - Requiere permiso de facturas_venta
router.get("/", verifyPermission("facturas_venta"), (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;
  const search = req.query.search as string || "";
  const filtro = req.query.filtro as string || "Todas";
  const tipo_factura = req.query.tipo_factura as string || "Todas";

  let fromClause = "";
  const queryParams: any[] = [];

  if (tipo_factura === "POS") {
    fromClause = `
      (
        SELECT 
          fv.id,
          fv.fecha,
          fv.total,
          fv.iva,
          fv.metodo_pago,
          fv.pago_efectivo,
          fv.pago_transferencia,
          fv.cliente_id,
          'POS' AS tipo_factura,
          NULL AS prefijo,
          NULL AS consecutivo,
          c.nombre AS cajero,
          cl.nombre AS cliente,
          cl.telefono,
          fv.empresa_id
        FROM facturas_venta fv
        LEFT JOIN cajeros c ON fv.cajero_id = c.id
        LEFT JOIN clientes cl ON fv.cliente_id = cl.id
        WHERE fv.empresa_id = ?
      ) f
    `;
    queryParams.push(empresa_id);
  } else if (tipo_factura === "ELECTRONICA") {
    fromClause = `
      (
        SELECT 
          fe.id,
          fe.fecha_emision AS fecha,
          fe.total,
          fe.iva,
          fe.metodo_pago,
          fe.pago_efectivo,
          fe.pago_transferencia,
          fe.cliente_id,
          'ELECTRONICA' AS tipo_factura,
          fe.prefijo,
          fe.consecutivo,
          c.nombre AS cajero,
          cl.nombre AS cliente,
          cl.telefono,
          fe.empresa_id
        FROM facturas_electronicas fe
        LEFT JOIN cajeros c ON fe.cajero_id = c.id
        LEFT JOIN clientes cl ON fe.cliente_id = cl.id
        WHERE fe.empresa_id = ?
      ) f
    `;
    queryParams.push(empresa_id);
  } else {
    fromClause = `
      (
        SELECT 
          fv.id,
          fv.fecha,
          fv.total,
          fv.iva,
          fv.metodo_pago,
          fv.pago_efectivo,
          fv.pago_transferencia,
          fv.cliente_id,
          'POS' AS tipo_factura,
          NULL AS prefijo,
          NULL AS consecutivo,
          c.nombre AS cajero,
          cl.nombre AS cliente,
          cl.telefono,
          fv.empresa_id
        FROM facturas_venta fv
        LEFT JOIN cajeros c ON fv.cajero_id = c.id
        LEFT JOIN clientes cl ON fv.cliente_id = cl.id
        WHERE fv.empresa_id = ?

        UNION ALL

        SELECT 
          fe.id,
          fe.fecha_emision AS fecha,
          fe.total,
          fe.iva,
          fe.metodo_pago,
          fe.pago_efectivo,
          fe.pago_transferencia,
          fe.cliente_id,
          'ELECTRONICA' AS tipo_factura,
          fe.prefijo,
          fe.consecutivo,
          c.nombre AS cajero,
          cl.nombre AS cliente,
          cl.telefono,
          fe.empresa_id
        FROM facturas_electronicas fe
        LEFT JOIN cajeros c ON fe.cajero_id = c.id
        LEFT JOIN clientes cl ON fe.cliente_id = cl.id
        WHERE fe.empresa_id = ?
      ) f
    `;
    queryParams.push(empresa_id, empresa_id);
  }

  let whereClause = "WHERE 1=1";

  if (search) {
    whereClause += " AND (f.cliente LIKE ? OR CAST(f.id AS CHAR) LIKE ? OR CONCAT(COALESCE(f.prefijo, ''), COALESCE(f.consecutivo, '')) LIKE ? OR f.cajero LIKE ?)";
    const searchPattern = `%${search}%`;
    queryParams.push(searchPattern, searchPattern, searchPattern, searchPattern);
  }

  if (filtro === "Efectivo") {
    whereClause += " AND f.metodo_pago = 'Efectivo'";
  } else if (filtro === "Transferencia") {
    whereClause += " AND f.metodo_pago = 'Transferencia'";
  }

  const countQuery = `
    SELECT COUNT(*) as total 
    FROM ${fromClause}
    ${whereClause}
  `;

  const dataQuery = `
    SELECT f.*
    FROM ${fromClause}
    ${whereClause}
    ORDER BY f.fecha DESC
    LIMIT ? OFFSET ?
  `;

  pool.query(countQuery, queryParams, (err: any, countRes: any) => {
    if (err) return res.status(500).json({ error: err.message });
    const total = countRes[0].total;

    pool.query(dataQuery, [...queryParams, limit, offset], (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        data: results,
        total: total,
        page: page,
        last_page: Math.ceil(total / limit)
      });
    });
  });
});

router.get("/:id", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const tipo = req.query.tipo as string;

  if (tipo === "ELECTRONICA") {
    const query = `
      SELECT v.cantidad, v.precio_unitario, p.nombre, p.referencia 
      FROM ventas_electronicas v
      JOIN facturas_electronicas fe ON v.factura_electronica_id = fe.id
      JOIN productos p ON v.producto_id = p.id
      WHERE v.factura_electronica_id = ? AND fe.empresa_id = ?
    `;
    pool.query(query, [req.params.id, empresa_id], (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(results);
    });
  } else {
    const query = `
      SELECT v.cantidad, v.precio_unitario, p.nombre, p.referencia 
      FROM ventas v
      JOIN productos p ON v.producto_id = p.id
      WHERE v.factura_id = ? AND v.empresa_id = ?
    `;
    pool.query(query, [req.params.id, empresa_id], (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(results);
    });
  }
});

// Anular factura - Requiere permiso de facturas_venta
router.delete("/:id", verifyPermission("facturas_venta"), async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const facturaId = req.params.id;
  const tipo = req.query.tipo as string;
  const { motivo_anulacion, usuario_nombre } = req.body || {};
  const auditor_nombre = usuario_nombre || req.user.username || 'System';

  const promisePool = pool.promise();
  const conn = await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    if (tipo === "ELECTRONICA") {
      // 1. Obtener los ítems de la venta para devolver stock (Electrónica)
      const [items]: any = await conn.query(
        "SELECT producto_id, cantidad FROM ventas_electronicas v JOIN facturas_electronicas fe ON v.factura_electronica_id = fe.id WHERE v.factura_electronica_id = ? AND fe.empresa_id = ? FOR UPDATE", 
        [facturaId, empresa_id]
      );

      if (items.length > 0) {
        for (const item of items) {
          // Consultar tipo de producto (bloqueado para evitar colisiones)
          const [pData]: any = await conn.query("SELECT es_servicio, cantidad FROM productos WHERE id = ? FOR UPDATE", [item.producto_id]);
          
          if (pData.length > 0) {
            const esServicio = !!pData[0].es_servicio;
            const stock_antes = pData[0].cantidad;

            if (!esServicio) {
              // Revertir stock solo si era producto físico
              await conn.query("UPDATE productos SET cantidad = cantidad + ? WHERE id = ? AND empresa_id = ?", [item.cantidad, item.producto_id, empresa_id]);
            }

            // Registrar en Kardex la anulación para trazabilidad
            const stock_despues = esServicio ? stock_antes : (stock_antes + item.cantidad);
            const movType = esServicio ? 'ANULACIÓN_SERVICIO' : 'ANULACIÓN';
            await conn.query(
              "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [item.producto_id, empresa_id, movType, stock_antes, item.cantidad, stock_despues, `Anulación: ${motivo_anulacion || 'Sin motivo'}`, auditor_nombre, `FE-${facturaId}-ANUL`]
            );
          }
        }
      }

      // 2. Eliminar detalles y cabecera (Electrónica)
      await conn.query("DELETE FROM ventas_electronicas WHERE factura_electronica_id = ?", [facturaId]);
      await conn.query("DELETE FROM facturas_electronicas WHERE id = ? AND empresa_id = ?", [facturaId, empresa_id]);

    } else {
      // 1. Obtener los ítems de la venta para devolver stock (POS)
      const [items]: any = await conn.query(
        "SELECT producto_id, cantidad FROM ventas WHERE factura_id = ? AND empresa_id = ? FOR UPDATE", 
        [facturaId, empresa_id]
      );

      if (items.length > 0) {
        for (const item of items) {
          // Consultar tipo de producto (bloqueado para evitar colisiones)
          const [pData]: any = await conn.query("SELECT es_servicio, cantidad FROM productos WHERE id = ? FOR UPDATE", [item.producto_id]);
          
          if (pData.length > 0) {
            const esServicio = !!pData[0].es_servicio;
            const stock_antes = pData[0].cantidad;

            if (!esServicio) {
              // Revertir stock solo si era producto físico
              await conn.query("UPDATE productos SET cantidad = cantidad + ? WHERE id = ? AND empresa_id = ?", [item.cantidad, item.producto_id, empresa_id]);
            }

            // Registrar en Kardex la anulación para trazabilidad
            const stock_despues = esServicio ? stock_antes : (stock_antes + item.cantidad);
            const movType = esServicio ? 'ANULACIÓN_SERVICIO' : 'ANULACIÓN';
            await conn.query(
              "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
              [item.producto_id, empresa_id, movType, stock_antes, item.cantidad, stock_despues, `Anulación: ${motivo_anulacion || 'Sin motivo'}`, auditor_nombre, `F-${facturaId}-ANUL`]
            );
          }
        }
      }

      // 2. Eliminar detalles y cabecera (POS)
      await conn.query("DELETE FROM ventas WHERE factura_id = ? AND empresa_id = ?", [facturaId, empresa_id]);
      await conn.query("DELETE FROM facturas_venta WHERE id = ? AND empresa_id = ?", [facturaId, empresa_id]);
    }

    await conn.commit();
    res.json({ success: true, message: "Factura anulada y stock devuelto con trazabilidad en Kardex." });

  } catch (error: any) {
    if (conn) await conn.rollback();
    console.error("Error al anular factura:", error);
    res.status(500).json({ error: "No se pudo anular la factura: " + error.message });
  } finally {
    if (conn) conn.release();
  }
});

export default router;

