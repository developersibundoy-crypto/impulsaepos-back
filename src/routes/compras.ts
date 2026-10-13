import express from "express";
import pool from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

// Impedir accesos no autorizados y filtrar por empresa
router.use(verifyTokenAndTenant);

// Función auxiliar para normalizar y enriquecer productos con costo y valor de venta
function procesarProductosCompra(items: any[], catalogoMap: { ref: Map<string, any>; nom: Map<string, any>; id: Map<number, any> }) {
  if (!Array.isArray(items)) return [];
  return items.map((item: any) => {
    const refKey = item.referencia ? String(item.referencia).trim().toLowerCase() : "";
    const nomKey = item.nombre ? String(item.nombre).trim().toLowerCase() : "";
    const idKey = item.id ? Number(item.id) : 0;

    const prodDb = (idKey && catalogoMap.id.get(idKey)) ||
                   (refKey && catalogoMap.ref.get(refKey)) ||
                   (nomKey && catalogoMap.nom.get(nomKey)) || null;

    const costo = Number(
      (item.precio_compra !== undefined && item.precio_compra !== null && item.precio_compra !== "" && !isNaN(Number(item.precio_compra)))
        ? Number(item.precio_compra)
        : (item.costo !== undefined && item.costo !== null && item.costo !== "" && !isNaN(Number(item.costo)))
          ? Number(item.costo)
          : (prodDb?.precio_compra || 0)
    );

    const ganancia = Number(
      (item.porcentaje_ganancia !== undefined && item.porcentaje_ganancia !== null && item.porcentaje_ganancia !== "" && !isNaN(Number(item.porcentaje_ganancia)))
        ? Number(item.porcentaje_ganancia)
        : (prodDb?.porcentaje_ganancia || 0)
    );

    let venta = 0;
    if (item.precio_venta !== undefined && item.precio_venta !== null && item.precio_venta !== "" && !isNaN(Number(item.precio_venta)) && Number(item.precio_venta) > 0) {
      venta = Number(item.precio_venta);
    } else if (item.valor_venta !== undefined && item.valor_venta !== null && item.valor_venta !== "" && !isNaN(Number(item.valor_venta)) && Number(item.valor_venta) > 0) {
      venta = Number(item.valor_venta);
    } else if (prodDb?.precio_venta && Number(prodDb.precio_venta) > 0) {
      venta = Number(prodDb.precio_venta);
    } else if (costo > 0 && ganancia > 0) {
      venta = Math.round(costo * (1 + ganancia / 100));
    } else {
      venta = costo;
    }

    const cantidad = Number(item.cantidad || 0);
    const subtotalCosto = costo * cantidad;
    const subtotalVenta = venta * cantidad;

    return {
      ...item,
      costo: costo,
      precio_compra: costo,
      valor_venta: venta,
      precio_venta: venta,
      porcentaje_ganancia: ganancia,
      subtotal_costo: subtotalCosto,
      subtotal_venta: subtotalVenta
    };
  });
}

function procesarFacturaCompra(r: any, catalogoMap: { ref: Map<string, any>; nom: Map<string, any>; id: Map<number, any> }) {
  let parsed: any[] = [];
  try {
    parsed = typeof r.datos_json === 'string' ? JSON.parse(r.datos_json) : r.datos_json;
  } catch (e) {
    parsed = [];
  }

  const itemsProcesados = procesarProductosCompra(parsed, catalogoMap);
  const totalCosto = Number(r.total || 0);
  const totalVenta = itemsProcesados.reduce((acc: number, it: any) => acc + (Number(it.subtotal_venta) || 0), 0);

  return {
    ...r,
    costo_total: totalCosto,
    total_costo: totalCosto,
    total: totalCosto,
    total_venta: totalVenta,
    valor_venta: totalVenta,
    valor_venta_total: totalVenta,
    utilidad_proyectada: totalVenta - totalCosto,
    datos_json: itemsProcesados
  };
}

