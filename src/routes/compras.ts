import express from "express";
import pool from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

// Impedir accesos no autorizados y filtrar por empresa
router.use(verifyTokenAndTenant);

// 1. Obtener el historial de facturas de compra filtrado por empresa
router.get("/", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  pool.query("SELECT * FROM facturas_compra WHERE empresa_id = ? ORDER BY fecha DESC", [empresa_id], (err: any, results: any[]) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: "Error obteniendo facturas de compra" });
    }
    const facturas = results.map(r => ({
      ...r,
      datos_json: typeof r.datos_json === 'string' ? JSON.parse(r.datos_json) : r.datos_json
    }));
    res.json(facturas);
  });
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

    if (!req.body.solo_registro) {
      for (const p of productos) {
        let finalId: number;
        let stock_antes = 0;

        // Buscar si el producto existe para sumar stock
        let found = false;
        if (p.referencia && p.referencia.trim() !== '') {
          const [existing]: any = await conn.query(
              "SELECT id, cantidad FROM productos WHERE referencia = ? AND empresa_id = ? FOR UPDATE", 
              [p.referencia, empresa_id]
          );
          if (existing.length > 0) {
            finalId = existing[0].id;
            stock_antes = existing[0].cantidad;
            found = true;
            const esServicio = !!p.es_servicio;
            const qUpdate = esServicio
              ? "UPDATE productos SET precio_compra = ?, precio_venta = ?, porcentaje_ganancia = ?, es_servicio = 1 WHERE id = ? AND empresa_id = ?"
              : "UPDATE productos SET cantidad = cantidad + ?, precio_compra = ?, precio_venta = ?, porcentaje_ganancia = ?, es_servicio = 0 WHERE id = ? AND empresa_id = ?";
            
            const params = esServicio 
              ? [p.precio_compra, p.precio_venta, p.porcentaje_ganancia, finalId, empresa_id]
              : [p.cantidad, p.precio_compra, p.precio_venta, p.porcentaje_ganancia, finalId, empresa_id];

            await conn.query(qUpdate, params);
          }
        }

        if (!found) {
          // Crear nuevo producto
          const [resIns]: any = await conn.query(
            "INSERT INTO productos (empresa_id, referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta, es_servicio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [empresa_id, p.referencia || '', p.nombre, p.categoria, p.cantidad, p.precio_compra, p.porcentaje_ganancia, p.precio_venta, p.es_servicio ? 1 : 0]
          );
          finalId = resIns.insertId;
          stock_antes = 0;
        }

        // 3. Registrar Kardex
        const esServicio = !!p.es_servicio;
        const stock_despues = esServicio ? stock_antes : (stock_antes + p.cantidad);
        const movType = esServicio ? 'COMPRA_SERVICIO' : 'ENTRADA';
        
        await conn.query(
          "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [finalId, empresa_id, movType, stock_antes, p.cantidad, stock_despues, `Compra Factura: ${proveedor || 'S/P'}`, usuario_nombre, `FC-${numero_factura || 'S/N'}`]
        );
      }
    }
    
    // 4. Registrar Factura
    const insertQuery = "INSERT INTO facturas_compra (empresa_id, proveedor, numero_factura, total, datos_json) VALUES (?, ?, ?, ?, ?)";
    const [result]: any = await conn.query(insertQuery, [empresa_id, proveedor || '', numero_factura || '', total || 0, JSON.stringify(productos)]);

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
    
    const oldProducts = typeof oldRows[0].datos_json === 'string' ? JSON.parse(oldRows[0].datos_json) : oldRows[0].datos_json;

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

    // Aplicar el nuevo stock
    for (const newP of productos) {
      const [pSearch]: any = await conn.query(
        "SELECT id, cantidad FROM productos WHERE (referencia = ? OR nombre = ?) AND empresa_id = ? FOR UPDATE", 
        [newP.referencia || '___', newP.nombre || '___', empresa_id]
      );

      let pId: number;
      let stock_antes = 0;

      if (pSearch.length > 0) {
        pId = pSearch[0].id;
        stock_antes = pSearch[0].cantidad;
        const esServicio = !!pSearch[0].es_servicio;

        if (esServicio) {
          await conn.query(
            "UPDATE productos SET precio_compra = ?, precio_venta = ?, porcentaje_ganancia = ? WHERE id = ?",
            [newP.precio_compra, newP.precio_venta, newP.porcentaje_ganancia, pId]
          );
        } else {
          await conn.query(
            "UPDATE productos SET cantidad = cantidad + ?, precio_compra = ?, precio_venta = ?, porcentaje_ganancia = ? WHERE id = ?",
            [newP.cantidad, newP.precio_compra, newP.precio_venta, newP.porcentaje_ganancia, pId]
          );
        }
        
        const stock_despues = esServicio ? stock_antes : (stock_antes + newP.cantidad);
        const movType = esServicio ? 'APLICACIÓN_COMPRA_SERVICIO' : 'ENTRADA_CORRECCIÓN';

        await conn.query(
          "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [pId, empresa_id, movType, stock_antes, newP.cantidad, stock_despues, 'Corrección Factura Compra (Aplicar)', usuario_nombre, `FC-${id}-CORR`]
        );
      } else {
        const [resIns]: any = await conn.query(
          "INSERT INTO productos (empresa_id, referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta, es_servicio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [empresa_id, newP.referencia || '', newP.nombre, newP.categoria || 'General', newP.es_servicio ? 0 : newP.cantidad, newP.precio_compra, newP.porcentaje_ganancia, newP.precio_venta, newP.es_servicio ? 1 : 0]
        );
        pId = resIns.insertId;
        stock_antes = 0;

        await conn.query(
          "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, 'ENTRADA_NUEVO', ?, ?, ?, ?, ?, ?)",
          [pId, empresa_id, 0, newP.cantidad, newP.es_servicio ? 0 : newP.cantidad, 'Nueva Carga por Corrección', usuario_nombre, `FC-${id}-CORR`]
        );
      }
    }

    const updateQuery = "UPDATE facturas_compra SET proveedor=?, numero_factura=?, total=?, datos_json=?, fecha=CURRENT_TIMESTAMP WHERE id=? AND empresa_id=?";
    await conn.query(updateQuery, [proveedor || '', numero_factura || '', total || 0, JSON.stringify(productos), id, empresa_id]);

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

