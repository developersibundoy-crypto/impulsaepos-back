import express from "express";
import connection from "../conection";
import { verifyTokenAndTenant, verifyPermission } from "../middlewares/authMiddleware";

const router = express.Router();

// Todas las rutas de productos requieren autenticación y Tenant
router.use(verifyTokenAndTenant);

// Actualizar un producto existente - Requiere permiso de inventario
router.put("/:id", verifyPermission("inventario"), async (req: any, res: any) => {
  const { empresa_id, role, username } = req.user;
  const productoId = req.params.id;
  const { referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta, es_servicio, permitir_venta_negativa, iva_porcentaje, fecha_vencimiento } = req.body;

  const isSuper = role === 'superadmin';
  const promiseDb = connection.promise();
  const conn = await promiseDb.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Obtener estado actual para comparar stock
    const [oldData]: any = await conn.query("SELECT cantidad FROM productos WHERE id = ? FOR UPDATE", [productoId]);
    if (oldData.length === 0) throw new Error("Producto no encontrado");
    const stock_antes = oldData[0].cantidad;

    const finalCantidad = es_servicio ? 0 : cantidad;

    const iva_porcentaje = parseFloat(req.body.iva_porcentaje) || 0;
    
    // 2. Ejecutar Update
    const query = isSuper
      ? `UPDATE productos SET referencia = ?, nombre = ?, categoria = ?, cantidad = ?, precio_compra = ?, porcentaje_ganancia = ?, precio_venta = ?, es_servicio = ?, permitir_venta_negativa = ?, iva_porcentaje = ?, fecha_vencimiento = ? WHERE id = ?`
      : `UPDATE productos SET referencia = ?, nombre = ?, categoria = ?, cantidad = ?, precio_compra = ?, porcentaje_ganancia = ?, precio_venta = ?, es_servicio = ?, permitir_venta_negativa = ?, iva_porcentaje = ?, fecha_vencimiento = ? WHERE id = ? AND empresa_id = ?`;

    const params = [
      referencia || '', 
      nombre, 
      categoria, 
      finalCantidad, 
      precio_compra, 
      porcentaje_ganancia, 
      precio_venta, 
      es_servicio ? 1 : 0, 
      permitir_venta_negativa !== undefined ? (permitir_venta_negativa ? 1 : 0) : 1,
      iva_porcentaje > 1000 ? 0 : iva_porcentaje, // Clamp safety
      fecha_vencimiento || null,
      productoId
    ];
    if (!isSuper) params.push(empresa_id);

    await conn.query(query, params);

    // 3. Si la cantidad cambió manualmente y NO es un servicio, registrar en Kardex
    if (!es_servicio && parseInt(cantidad) !== stock_antes) {
      const diferencia = parseInt(cantidad) - stock_antes;
      await conn.query(
        "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre) VALUES (?, ?, 'AJUSTE', ?, ?, ?, ?, ?)",
        [productoId, empresa_id, stock_antes, Math.abs(diferencia), cantidad, 'Edición manual de producto', username || 'Usuario']
      );
    }

    await conn.commit();
    
    // Notificar por Socket.io en tiempo real
    if (req.io) {
       req.io.to(`empresa_${empresa_id}`).emit('product_updated', {
          id: productoId,
          referencia,
          nombre,
          precio_venta,
          precio_compra,
          iva_porcentaje: req.body.iva_porcentaje || 0,
          cantidad: finalCantidad
       });
    }

    res.json({ success: true, message: "Producto actualizado correctamente" });
  } catch (err: any) {
    await conn.rollback();
    console.error("Error al actualizar producto:", err);
    res.status(500).json({ error: err.message || "No se pudo actualizar el producto" });
  } finally {
    conn.release();
  }
});