// 1. Obtener el historial de facturas de compra filtrado por empresa (con costo y valor de venta)
router.get("/", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  try {
    const promiseDb = pool.promise();
    const [results]: any = await promiseDb.query(
      "SELECT * FROM facturas_compra WHERE empresa_id = ? ORDER BY fecha DESC",
      [empresa_id]
    );

    // Consultar catálogo actual de la empresa para resolver valor de venta de los productos
    const [productosDb]: any = await promiseDb.query(
      "SELECT id, referencia, nombre, precio_compra, precio_venta, porcentaje_ganancia FROM productos WHERE empresa_id = ?",
      [empresa_id]
    );

    const catalogoMap = {
      ref: new Map<string, any>(),
      nom: new Map<string, any>(),
      id: new Map<number, any>()
    };

    for (const p of productosDb) {
      if (p.referencia) catalogoMap.ref.set(String(p.referencia).trim().toLowerCase(), p);
      if (p.nombre) catalogoMap.nom.set(String(p.nombre).trim().toLowerCase(), p);
      if (p.id) catalogoMap.id.set(Number(p.id), p);
    }

    const facturas = results.map((r: any) => procesarFacturaCompra(r, catalogoMap));
    res.json(facturas);
  } catch (err: any) {
    console.error("Error obteniendo facturas de compra:", err);
    res.status(500).json({ error: "Error obteniendo facturas de compra: " + err.message });
  }
});

// Obtener detalle de una factura de compra individual
router.get("/:id", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;
  try {
    const promiseDb = pool.promise();
    const [results]: any = await promiseDb.query(
      "SELECT * FROM facturas_compra WHERE id = ? AND empresa_id = ?",
      [id, empresa_id]
    );
    if (results.length === 0) {
      return res.status(404).json({ error: "Factura de compra no encontrada" });
    }

    const [productosDb]: any = await promiseDb.query(
      "SELECT id, referencia, nombre, precio_compra, precio_venta, porcentaje_ganancia FROM productos WHERE empresa_id = ?",
      [empresa_id]
    );

    const catalogoMap = {
      ref: new Map<string, any>(),
      nom: new Map<string, any>(),
      id: new Map<number, any>()
    };

    for (const p of productosDb) {
      if (p.referencia) catalogoMap.ref.set(String(p.referencia).trim().toLowerCase(), p);
      if (p.nombre) catalogoMap.nom.set(String(p.nombre).trim().toLowerCase(), p);
      if (p.id) catalogoMap.id.set(Number(p.id), p);
    }

    const factura = procesarFacturaCompra(results[0], catalogoMap);
    res.json(factura);
  } catch (err: any) {
    console.error("Error obteniendo factura de compra:", err);
    res.status(500).json({ error: "Error obteniendo factura: " + err.message });
  }
});

