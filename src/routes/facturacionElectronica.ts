import express from "express";
import pool from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";
import { enviarFacturaADian } from "../services/dianService";

const router = express.Router();

// Middleware de seguridad
router.use(verifyTokenAndTenant);

// --- PROCESAR FACTURA ELECTRÓNICA ---
router.post("/emitir", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { items, metodoPago, cajeroId, clienteId, total, iva, notas } = req.body;

  if (!items || items.length === 0) return res.status(400).json({ error: "Carrito vacío" });

  const promisePool = pool.promise();
  let conn;

  try {
    conn = await promisePool.getConnection();
    await conn.beginTransaction();

    // 1. Validar Resolución DIAN Activa
    const [resoluciones]: any = await conn.query(
      "SELECT * FROM dian_resoluciones WHERE empresa_id = ? AND activa = TRUE AND fecha_fin >= CURDATE() LIMIT 1",
      [empresa_id]
    );

    if (resoluciones.length === 0) {
      throw new Error("No hay una resolución DIAN activa o vigente. Por favor configure una.");
    }

    const resDIAN = resoluciones[0];

    // 2. Validar Rangos
    if (resDIAN.consecutivo_actual > resDIAN.rango_hasta) {
      throw new Error("Se ha superado el rango de facturación autorizado por la DIAN.");
    }

    const consecutivo = resDIAN.consecutivo_actual;
    const prefijo = resDIAN.prefijo;

    // 3. Insertar Cabecera de Factura Electrónica
    const cId = req.user.cajero_id || cajeroId;
    const pef = parseFloat(req.body.efectivoEntregado) || 0;
    const ptr = parseFloat(req.body.transferenciaEntregada) || 0;
    const vlt = parseFloat(req.body.vuelto) || 0;
    
    // Calculamos el ingreso neto real en efectivo (restando el vuelto)
    const pefNeto = Math.max(0, pef - vlt);
    // En el modelo "IVA Incluido", el total ya trae el IVA. 
    // Por tanto, el subtotal se extrae dividiendo por (1 + tasa)
    const subtotalFinal = Math.round((total - iva) * 100) / 100;
    const ivaFinal = Math.round(iva * 100) / 100;

    const [resCab]: any = await conn.query(
      `INSERT INTO facturas_electronicas 
      (empresa_id, resolucion_id, consecutivo, prefijo, cliente_id, cajero_id, total, iva, subtotal, metodo_pago, pago_efectivo, pago_transferencia, notas, estado_dian) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendiente')`,
      [empresa_id, resDIAN.id, consecutivo, prefijo, clienteId, cId, total, ivaFinal, subtotalFinal, metodoPago, pefNeto, ptr, notas]
    );
    const facturaElectronicaId = resCab.insertId;

    // --- NUEVO: Obtener porcentaje de comisión del cajero ---
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

    // 4. Procesar Items e Inventario (Igual que ventas normales)
    for (const item of items) {
      // Registrar venta electrónica (Modelo IVA Incluido)
      const ivaPerc = parseFloat(item.iva_porcentaje || 0);
      const totalItem = Math.round((item.qty * item.precio_unitario) * 100) / 100;
      // Extraer IVA: Base = Total / (1 + %) -> IVA = Total - Base
      const subtotalItem = Math.round((totalItem / (1 + ivaPerc / 100)) * 100) / 100;
      const ivaVal = Math.round((totalItem - subtotalItem) * 100) / 100;

      // --- CÁLCULO DE COMISIÓN ITEMIZADA ---
      const comisionItem = Math.round((totalItem * (percComision / 100)) * 100) / 100;

      await conn.query(
        `INSERT INTO ventas_electronicas 
        (factura_electronica_id, producto_id, cantidad, precio_unitario, iva_porcentaje, iva_valor, subtotal, comision) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [facturaElectronicaId, item.id, item.qty, item.precio_unitario, ivaPerc, ivaVal, subtotalItem, comisionItem]
      );

      // Descontar inventario
      const [pData]: any = await conn.query("SELECT cantidad, es_servicio FROM productos WHERE id = ?", [item.id]);
      if (pData.length > 0 && !pData[0].es_servicio) {
        await conn.query("UPDATE productos SET cantidad = cantidad - ? WHERE id = ?", [item.qty, item.id]);
        
        // Kardex
        await conn.query(
          "INSERT INTO kardex (empresa_id, producto_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, 'SALIDA', ?, ?, ?, ?, ?, ?)",
          [empresa_id, item.id, pData[0].cantidad, -item.qty, pData[0].cantidad - item.qty, `Factura Electrónica: ${prefijo}${consecutivo}`, req.user.username || 'Sistema', `${prefijo}${consecutivo}`]
        );
      }
    }

    // 5. Incrementar consecutivo en resolución
    await conn.query(
      "UPDATE dian_resoluciones SET consecutivo_actual = consecutivo_actual + 1 WHERE id = ?",
      [resDIAN.id]
    );

    await conn.commit();

    // --- INTEGRACIÓN CON PROVEEDOR TECNOLÓGICO (PASO DE ENVÍO) ---
    try {
      // Obtener datos completos de la empresa y cliente para el envío
      const [[empresa]]: any = await promisePool.query("SELECT * FROM empresa_config WHERE empresa_id = ?", [empresa_id]);
      const [[cliente]]: any = await promisePool.query("SELECT * FROM clientes WHERE id = ?", [clienteId]);

      // Preparar objeto para el proveedor (Estructura base)
      const facturaParaDian = {
        encabezado: { prefijo, consecutivo, fecha: new Date(), notas },
        emisor: empresa,
        receptor: cliente,
        items,
        totales: { total, iva, subtotal: total - iva }
      };

      // 6. LLAMAR A LA API (Sincrónico o Asincrónico según preferencia)
      const respuestaDian = await enviarFacturaADian(facturaParaDian, resDIAN);

      if (respuestaDian.success) {
        // 7. ACTUALIZAR ESTADO EN DB CON RESPUESTA REAL
        await promisePool.query(
          `UPDATE facturas_electronicas 
           SET estado_dian = ?, cufe = ?, qr_url = ?, xml_url = ?, pdf_url = ? 
           WHERE id = ?`,
          [respuestaDian.estado, respuestaDian.cufe, respuestaDian.qr_url, respuestaDian.xml_url, respuestaDian.pdf_url, facturaElectronicaId]
        );
      }

      res.status(201).json({ 
        success: true, 
        mensaje: "Factura electrónica procesada y reportada exitosamente",
        factura_id: facturaElectronicaId,
        numero_completo: `${prefijo}${consecutivo}`,
        dian: respuestaDian
      });

    } catch (apiError: any) {
      // Si falla el envío al proveedor, la factura ya quedó guardada localmente como "pendiente"
      res.status(201).json({ 
        success: true, 
        mensaje: "Factura guardada localmente pero falló el reporte inmediato a la DIAN. Queda en estado PENDIENTE.",
        factura_id: facturaElectronicaId,
        numero_completo: `${prefijo}${consecutivo}`,
        error_dian: apiError.message
      });
    }

  } catch (error: any) {
    if (conn) await conn.rollback();
    res.status(500).json({ error: error.message || "Error al procesar factura electrónica" });
  } finally {
    if (conn) conn.release();
  }
});

// Listar facturas electrónicas
router.get("/", async (req: any, res) => {
    const empresa_id = req.user.empresa_id;
    const query = `
      SELECT f.*, c.nombre as cliente, ca.nombre as cajero
      FROM facturas_electronicas f
      JOIN clientes c ON f.cliente_id = c.id
      JOIN cajeros ca ON f.cajero_id = ca.id
      WHERE f.empresa_id = ?
      ORDER BY f.fecha_emision DESC
    `;
    pool.query(query, [empresa_id], (err, results) => {
       if (err) return res.status(500).json({ error: "Error al listar facturas" });
       res.json(results);
    });
});

export default router;