// Eliminar un producto - Requiere permiso de inventario
router.delete("/:id", verifyPermission("inventario"), async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const productoId = req.params.id;
  const { motivo, usuario_nombre } = req.body;

  if (!motivo || !usuario_nombre) {
    return res.status(400).json({ error: "El motivo y el nombre de quien elimina son obligatorios para el Kardex." });
  }

  const promiseDb = connection.promise();
  const conn = await promiseDb.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Obtener datos antes de borrar para el historial
    const [results]: any = await conn.query(
      "SELECT nombre, cantidad, referencia FROM productos WHERE id = ? AND empresa_id = ? FOR UPDATE", 
      [productoId, empresa_id]
    );

    if (results.length === 0) throw new Error("Producto no encontrado o no pertenece a tu empresa");

    const { nombre, cantidad, referencia: refOriginal } = results[0];

    // 2. Registrar en Kardex la eliminación
    await conn.query(
      "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, 'ELIMINACIÓN', ?, ?, 0, ?, ?, ?)",
      [productoId, empresa_id, cantidad, cantidad, `ELIMINACIÓN: [${nombre}] - ${motivo}`, usuario_nombre, refOriginal || 'S/REF']
    );

    // 3. Proceder con el borrado físico
    await conn.query("DELETE FROM productos WHERE id = ? AND empresa_id = ?", [productoId, empresa_id]);

    await conn.commit();
    res.json({ success: true, message: `Producto ${nombre} eliminado y registrado en Kardex.` });
  } catch (err: any) {
    await conn.rollback();
    console.error("Error al eliminar producto:", err);
    res.status(500).json({ error: err.message || "No se pudo eliminar el producto físicamente" });
  } finally {
    conn.release();
  }
});

router.get("/", (req: any, res: any) => {
  let queryEmpresaId = req.user.empresa_id;
  const { tipo, page = 1, limit = 50, search = '', categoria = '' } = req.query;
  const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

  let baseQuery = "SELECT * FROM productos WHERE empresa_id = ?";
  let countQuery = "SELECT COUNT(*) as total FROM productos WHERE empresa_id = ?";
  const params: any[] = [queryEmpresaId];

  if (req.user.role === 'superadmin' && !req.query.empresa_id) {
    baseQuery = "SELECT * FROM productos WHERE 1=1";
    countQuery = "SELECT COUNT(*) as total FROM productos WHERE 1=1";
    params.pop();
  }

  if (tipo === 'servicio') {
    const clause = (baseQuery.includes('WHERE') ? " AND " : " WHERE ") + "es_servicio = 1";
    baseQuery += clause;
    countQuery += clause;
  } else if (tipo === 'producto') {
    const clause = (baseQuery.includes('WHERE') ? " AND " : " WHERE ") + "es_servicio = 0";
    baseQuery += clause;
    countQuery += clause;
  }

  if (categoria) {
    const categoryClause = " AND categoria = ?";
    baseQuery += categoryClause;
    countQuery += categoryClause;
    params.push(categoria);
  }

  if (search) {
    const searchClause = " AND (nombre LIKE ? OR referencia LIKE ?)";
    baseQuery += searchClause;
    countQuery += searchClause;
    const searchParam = `%${search}%`;
    params.push(searchParam, searchParam);
  }

  baseQuery += " ORDER BY id DESC LIMIT ? OFFSET ?";
  const queryParams = [...params, parseInt(limit as string), offset];

  connection.query(countQuery, params, (countErr: any, countRes: any) => {
    if (countErr) {
      console.error("Error counting products:", countErr);
      return res.status(500).json({ error: "Error counting products" });
    }
    const total = countRes[0].total;

    connection.query(baseQuery, queryParams, (err: any, results: any) => {
      if (err) {
        console.error("Error obtaining products:", err);
        return res.status(500).json({ error: "Error obtaining products" });
      }
      res.json({
        data: results,
        total,
        page: parseInt(page as string),
        last_page: Math.ceil(total / parseInt(limit as string))
      });
    });
  });
});

// Buscar producto por su código de barras (referencia)
router.get("/buscar/:referencia", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { referencia } = req.params;
  connection.query(
    "SELECT * FROM productos WHERE empresa_id = ? AND referencia = ? LIMIT 1", 
    [empresa_id, referencia], 
    (err: any, results: any[]) => {
      if (err) {
        console.error("Error al buscar el producto:", err);
        return res.status(500).json({ error: "Error en el servidor" });
      }
      if (results.length > 0) {
        res.json(results[0]);
      } else {
        res.status(404).json({ message: "Producto no encontrado en tu inventario" });
      }
    }
  );
});