// 2. Registrar una NUEVA factura de compra
router.post("/", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { proveedor, numero_factura, total, productos } = req.body;
  const usuario_nombre = req.user.username || "Admin";
  
  if (!Array.isArray(productos) || productos.length === 0) {
    return res.status(400).json({ error: "No se proporcionaron productos válidos." });
  }

  const promiseDb = pool.promise();
  const conn = await promiseDb.getConnection();

  try {
    await conn.beginTransaction();

    const productosEnriquecidos: any[] = [];

    if (!req.body.solo_registro) {
      for (const p of productos) {
        let finalId: number;
        let stock_antes = 0;

        const costo = Number(p.precio_compra || p.costo || 0);
        const ganancia = Number(p.porcentaje_ganancia || 0);
        let venta = Number(p.precio_venta || p.valor_venta || 0);

        // Buscar si el producto existe para sumar stock
        let found = false;
        if (p.referencia && p.referencia.trim() !== '') {
          const [existing]: any = await conn.query(
              "SELECT id, cantidad, precio_venta, porcentaje_ganancia FROM productos WHERE referencia = ? AND empresa_id = ? FOR UPDATE", 
              [p.referencia, empresa_id]
          );
          if (existing.length > 0) {
            finalId = existing[0].id;
            stock_antes = existing[0].cantidad;
            found = true;

            if (venta <= 0) {
              venta = Number(existing[0].precio_venta) > 0 ? Number(existing[0].precio_venta) : (ganancia > 0 ? Math.round(costo * (1 + ganancia / 100)) : costo);
            }

            const esServicio = !!p.es_servicio;
            const qUpdate = esServicio
              ? "UPDATE productos SET precio_compra = ?, precio_venta = ?, porcentaje_ganancia = ?, es_servicio = 1 WHERE id = ? AND empresa_id = ?"
              : "UPDATE productos SET cantidad = cantidad + ?, precio_compra = ?, precio_venta = ?, porcentaje_ganancia = ?, es_servicio = 0 WHERE id = ? AND empresa_id = ?";
            
            const params = esServicio 
              ? [costo, venta, ganancia, finalId, empresa_id]
              : [p.cantidad, costo, venta, ganancia, finalId, empresa_id];

            await conn.query(qUpdate, params);
          }
        }

        if (!found) {
          if (venta <= 0 && costo > 0 && ganancia > 0) {
            venta = Math.round(costo * (1 + ganancia / 100));
          } else if (venta <= 0) {
            venta = costo;
          }

          // Crear nuevo producto
          const [resIns]: any = await conn.query(
            "INSERT INTO productos (empresa_id, referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta, es_servicio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [empresa_id, p.referencia || '', p.nombre, p.categoria || 'General', p.cantidad, costo, ganancia, venta, p.es_servicio ? 1 : 0]
          );
          finalId = resIns.insertId;
          stock_antes = 0;
        }

        productosEnriquecidos.push({
          ...p,
          id: finalId,
          costo: costo,
          precio_compra: costo,
          valor_venta: venta,
          precio_venta: venta,
          porcentaje_ganancia: ganancia,
          subtotal_costo: costo * Number(p.cantidad || 0),
          subtotal_venta: venta * Number(p.cantidad || 0)
        });

        // 3. Registrar Kardex
        const esServicio = !!p.es_servicio;
        const stock_despues = esServicio ? stock_antes : (stock_antes + p.cantidad);
        const movType = esServicio ? 'COMPRA_SERVICIO' : 'ENTRADA';
        
        await conn.query(
          "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [finalId, empresa_id, movType, stock_antes, p.cantidad, stock_despues, `Compra Factura: ${proveedor || 'S/P'}`, usuario_nombre, `FC-${numero_factura || 'S/N'}`]
        );
      }
    } else {
      // Modo solo_registro
      for (const p of productos) {
        const costo = Number(p.precio_compra || p.costo || 0);
        const ganancia = Number(p.porcentaje_ganancia || 0);
        let venta = Number(p.precio_venta || p.valor_venta || 0);
        if (venta <= 0 && costo > 0 && ganancia > 0) {
          venta = Math.round(costo * (1 + ganancia / 100));
        } else if (venta <= 0) {
          venta = costo;
        }
        productosEnriquecidos.push({
          ...p,
          costo: costo,
          precio_compra: costo,
          valor_venta: venta,
          precio_venta: venta,
          porcentaje_ganancia: ganancia,
          subtotal_costo: costo * Number(p.cantidad || 0),
          subtotal_venta: venta * Number(p.cantidad || 0)
        });
      }
    }
    
    // 4. Registrar Factura con datos enriquecidos (costo y venta)
    const archivo_factura = req.body.archivo_factura || null;
    const insertQuery = "INSERT INTO facturas_compra (empresa_id, proveedor, numero_factura, total, datos_json, archivo_factura) VALUES (?, ?, ?, ?, ?, ?)";
    const [result]: any = await conn.query(insertQuery, [empresa_id, proveedor || '', numero_factura || '', total || 0, JSON.stringify(productosEnriquecidos), archivo_factura]);
    const facturaCompraId = result.insertId;

    // --- NUEVO: Automatización Cuentas por Pagar (CxP) ---
    if (req.body.es_credito) {
      const montoAbonado = parseFloat(req.body.monto_abonado) || 0;
      const totalCompra = parseFloat(total) || 0;
      const saldoPdte = Math.max(0, totalCompra - montoAbonado);
      
      const [resCxp]: any = await conn.query(
        "INSERT INTO cuentas_por_pagar (empresa_id, factura_compra_id, proveedor, numero_factura, monto_total, saldo_pendiente, estado) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [empresa_id, facturaCompraId, proveedor || 'Desconocido', numero_factura || 'N/A', totalCompra, saldoPdte, saldoPdte === 0 ? 'Pagada' : 'Pendiente']
      );

      if (montoAbonado > 0) {
        await conn.query(
          "INSERT INTO abonos_cxp (empresa_id, cxp_id, monto, metodo_pago) VALUES (?, ?, ?, ?)",
          [empresa_id, resCxp.insertId, montoAbonado, req.body.metodo_pago_abono || 'Efectivo']
        );
      }
    }
    // -----------------------------------------------------

    await conn.commit();
    res.status(201).json({ message: "Compra registrada y stock actualizado con trazabilidad.", id: result.insertId });
  } catch (err: any) {
    await conn.rollback();
    console.error("Error al registrar compra:", err);
    res.status(500).json({ error: "Fallo en transacción: " + err.message });
  } finally {
    conn.release();
  }
});

