import express from "express";
import pool from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

router.use(verifyTokenAndTenant);

// Obtener historial de documentos soporte
router.get("/", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  pool.query(
    `SELECT ds.*, c.nombre as cajero_nombre 
     FROM documentos_soporte ds 
     LEFT JOIN cajeros c ON ds.cajero_id = c.id
     WHERE ds.empresa_id = ? ORDER BY ds.fecha DESC`,
    [empresa_id],
    (err: any, results: any[]) => {
      if (err) return res.status(500).json({ error: "Error obteniendo documentos" });
      const docs = results.map(r => ({
        ...r,
        datos_json: typeof r.datos_json === 'string' ? JSON.parse(r.datos_json) : r.datos_json
      }));
      res.json(docs);
    }
  );
});

// Obtener próximo consecutivo
router.get("/consecutivo", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  pool.query("SELECT MAX(numero_documento) as last_num FROM documentos_soporte WHERE empresa_id = ?", [empresa_id], (err: any, results: any[]) => {
    if (err) return res.status(500).json({ error: err.message });
    const nextNum = (results[0].last_num || 0) + 1;
    res.json({ consecutivo: nextNum });
  });
});

// Crear nuevo documento soporte
router.post("/", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { proveedor_nombre, proveedor_documento, prefijo, numero_documento, subtotal, impuestos, total, datos_json, afecta_inventario, archivo_adjunto } = req.body;
  const usuario_nombre = req.user.username || "Admin";
  const cajero_id = req.body.cajero_id || null;

  const productos = datos_json || [];

  const promiseDb = pool.promise();
  const conn = await promiseDb.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Opcional: Afectar Inventario
    if (afecta_inventario && productos.length > 0) {
      for (const p of productos) {
        let finalId: number;
        let stock_antes = 0;

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
              ? "UPDATE productos SET precio_compra = ?, precio_venta = ?, es_servicio = 1 WHERE id = ? AND empresa_id = ?"
              : "UPDATE productos SET cantidad = cantidad + ?, precio_compra = ?, precio_venta = ?, es_servicio = 0 WHERE id = ? AND empresa_id = ?";
            
            const params = esServicio 
              ? [p.precio_compra, p.precio_venta, finalId, empresa_id]
              : [p.cantidad, p.precio_compra, p.precio_venta, finalId, empresa_id];

            await conn.query(qUpdate, params);
          }
        }

        if (!found) {
          const [resIns]: any = await conn.query(
            "INSERT INTO productos (empresa_id, referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta, es_servicio) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [empresa_id, p.referencia || '', p.nombre, p.categoria || 'General', p.es_servicio ? 0 : p.cantidad, p.precio_compra, p.porcentaje_ganancia || 40, p.precio_venta, p.es_servicio ? 1 : 0]
          );
          finalId = resIns.insertId;
          stock_antes = 0;
        }

        const esServicio = !!p.es_servicio;
        const stock_despues = esServicio ? stock_antes : (stock_antes + p.cantidad);
        const movType = esServicio ? 'INGRESO_SERVICIO' : 'ENTRADA';
        
        await conn.query(
          "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [finalId, empresa_id, movType, stock_antes, p.cantidad, stock_despues, `Documento Soporte: ${proveedor_nombre || 'S/P'}`, usuario_nombre, `${prefijo || 'DS'}-${numero_documento}`]
        );
      }
    }

    // 2. Registrar Documento
    const [result]: any = await conn.query(
        "INSERT INTO documentos_soporte (empresa_id, proveedor_nombre, proveedor_documento, prefijo, numero_documento, datos_json, archivo_adjunto, subtotal, impuestos, total, estado, cajero_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Emitido', ?)",
        [empresa_id, proveedor_nombre, proveedor_documento, prefijo || 'DS', numero_documento, JSON.stringify(productos), archivo_adjunto || null, subtotal, impuestos, total, cajero_id]
    );

    await conn.commit();
    res.status(201).json({ message: "Documento Soporte creado exitosamente.", id: result.insertId });
  } catch (err: any) {
    await conn.rollback();
    console.error("Error al crear Documento Soporte:", err);
    res.status(500).json({ error: "Fallo en transacción: " + err.message });
  } finally {
    conn.release();
  }
});

// Anular Documento
router.put("/:id/anular", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;
  const { afecta_inventario } = req.body;
  const usuario_nombre = req.user.username || "Admin";

  const promiseDb = pool.promise();
  const conn = await promiseDb.getConnection();

  try {
    await conn.beginTransaction();

    const [docs]: any = await conn.query("SELECT * FROM documentos_soporte WHERE id = ? AND empresa_id = ? FOR UPDATE", [id, empresa_id]);
    if (docs.length === 0) throw new Error("Documento no encontrado");
    
    const doc = docs[0];
    if (doc.estado === 'Anulado') throw new Error("El documento ya se encuentra anulado");

    if (afecta_inventario) {
        const productos = typeof doc.datos_json === 'string' ? JSON.parse(doc.datos_json) : doc.datos_json;
        for (const oldP of productos) {
            let pId: number | null = null;
            const [pSearch]: any = await conn.query(
              "SELECT id, cantidad, es_servicio FROM productos WHERE (referencia = ? OR nombre = ?) AND empresa_id = ? FOR UPDATE", 
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
              const movType = esServicio ? 'REVERSION_SERVICIO' : 'SALIDA_ANULACION';
     
              await conn.query(
                "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                [pId, empresa_id, movType, stock_antes, oldP.cantidad, stock_despues, 'Anulación Documento Soporte', usuario_nombre, `${doc.prefijo}-${doc.numero_documento}-ANUL`]
              );
            }
        }
    }

    await conn.query("UPDATE documentos_soporte SET estado = 'Anulado' WHERE id = ? AND empresa_id = ?", [id, empresa_id]);

    await conn.commit();
    res.json({ message: "Documento anulado con éxito" });
  } catch (err: any) {
    await conn.rollback();
    res.status(500).json({ error: "Fallo al anular: " + err.message });
  } finally {
    conn.release();
  }
});

export default router;