// Guardado de un producto individual - Requiere permiso de ingreso
router.post("/", verifyPermission("ingreso"), (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta, es_servicio, permitir_venta_negativa, iva_porcentaje, fecha_vencimiento } = req.body;
  
  const query = `
    INSERT INTO productos (empresa_id, referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta, es_servicio, permitir_venta_negativa, iva_porcentaje, fecha_vencimiento) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `;
  
    const finalCantidad = es_servicio ? 0 : (cantidad || 0);

    connection.query(
    query, 
    [
      empresa_id, 
      referencia || '', 
      nombre, 
      categoria, 
      finalCantidad, 
      precio_compra, 
      porcentaje_ganancia, 
      precio_venta, 
      es_servicio ? 1 : 0, 
      permitir_venta_negativa !== undefined ? (permitir_venta_negativa ? 1 : 0) : 1,
      parseFloat(req.body.iva_porcentaje) || 0,
      req.body.fecha_vencimiento || null
    ], 
    (err: any, results: any) => {
      if (err) {
        console.error("Error al insertar producto:", err);
        return res.status(500).json({ error: "Error insertando producto" });
      }
      const newId = results.insertId;

      // Registro automático en Kardex (ENTRADA inicial) solo si NO es servicio y tiene cantidad
      if (!es_servicio && finalCantidad > 0) {
        connection.query(
          "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre) VALUES (?, ?, 'ENTRADA', 0, ?, ?, 'Registro inicial de producto', ?)",
          [newId, empresa_id, finalCantidad, finalCantidad, req.user.username || 'Admin'],
          (errK) => { if (errK) console.error("Kardex Init Error:", errK); }
        );
      }

      // Notificar a todos los dispositivos de la empresa
      if (req.io) {
        req.io.to(`empresa_${empresa_id}`).emit('product_updated', {
          id: newId,
          referencia: referencia || '',
          nombre,
          categoria,
          precio_venta,
          precio_compra,
          iva_porcentaje: req.body.iva_porcentaje || 0,
          cantidad: finalCantidad
        });
      }

      res.status(201).json({ id: newId, empresa_id, referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta });
    }
  );
});

// Guardado en Lote (Batch) - Requiere permiso de ingreso
router.post("/batch", verifyPermission("ingreso"), async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const productosData = req.body; 
  
  if (!Array.isArray(productosData) || productosData.length === 0) {
    return res.status(400).json({ error: "No se proporcionaron productos válidos." });
  }

  const promiseDb = connection.promise();
  const conn = await promiseDb.getConnection();

  try {
    await conn.beginTransaction();

    for (const p of productosData) {
      let finalId: number;
      let stockAntes = 0;
      const isServicio = !!p.es_servicio;
      const cantIn = isServicio ? 0 : (p.cantidad || 0);

      if (p.referencia && p.referencia.trim() !== '') {
        const [existing]: any = await conn.query("SELECT id, cantidad FROM productos WHERE empresa_id = ? AND referencia = ? FOR UPDATE", [empresa_id, p.referencia]);
        
        if (existing.length > 0) {
          finalId = existing[0].id;
          stockAntes = existing[0].cantidad;
          const qUpdate = isServicio 
            ? "UPDATE productos SET precio_compra = ?, precio_venta = ?, porcentaje_ganancia = ?, es_servicio = 1, permitir_venta_negativa = ?, fecha_vencimiento = ? WHERE id = ? AND empresa_id = ?"
            : "UPDATE productos SET cantidad = cantidad + ?, precio_compra = ?, precio_venta = ?, porcentaje_ganancia = ?, es_servicio = 0, permitir_venta_negativa = ?, fecha_vencimiento = ? WHERE id = ? AND empresa_id = ?";
          
          const paramsUpdate = isServicio
            ? [p.precio_compra, p.precio_venta, p.porcentaje_ganancia, p.permitir_venta_negativa !== undefined ? (p.permitir_venta_negativa ? 1 : 0) : 1, p.fecha_vencimiento || null, finalId, empresa_id]
            : [cantIn, p.precio_compra, p.precio_venta, p.porcentaje_ganancia, p.permitir_venta_negativa !== undefined ? (p.permitir_venta_negativa ? 1 : 0) : 1, p.fecha_vencimiento || null, finalId, empresa_id];

          await conn.query(qUpdate, paramsUpdate);
        } else {
          const [result]: any = await conn.query(
            "INSERT INTO productos (empresa_id, referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta, es_servicio, permitir_venta_negativa, iva_porcentaje, fecha_vencimiento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [empresa_id, p.referencia || '', p.nombre, p.categoria, cantIn, p.precio_compra, p.porcentaje_ganancia, p.precio_venta, isServicio ? 1 : 0, p.permitir_venta_negativa !== undefined ? (p.permitir_venta_negativa ? 1 : 0) : 1, p.iva_porcentaje || 0, p.fecha_vencimiento || null]
          );
          finalId = result.insertId;
        }
      } else {
        const [result]: any = await conn.query(
            "INSERT INTO productos (empresa_id, referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta, es_servicio, permitir_venta_negativa, iva_porcentaje, fecha_vencimiento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [empresa_id, '', p.nombre, p.categoria, cantIn, p.precio_compra, p.porcentaje_ganancia, p.precio_venta, isServicio ? 1 : 0, p.permitir_venta_negativa !== undefined ? (p.permitir_venta_negativa ? 1 : 0) : 1, p.iva_porcentaje || 0, p.fecha_vencimiento || null]
          );
          finalId = result.insertId;
      }

      // Registro en Kardex solo si hay movimiento o es cambio relevante (tipo_movimiento dinámico)
      const stockDespues = isServicio ? stockAntes : (stockAntes + cantIn);
      const movKardex = isServicio ? 'INGRESO_SERVICIO_LOTE' : 'ENTRADA_LOTE';

      if (cantIn > 0 || isServicio) {
        await conn.query(
          "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, ?, ?, ?, ?, 'Ingreso por Lote / Compra', ?, 'LOTE-BATCH')",
          [finalId, empresa_id, movKardex, stockAntes, cantIn, stockDespues, req.user.username || 'Admin']
        );
      }
    }
    
    await conn.commit();

    // Notificación Masiva por Sockets
    if (req.io) {
       req.io.to(`empresa_${empresa_id}`).emit('inventory_batch_updated', { empresa_id });
    }

    res.status(201).json({ message: "Lote guardado y Kardex actualizado con éxito", affectedRows: productosData.length });
  } catch (err) {
    await conn.rollback();
    console.error("Error al procesar lote de productos:", err);
    res.status(500).json({ error: "Error actualizando el inventario por lotes. Los cambios han sido revertidos." });
  } finally {
    conn.release();
  }
});

