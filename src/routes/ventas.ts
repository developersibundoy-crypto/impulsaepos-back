import express from "express";
import pool from "../conection";
import { verifyTokenAndTenant, verifyPermission } from "../middlewares/authMiddleware";
import puntosService from "../services/puntosService";
import { centavos } from "../services/separadosCaja";

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
      const [cData]: any = await conn.query("SELECT paga_comisiones, porcentaje_comision_base, meta_comision, porcentaje_comision_meta FROM cajeros WHERE id = ?", [cId]);
      if (cData.length > 0 && cData[0].paga_comisiones) {
        const cashier = cData[0];
        const meta = parseFloat(cashier.meta_comision) || 0;
        
        if (meta > 0) {
          const [ventasMes]: any = await conn.query(`
            SELECT COALESCE(SUM(total), 0) as total_mes FROM facturas_venta 
            WHERE cajero_id = ? AND empresa_id = ? AND MONTH(fecha) = MONTH(CURRENT_DATE()) AND YEAR(fecha) = YEAR(CURRENT_DATE())
          `, [cId, empresa_id]);
          const [ventasElec]: any = await conn.query(`
            SELECT COALESCE(SUM(total), 0) as total_mes FROM facturas_electronicas 
            WHERE cajero_id = ? AND empresa_id = ? AND MONTH(fecha_emision) = MONTH(CURRENT_DATE()) AND YEAR(fecha_emision) = YEAR(CURRENT_DATE())
          `, [cId, empresa_id]);
          
          const acumulado = parseFloat(ventasMes[0].total_mes) + parseFloat(ventasElec[0].total_mes);
          const totalVentaActual = parseFloat(total) || 0;
          
          if (acumulado + totalVentaActual > meta) {
             percComision = parseFloat(cashier.porcentaje_comision_meta) || 0;
          } else {
             percComision = parseFloat(cashier.porcentaje_comision_base) || 0;
          }
        } else {
          percComision = parseFloat(cashier.porcentaje_comision_base) || 0;
        }
      }
    }
    
    // Cálculo de ingreso neto real según método de pago
    const vlt = parseFloat(vuelto) || 0;
    const pefRaw = parseFloat(efectivoEntregado) || 0;
    const ptrRaw = parseFloat(transferenciaEntregada) || 0;
    const ivaVal = Math.round((parseFloat(iva) || 0) * 100) / 100;
    const totalVal = Math.round((parseFloat(total) || 0) * 100) / 100;

    let pef = 0;
    let ptr = 0;

    if (metodoPago === 'Efectivo') {
      pef = pefRaw > 0 ? Math.min(totalVal, Math.max(0, pefRaw - vlt)) : totalVal;
      ptr = 0;
    } else if (metodoPago === 'Transferencia' || metodoPago === 'Tarjeta' || metodoPago === 'Addi' || metodoPago === 'Sistecredito') {
      ptr = ptrRaw > 0 ? ptrRaw : totalVal;
      pef = 0;
    } else if (metodoPago === 'Credito') {
      pef = Math.max(0, pefRaw - vlt);
      ptr = ptrRaw;
    } else if (metodoPago === 'Mixto') {
      pef = Math.max(0, pefRaw - vlt);
      ptr = ptrRaw;
      if (pef === 0 && ptr === 0) {
        pef = totalVal;
      }
    } else {
      if (pefRaw > 0 || ptrRaw > 0) {
        pef = Math.max(0, pefRaw - vlt);
        ptr = ptrRaw;
      } else {
        pef = totalVal;
      }
    }

    // 1. Insertar Cabecera de Factura
    const [resCab]: any = await conn.query(
      "INSERT INTO facturas_venta (empresa_id, cajero_id, cliente_id, total, iva, metodo_pago, pago_efectivo, pago_transferencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [empresa_id, cId, clId, totalVal, ivaVal, metodoPago, pef, ptr]
    );
    const facturaId = resCab.insertId;

    // --- NUEVO: Automatización Cuentas por Cobrar (CxC) ---
    const totalPagado = pef + ptr;
    const saldoPendiente = Math.round((totalVal - totalPagado) * 100) / 100;
    
    // Solo registrar CxC si es venta a crédito explícita o si es Mixto con saldo restante pendiente
    if ((metodoPago === 'Credito' || (metodoPago === 'Mixto' && saldoPendiente > 0.01)) && clId) {
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
  } else if (filtro === "Tarjeta") {
    whereClause += " AND f.metodo_pago = 'Tarjeta'";
  } else if (filtro === "Addi") {
    whereClause += " AND f.metodo_pago = 'Addi'";
  } else if (filtro === "Sistecredito") {
    whereClause += " AND f.metodo_pago = 'Sistecredito'";
  } else if (filtro === "Separado") {
    whereClause += " AND f.tipo_factura = 'POS' AND (f.metodo_pago = 'Separado' OR EXISTS (SELECT 1 FROM kardex k WHERE k.empresa_id = f.empresa_id AND k.referencia = CONCAT('FS-', f.id) AND k.motivo = 'Conversión Separado a Venta'))";
  }

  const countQuery = `
    SELECT COUNT(*) as total 
    FROM ${fromClause}
    ${whereClause}
  `;

  const dataQuery = `
    SELECT f.*, (f.tipo_factura = 'POS' AND (f.metodo_pago = 'Separado' OR EXISTS
      (SELECT 1 FROM kardex k WHERE k.empresa_id = f.empresa_id AND k.referencia = CONCAT('FS-', f.id)
      AND k.motivo = 'Conversión Separado a Venta'))) AS origen_separado
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
      SELECT v.producto_id, v.cantidad, v.precio_unitario, p.nombre, p.referencia 
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
      SELECT v.producto_id, v.cantidad, v.precio_unitario, p.nombre, p.referencia 
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
  const auditor_nombre = usuario_nombre || req.user.nombre || req.user.username || 'Admin';

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
      const [origenSeparado]: any = await conn.query(`SELECT id FROM facturas_venta fv WHERE fv.id = ? AND fv.empresa_id = ?
        AND (fv.metodo_pago = 'Separado' OR EXISTS (SELECT 1 FROM kardex k WHERE k.empresa_id = fv.empresa_id
          AND k.referencia = CONCAT('FS-', fv.id) AND k.motivo = 'Conversión Separado a Venta')) FOR UPDATE`, [facturaId, empresa_id]);
      if (origenSeparado.length) {
        await conn.rollback();
        return res.status(409).json({ error: 'Factura de separado: conserve su trazabilidad. Use cambio de producto con el medio real del ajuste; no se admite borrado de esta factura.' });
      }
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

// Registrar un cambio de producto en factura POS
router.post("/cambio-producto", verifyPermission("venta"), async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { 
    factura_id, 
    producto_devuelto_id, 
    producto_nuevo_id, 
    cantidad_devuelta, 
    cantidad_nueva,
    valor_original, 
    valor_nuevo, 
    saldo_adicional, 
    metodo_pago 
  } = req.body;
  
  const cId = req.user.cajero_id || null;
  const usuario_nombre = req.user.username || 'Sistema';

  if (!factura_id || !producto_devuelto_id || !producto_nuevo_id || !cantidad_devuelta || !cantidad_nueva) {
    return res.status(400).json({ error: "Datos incompletos para procesar el cambio." });
  }

  const promisePool = pool.promise();
  let conn;

  try {
    conn = await promisePool.getConnection();
    await conn.beginTransaction();

    // 1. Validar que la factura es POS y pertenece a la empresa
    const [factura]: any = await conn.query(
      `SELECT id, (metodo_pago = 'Separado' OR EXISTS (SELECT 1 FROM kardex k WHERE k.empresa_id = fv.empresa_id
        AND k.referencia = CONCAT('FS-', fv.id) AND k.motivo = 'Conversión Separado a Venta')) AS es_separado
        FROM facturas_venta fv WHERE id = ? AND empresa_id = ? FOR UPDATE`,
      [factura_id, empresa_id]
    );

    if (factura.length === 0) {
      throw new Error("La factura original no existe o no es de tipo POS.");
    }

    // 2. Validar que el producto devuelto está en la factura
    const [ventaDetalle]: any = await conn.query(
      "SELECT id, cantidad, precio_unitario FROM ventas WHERE factura_id = ? AND producto_id = ? AND empresa_id = ?",
      [factura_id, producto_devuelto_id, empresa_id]
    );

    if (ventaDetalle.length === 0) {
      throw new Error("El producto devuelto no pertenece a esta factura.");
    }

    // 3. Reemplazar el producto en la factura: actualizar la fila en `ventas` con nueva cantidad y precio
    await conn.query(
      "UPDATE ventas SET producto_id = ?, cantidad = ?, precio_unitario = ?, costo_unitario = (SELECT COALESCE(precio_compra, 0) FROM productos WHERE id = ?) WHERE id = ? AND empresa_id = ?",
      [producto_nuevo_id, cantidad_nueva, valor_nuevo, producto_nuevo_id, ventaDetalle[0].id, empresa_id]
    );

    // 4. Actualizar el total de la factura y los importes de pago correspondientes
    const cantDev = parseFloat(cantidad_devuelta) || 1;
    const cantNue = parseFloat(cantidad_nueva) || 1;
    const totalDevuelto = cantDev * (parseFloat(ventaDetalle[0].precio_unitario) || 0);
    const totalNuevo = cantNue * (parseFloat(valor_nuevo) || 0);
    const diferenciaCalculada = totalNuevo - totalDevuelto;
    let diferenciaFinal = saldo_adicional !== undefined && saldo_adicional !== null && !isNaN(Number(saldo_adicional))
      ? parseFloat(saldo_adicional)
      : diferenciaCalculada;
    if (factura[0].es_separado) {
      if (!['Efectivo', 'Transferencia', 'Tarjeta', 'Addi', 'Sistecredito'].includes(metodo_pago)) throw new Error('Indique el medio real del ajuste de separado');
      if (!Number.isSafeInteger(cantDev) || !Number.isSafeInteger(cantNue) || cantDev <= 0 || cantNue <= 0 || cantDev !== Number(ventaDetalle[0].cantidad)) throw new Error('El cambio de separado debe reemplazar la cantidad completa de la línea');
      const deltaCentavos = cantNue * centavos(valor_nuevo) - cantDev * centavos(ventaDetalle[0].precio_unitario);
      if (saldo_adicional !== undefined && saldo_adicional !== null && centavos(saldo_adicional) !== deltaCentavos) throw new Error('El ajuste monetario no coincide con los productos');
      diferenciaFinal = deltaCentavos / 100;
    }

    if (diferenciaFinal !== 0) {
      const esTransferencia = metodo_pago === 'Transferencia' || metodo_pago === 'Tarjeta' || metodo_pago === 'Addi' || metodo_pago === 'Sistecredito';
      if (esTransferencia) {
        await conn.query(
          "UPDATE facturas_venta SET total = GREATEST(0, total + ?), pago_transferencia = GREATEST(0, pago_transferencia + ?) WHERE id = ? AND empresa_id = ?",
          [diferenciaFinal, diferenciaFinal, factura_id, empresa_id]
        );
      } else {
        await conn.query(
          "UPDATE facturas_venta SET total = GREATEST(0, total + ?), pago_efectivo = GREATEST(0, pago_efectivo + ?) WHERE id = ? AND empresa_id = ?",
          [diferenciaFinal, diferenciaFinal, factura_id, empresa_id]
        );
      }
    }

    // 5. Consultar y aumentar stock del producto devuelto
    const [pDevueltoData]: any = await conn.query(
      "SELECT cantidad, es_servicio FROM productos WHERE id = ? AND empresa_id = ? FOR UPDATE", 
      [producto_devuelto_id, empresa_id]
    );
    
    if (pDevueltoData.length > 0 && !pDevueltoData[0].es_servicio) {
      const stockAntesD = pDevueltoData[0].cantidad;
      await conn.query("UPDATE productos SET cantidad = cantidad + ? WHERE id = ? AND empresa_id = ?", [cantidad_devuelta, producto_devuelto_id, empresa_id]);
      
      await conn.query(
        "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, 'ENTRADA_CAMBIO', ?, ?, ?, ?, ?, ?)",
        [producto_devuelto_id, empresa_id, stockAntesD, cantidad_devuelta, stockAntesD + cantidad_devuelta, `Devolución por cambio. Factura: ${factura_id}`, usuario_nombre, `FCAMBIO-${factura_id}`]
      );
    }

    // 4. Consultar y disminuir stock del producto nuevo
    const [pNuevoData]: any = await conn.query(
      "SELECT cantidad, es_servicio, permitir_venta_negativa, nombre FROM productos WHERE id = ? AND empresa_id = ? FOR UPDATE", 
      [producto_nuevo_id, empresa_id]
    );

    if (pNuevoData.length === 0) {
      throw new Error("El producto nuevo no existe.");
    }

    if (!pNuevoData[0].es_servicio) {
      // 0. Consultar configuración específica de la empresa
      const [configs]: any = await conn.query(
        "SELECT permitir_venta_negativa FROM empresa_config WHERE empresa_id = ?", 
        [empresa_id]
      );
      const permitirNegativoGlobal = configs && configs[0] ? !!configs[0].permitir_venta_negativa : true;
      const permitirNegativoProd = !!pNuevoData[0].permitir_venta_negativa;
      const stockAntesN = pNuevoData[0].cantidad;

      if (!permitirNegativoGlobal && !permitirNegativoProd && stockAntesN < cantidad_nueva) {
        throw new Error(`Stock insuficiente para: ${pNuevoData[0].nombre}. Disponible: ${stockAntesN}`);
      }

      await conn.query("UPDATE productos SET cantidad = cantidad - ? WHERE id = ? AND empresa_id = ?", [cantidad_nueva, producto_nuevo_id, empresa_id]);
      
      await conn.query(
        "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, 'SALIDA_CAMBIO', ?, ?, ?, ?, ?, ?)",
        [producto_nuevo_id, empresa_id, stockAntesN, -cantidad_nueva, stockAntesN - cantidad_nueva, `Entrega por cambio. Factura: ${factura_id}`, usuario_nombre, `FCAMBIO-${factura_id}`]
      );
    }

    // 5. Registrar el cambio
    await conn.query(
      `INSERT INTO cambios_factura 
      (empresa_id, factura_original_id, cajero_id, producto_devuelto_id, producto_nuevo_id, cantidad_devuelta, cantidad_nueva, valor_original, valor_nuevo, saldo_adicional, metodo_pago) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [empresa_id, factura_id, cId, producto_devuelto_id, producto_nuevo_id, cantidad_devuelta, cantidad_nueva, valor_original, valor_nuevo, factura[0].es_separado ? diferenciaFinal : saldo_adicional, metodo_pago || 'Efectivo']
    );

    await conn.commit();
    res.json({ success: true, message: "Cambio registrado correctamente. El saldo adicional se ha asignado a la caja del cajero actual." });

  } catch (error: any) {
    if (conn) await conn.rollback();
    console.error("Error al registrar cambio:", error);
    res.status(500).json({ error: "No se pudo registrar el cambio: " + error.message });
  } finally {
    if (conn) conn.release();
  }
});

export default router;

