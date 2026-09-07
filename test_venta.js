const mysql = require('mysql2');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();

async function test() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST || "127.0.0.1",
    user: process.env.DB_USER || "root",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "tienda_db",
    port: Number(process.env.DB_PORT) || 3306,
  }).promise();

  const conn = await pool.getConnection();
  try {
    console.log("Connected to MySQL successfully.");
    
    // Get mock data
    const [cajeros] = await conn.query("SELECT id FROM cajeros LIMIT 1");
    const [clientes] = await conn.query("SELECT id FROM clientes LIMIT 1");
    const [productos] = await conn.query("SELECT id, cantidad, es_servicio, permitir_venta_negativa, precio_venta, precio_compra FROM productos WHERE es_servicio = 0 LIMIT 1");
    
    if (cajeros.length === 0 || clientes.length === 0 || productos.length === 0) {
      console.log("Please make sure you have at least 1 cajero, 1 cliente and 1 producto in the DB.");
      console.log("Cajeros:", cajeros.length, "Clientes:", clientes.length, "Productos:", productos.length);
      conn.release();
      await pool.end();
      return;
    }

    const cId = cajeros[0].id;
    const clId = clientes[0].id;
    const prod = productos[0];
    
    const empresa_id = 1;
    const items = [
      {
        id: prod.id,
        qty: 1,
        precio_venta: Number(prod.precio_venta),
        descuento: 0
      }
    ];
    const metodoPago = "Efectivo";
    const efectivoEntregado = Number(prod.precio_venta);
    const transferenciaEntregada = 0;
    const vuelto = 0;
    const total = Number(prod.precio_venta);
    const iva = 0;
    
    console.log("Simulating sale with:");
    console.log("cId:", cId, "clId:", clId, "prodId:", prod.id, "qty: 1");

    await conn.beginTransaction();

    // 0. Config
    const [configs] = await conn.query(
      "SELECT permitir_venta_negativa FROM empresa_config WHERE empresa_id = ?", 
      [empresa_id]
    );
    const permitirNegativoGlobal = configs && configs[0] ? !!configs[0].permitir_venta_negativa : true;
    console.log("permitirNegativoGlobal:", permitirNegativoGlobal);

    let percComision = 0;
    if (cId) {
      const [cData] = await conn.query("SELECT paga_comisiones, porcentaje_comision_base FROM cajeros WHERE id = ?", [cId]);
      if (cData.length > 0 && cData[0].paga_comisiones) {
        percComision = parseFloat(cData[0].porcentaje_comision_base) || 0;
      }
    }
    console.log("percComision:", percComision);

    const vlt = parseFloat(vuelto) || 0;
    const pefRaw = parseFloat(efectivoEntregado) || 0;
    const pef = Math.max(0, pefRaw - vlt); 
    const ptr = parseFloat(transferenciaEntregada) || 0;
    const ivaVal = Math.round((parseFloat(iva) || 0) * 100) / 100;
    const totalVal = Math.round((parseFloat(total) || 0) * 100) / 100;

    // 1. Insert Factura
    console.log("Inserting into facturas_venta...");
    const [resCab] = await conn.query(
      "INSERT INTO facturas_venta (empresa_id, cajero_id, cliente_id, total, iva, metodo_pago, pago_efectivo, pago_transferencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      [empresa_id, cId, clId, totalVal, ivaVal, metodoPago, pef, ptr]
    );
    const facturaId = resCab.insertId;
    console.log("Inserted factura ID:", facturaId);

    // 2. Details
    for (const item of items) {
      if (!item.id || !item.qty) {
        throw new Error("Datos de producto inválidos en el carrito.");
      }

      console.log("Querying product details for ID:", item.id);
      const [prodData] = await conn.query(
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

      if (!esServicio && !permitirNegativoGlobal && !permitirNegativoProd) {
        if (stockDisponible < item.qty) {
          throw new Error(`Stock insuficiente para: ${producto.nombre}. Disponible: ${stockDisponible}`);
        }
      }

      const subtotalItem = item.precio_venta * item.qty;
      const comisionItem = Math.round((subtotalItem * (percComision / 100)) * 100) / 100;

      console.log("Inserting into ventas...");
      await conn.query(
        "INSERT INTO ventas (empresa_id, factura_id, producto_id, cantidad, precio_unitario, costo_unitario, comision) VALUES (?, ?, ?, ?, ?, ?, ?)",
        [empresa_id, facturaId, item.id, item.qty, item.precio_venta, producto.precio_compra || 0, comisionItem]
      );

      const stockChange = esServicio ? 0 : item.qty;
      if (stockChange !== 0) {
        console.log("Updating product stock...");
        await conn.query(
          "UPDATE productos SET cantidad = cantidad - ? WHERE id = ? AND empresa_id = ?",
          [stockChange, item.id, empresa_id]
        );

        const usuario_venta = 'TestCajero';
        console.log("Inserting into kardex...");
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

    console.log("Transaction succeeded! Rolling back to avoid changing DB.");
    await conn.rollback();
    console.log("Rollback completed successfully.");

  } catch (error) {
    console.log("Error caught during transaction simulation:");
    console.error(error);
    try {
      await conn.rollback();
      console.log("Transaction rolled back after error.");
    } catch (rollbackErr) {
      console.error("Error during rollback:", rollbackErr);
    }
  } finally {
    conn.release();
    await pool.end();
  }
}

test();