// Ajuste rápido de inventario - Requiere permiso de ajustes
router.put("/:id/ajustar", verifyPermission("ajustes"), async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const productoId = req.params.id;
  const { nueva_cantidad, motivo, responsable } = req.body;
  const usuario = responsable || req.user.nombre || "Admin"; 

  if (nueva_cantidad === undefined || isNaN(nueva_cantidad)) {
    return res.status(400).json({ error: "Cantidad no válida proporcionada" });
  }
  if (!motivo) {
    return res.status(400).json({ error: "El motivo del ajuste es obligatorio para el Kardex." });
  }

  const promiseDb = connection.promise();
  const conn = await promiseDb.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Obtener stock actual con bloqueo
    const [stocks]: any = await conn.query("SELECT cantidad FROM productos WHERE id = ? AND empresa_id = ? FOR UPDATE", [productoId, empresa_id]);
    if (stocks.length === 0) throw new Error("Producto no encontrado");
    
    const stock_antes = stocks[0].cantidad;
    const stock_despues = parseInt(nueva_cantidad, 10);
    const diferencia = stock_despues - stock_antes;

    // 2. Actualizar stock
    await conn.query("UPDATE productos SET cantidad = ? WHERE id = ? AND empresa_id = ?", [stock_despues, productoId, empresa_id]);
      
    // 3. Registrar en Kardex
    await conn.query(
      "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre) VALUES (?, ?, 'AJUSTE', ?, ?, ?, ?, ?)",
      [productoId, empresa_id, stock_antes, Math.abs(diferencia), stock_despues, motivo, usuario]
    );

    await conn.commit();
    res.json({ success: true, message: "Inventario nivelado y registrado en Kardex correctamente." });
  } catch (err: any) {
    await conn.rollback();
    console.error("Error en ajuste de inventario:", err);
    res.status(500).json({ error: err.message || "No se pudo ajustar el inventario" });
  } finally {
    conn.release();
  }
});

