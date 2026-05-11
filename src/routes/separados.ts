import express from "express";
import pool from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

// Middleware de seguridad
router.use(verifyTokenAndTenant);

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
      res.json({
        separado: sepRes[0],
        abonos: abonosRes || []
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

    const saldo_pendiente = parseFloat(total) - (parseFloat(abono_inicial) || 0);

    // 1. Crear el registro del Separado (Privado por empresa_id)
    const [sepResult]: any = await conn.query(
      "INSERT INTO separados (empresa_id, cliente_id, cajero_id, total, saldo_pendiente, detalles_json, estado) VALUES (?, ?, ?, ?, ?, ?, 'Pendiente')",
      [
        empresa_id, 
        cliente_id, 
        req.body.cajero_id || null, 
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
      const initMetodo = req.body.metodo_pago || 'Efectivo';
      const initEfec = req.body.pago_efectivo || (initMetodo === 'Efectivo' ? abono_inicial : 0);
      const initTrans = req.body.pago_transferencia || (initMetodo === 'Transferencia' ? abono_inicial : 0);

      const initCajero = req.body.cajero_id || null;

      await conn.query(
        "INSERT INTO abonos_separados (empresa_id, separado_id, cajero_id, monto, metodo_pago, pago_efectivo, pago_transferencia) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [empresa_id, separadoId, initCajero, abono_inicial, initMetodo, initEfec, initTrans]
      );
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
    if (monto > saldo_pendiente) throw new Error(`El abono (${monto}) supera el saldo pendiente (${saldo_pendiente})`);
    
    // 1. Insertar Registro de Abono Detallado
    const met = req.body.metodo_pago || 'Efectivo';
    const efec = req.body.pago_efectivo || (met === 'Efectivo' ? monto : 0);
    const trans = req.body.pago_transferencia || (met === 'Transferencia' ? monto : 0);

    const cajId = req.body.cajero_id || null;

    await conn.query(
      "INSERT INTO abonos_separados (empresa_id, separado_id, cajero_id, monto, metodo_pago, pago_efectivo, pago_transferencia) VALUES (?, ?, ?, ?, ?, ?, ?)", 
      [empresa_id, id, cajId, monto, met, efec, trans]
    );
    
    // 2. Actualizar Saldo atómicamente
    await conn.query("UPDATE separados SET saldo_pendiente = saldo_pendiente - ? WHERE id = ? AND empresa_id = ?", [monto, id, empresa_id]);

    await conn.commit();
    
    // Notificar por Socket
    if (req.io) {
       req.io.to(`empresa_${empresa_id}`).emit('abono_added', { separado_id: id, monto });
    }

    res.json({ success: true, message: "Abono registrado correctamente", nuevo_saldo: saldo_pendiente - monto });

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
    const newSaldo = parseFloat(total) - totalAbonos;

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
  const { cajero_id, metodo_pago, pago_efectivo, pago_transferencia } = req.body; 

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
      [empresa_id, cajero_id || null, separado.cliente_id, separado.total, metodo_pago || "Efectivo", pago_efectivo || 0, pago_transferencia || 0]
    );
    const facturaId = fRes.insertId;

    // 3. Registrar detalles (Sin descontar stock de nuevo, ya se descontó al reservar)
    for (const item of items) {
      const qty = item.qty || item.cantidad;
      const [pData]: any = await conn.query("SELECT precio_compra FROM productos WHERE id = ?", [item.id]);
      const costo = pData[0]?.precio_compra || 0;

      await conn.query(
        "INSERT INTO ventas (empresa_id, factura_id, producto_id, cantidad, precio_unitario, costo_unitario) VALUES (?, ?, ?, ?, ?, ?)", 
        [empresa_id, facturaId, item.id, qty, item.precio_venta, costo]
      );

      // Solo registro en Kardex que la reserva se convirtió en factura
      await conn.query(
        "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, referencia) VALUES (?, ?, 'SALIDA', 0, 0, 0, ?, ?)",
        [item.id, empresa_id, 'Conversión Separado a Venta', `FS-${facturaId}`]
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

// PUT anular separado (Liberar Reserva de Stock)
router.put("/:id/anular", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;
  const { motivo } = req.body;

  const promisePool = pool.promise();
  const conn = await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    const [sepResults]: any = await conn.query("SELECT * FROM separados WHERE id = ? AND empresa_id = ? FOR UPDATE", [id, empresa_id]);
    if (sepResults.length === 0) throw new Error("Separado no encontrado");
    const separado = sepResults[0];

    if (separado.estado !== "Pendiente") throw new Error("No se puede anular un separado que ya no está pendiente");

    const items = typeof separado.detalles_json === 'string' ? JSON.parse(separado.detalles_json) : separado.detalles_json;

    // Liberar Stock de cada ítem
    for (const item of items) {
      const qty = item.qty || item.cantidad;
      const [pData]: any = await conn.query("SELECT cantidad, es_servicio FROM productos WHERE id = ? FOR UPDATE", [item.id]);
      
      if (pData.length > 0 && !pData[0].es_servicio) {
         const stock_antes = pData[0].cantidad;
         await conn.query("UPDATE productos SET cantidad = cantidad + ? WHERE id = ? AND empresa_id = ?", [qty, item.id, empresa_id]);
         
         // Registrar Liberación en Kardex
         await conn.query(
           "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, referencia) VALUES (?, ?, 'ENTRADA', ?, ?, ?, ?, ?)",
           [item.id, empresa_id, stock_antes, qty, stock_antes + qty, `Anulación Separado: ${motivo || 'Sin detalle'}`, `SEP-${id}-ANUL`]
         );
      }
    }

    await conn.query("UPDATE separados SET estado = 'Anulado' WHERE id = ? AND empresa_id = ?", [id, empresa_id]);

    await conn.commit();

    // Notificar por Socket
    if (req.io) {
       req.io.to(`empresa_${empresa_id}`).emit('separado_updated', { id, estado: 'Anulado' });
    }

    res.json({ success: true, message: "Separado anulado y stock liberado correctamente" });

  } catch (error: any) {
    await conn.rollback();
    res.status(500).json({ error: error.message });
  } finally {
    conn.release();
  }
});

export default router;