// 3. EDITAR factura histórica (Delta de inventario con Kardex)
router.put("/:id", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;
  const { proveedor, numero_factura, total, productos } = req.body;
  const usuario_nombre = req.user.username || "Admin";

  const promiseDb = pool.promise();
  const conn = await promiseDb.getConnection();
  
  try {
    await conn.beginTransaction();

    const [oldRows]: any = await conn.query("SELECT datos_json FROM facturas_compra WHERE id = ? AND empresa_id = ? FOR UPDATE", [id, empresa_id]);
    if (oldRows.length === 0) throw new Error("Factura no encontrada");
    
    let oldProducts: any[] = [];
    try {
      oldProducts = typeof oldRows[0].datos_json === 'string' ? JSON.parse(oldRows[0].datos_json) : oldRows[0].datos_json;
    } catch (e) {
      oldProducts = [];
    }

    // Deshacer el stock de los productos viejos
    for (const oldP of oldProducts) {
       let pId: number | null = null;
       const [pSearch]: any = await conn.query(
         "SELECT id, cantidad FROM productos WHERE (referencia = ? OR nombre = ?) AND empresa_id = ? FOR UPDATE", 
         [oldP.referencia || '___', oldP.nombre || '___', empresa_id]
       );

       if (pSearch.length > 0) {
         pId = pSearch[0].id;
         const stock_antes = pSearch[0].cantidad;
         const esServicio = !!pSearch[0].es_servicio;
         
         if (!esServicio) {
            await conn.query("UPDATE productos SET cantidad = cantidad - ? WHERE id = ?", [oldP.cantidad, pId]);
         }
         
         const stock_despues = esServicio ? stock_antes : (stock_antes - oldP.cantidad);
         const movType = esServicio ? 'REVERSIÓN_COMPRA_SERVICIO' : 'SALIDA_CORRECCIÓN';

         await conn.query(
           "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
           [pId, empresa_id, movType, stock_antes, oldP.cantidad, stock_despues, 'Corrección Factura Compra (Deshacer)', usuario_nombre, `FC-${id}-CORR`]
         );
       }
    }

    // Aplicar el nuevo stock y enriquecer productos
    const productosEnriquecidos: any[] = [];

    for (const newP of productos) {
      const [pSearch]: any = await conn.query(
        "SELECT id, cantidad, precio_venta, porcentaje_ganancia FROM productos WHERE (referencia = ? OR nombre = ?) AND empresa_id = ? FOR UPDATE", 
        [newP.referencia || '___', newP.nombre || '___', empresa_id]
      );

      let pId: number;
      let stock_antes = 0;
      const costo = Number(newP.precio_compra || newP.costo || 0);
      const ganancia = Number(newP.porcentaje_ganancia || 0);
      let venta = Number(newP.precio_venta || newP.valor_venta || 0);

      if (pSearch.length > 0) {
        pId = pSearch[0].id;
        stock_antes = pSearch[0].cantidad;
        const esServicio = !!pSearch[0].es_servicio;

        if (venta <= 0) {
          venta = Number(pSearch[0].precio_venta) > 0 ? Number(pSearch[0].precio_venta) : (ganancia > 0 ? Math.round(costo * (1 + ganancia / 100)) : costo);
        }

        if (esServicio) {
          await conn.query(
            "UPDATE productos SET precio_compra = ?, precio_venta = ?, porcentaje_ganancia = ? WHERE id = ?",
            [costo, venta, ganancia, pId]
          );
        } else {
          await conn.query(
            "UPDATE productos SET cantidad = cantidad + ?, precio_compra = ?, precio_venta = ?, porcentaje_ganancia = ? WHERE id = ?",
            [newP.cantidad, costo, venta, ganancia, pId]
          );
        }
        
        const stock_despues = esServicio ? stock_antes : (stock_antes + newP.cantidad);
        const movType = esServicio ? 'APLICACIÓN_COMPRA_SERVICIO' : 'ENTRADA_CORRECCIÓN';

        await conn.query(
          "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [pId, empresa_id, movType, stock_antes, newP.cantidad, stock_despues, 'Corrección Factura Compra (Aplicar)', usuario_nombre, `FC-${id}-CORR`]
        );
      } else {
        if (venta <= 0 && costo > 0 && ganancia > 0) {
          venta = Math.round(costo * (1 + ganancia / 100));
        } else if (venta <= 0) {
          venta = costo;
        }

        const [resIns]: any = await conn.query(
          "INSERT INTO productos (empresa_id, referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta, es_servicio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [empresa_id, newP.referencia || '', newP.nombre, newP.categoria || 'General', newP.es_servicio ? 0 : newP.cantidad, costo, ganancia, venta, newP.es_servicio ? 1 : 0]
        );
        pId = resIns.insertId;
        stock_antes = 0;

        await conn.query(
          "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, 'ENTRADA_NUEVO', ?, ?, ?, ?, ?, ?)",
          [pId, empresa_id, 0, newP.cantidad, newP.es_servicio ? 0 : newP.cantidad, 'Nueva Carga por Corrección', usuario_nombre, `FC-${id}-CORR`]
        );
      }

      productosEnriquecidos.push({
        ...newP,
        id: pId,
        costo: costo,
        precio_compra: costo,
        valor_venta: venta,
        precio_venta: venta,
        porcentaje_ganancia: ganancia,
        subtotal_costo: costo * Number(newP.cantidad || 0),
        subtotal_venta: venta * Number(newP.cantidad || 0)
      });
    }

    const updateQuery = "UPDATE facturas_compra SET proveedor=?, numero_factura=?, total=?, datos_json=?, fecha=CURRENT_TIMESTAMP WHERE id=? AND empresa_id=?";
    await conn.query(updateQuery, [proveedor || '', numero_factura || '', total || 0, JSON.stringify(productosEnriquecidos), id, empresa_id]);

    await conn.commit();
    res.json({ message: "Factura y stock reajustado con éxito y trazabilidad en Kardex." });
  } catch (err: any) {
    await conn.rollback();
    console.error("Error al reescribir la factura:", err);
    res.status(500).json({ error: "Fallo en Delta: " + err.message });
  } finally {
    conn.release();
  }
});

export default router;