// Inyectar stock incremental desde un borrador (Tiempo Real)
router.post("/inyectar-stock", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { items } = req.body;

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ error: "No se proporcionaron ítems válidos." });
  }

  const promiseDb = connection.promise();
  const conn = await promiseDb.getConnection();

  try {
    await conn.beginTransaction();

    for (const item of items) {
      const delta = parseFloat(item.delta) || 0;
      if (delta <= 0) continue;

      let product_id: number | null = null;
      let stockAntes = 0;

      // 1. Intentar encontrar el producto por referencia o nombre
      let queryFind = "SELECT id, cantidad FROM productos WHERE empresa_id = ? AND ";
      let paramsFind: any[] = [empresa_id];

      if (item.referencia && item.referencia.trim() !== "") {
        queryFind += "referencia = ? ";
        paramsFind.push(item.referencia);
      } else {
        queryFind += "nombre = ? ";
        paramsFind.push(item.nombre);
      }
      queryFind += " FOR UPDATE";

      const [existing]: any = await conn.query(queryFind, paramsFind);

      if (existing.length > 0) {
        product_id = existing[0].id;
        stockAntes = existing[0].cantidad;
        // Actualizar stock
        await conn.query(
          "UPDATE productos SET cantidad = cantidad + ?, precio_compra = ?, precio_venta = ?, porcentaje_ganancia = ? WHERE id = ?",
          [delta, item.precio_compra, item.precio_venta, item.porcentaje_ganancia, product_id]
        );
      } else {
        // Crear producto nuevo si no existe
        const [result]: any = await conn.query(
          "INSERT INTO productos (empresa_id, referencia, nombre, categoria, cantidad, precio_compra, porcentaje_ganancia, precio_venta, es_servicio, permitir_venta_negativa, iva_porcentaje, fecha_vencimiento) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
          [
            empresa_id, 
            item.referencia || '', 
            item.nombre, 
            item.categoria, 
            delta, 
            item.precio_compra, 
            item.porcentaje_ganancia, 
            item.precio_venta, 
            item.es_servicio ? 1 : 0, 
            item.permitir_venta_negativa !== undefined ? (item.permitir_venta_negativa ? 1 : 0) : 1,
            item.iva_porcentaje || 0,
            item.fecha_vencimiento || null
          ]
        );
        product_id = result.insertId;
      }

      // 2. Registrar en Kardex
      await conn.query(
        "INSERT INTO kardex (producto_id, empresa_id, tipo_movimiento, cantidad_antes, cantidad_modificada, cantidad_despues, motivo, usuario_nombre, referencia) VALUES (?, ?, 'ENTRADA_BORRADOR', ?, ?, ?, 'Inyección incremental desde borrador', ?, ?)",
        [
          product_id, 
          empresa_id, 
          stockAntes, 
          delta, 
          stockAntes + delta, 
          req.user.username || 'Sistema', 
          item.referencia || 'S/REF'
        ]
      );
    }

    await conn.commit();

    // Notificación en tiempo real para que otros módulos (como Ventas/Separados) vean el nuevo stock
    if (req.io) {
      req.io.to(`empresa_${empresa_id}`).emit('inventory_batch_updated', { empresa_id });
    }

    res.json({ success: true, message: "Stock inyectado correctamente." });
  } catch (err: any) {
    await conn.rollback();
    console.error("Error al inyectar stock:", err);
    res.status(500).json({ error: "Error interno al inyectar stock: " + err.message });
  } finally {
    conn.release();
  }
});

// Revertir (restar) stock de un producto inyectado desde un borrador
router.post("/revertir-stock", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { referencia, nombre, cantidad } = req.body;
  
  if (!cantidad || isNaN(cantidad)) {
    return res.status(400).json({ error: "Cantidad no válida" });
  }

  const promiseDb = connection.promise();
  try {
    if (referencia && referencia.trim() !== "") {
       await promiseDb.query("UPDATE productos SET cantidad = cantidad - ? WHERE empresa_id = ? AND referencia = ? ORDER BY id DESC LIMIT 1", [cantidad, empresa_id, referencia]);
    } else if (nombre) {
       await promiseDb.query("UPDATE productos SET cantidad = cantidad - ? WHERE empresa_id = ? AND nombre = ? ORDER BY id DESC LIMIT 1", [cantidad, empresa_id, nombre]);
    } else {
       return res.status(400).json({ error: "Especifica referencia o nombre" });
    }
    
    res.json({ success: true, message: "Stock descontado exitosamente" });
  } catch(err) {
    console.error("Error revirtiendo stock:", err);
    res.status(500).json({ error: "No se pudo revertir el stock" });
  }
});


// Obtener categorías únicas por empresa
router.get("/categorias", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  try {
    const [results]: any = await connection.promise().query(
      "SELECT DISTINCT categoria FROM productos WHERE empresa_id = ? AND categoria IS NOT NULL AND categoria != '' ORDER BY categoria ASC",
      [empresa_id]
    );
    const categorias = results.map((r: any) => r.categoria);
    res.json(categorias);
  } catch (err) {
    console.error("Error al obtener categorías:", err);
    res.status(500).json({ error: "Error al obtener categorías" });
  }
});

export default router;

