import express from "express";
import pool from "../conection";
import { verifyTokenAndTenant, verifyPermission } from "../middlewares/authMiddleware";

const router = express.Router();

router.use(verifyTokenAndTenant);

// ==========================================
// CUENTAS POR COBRAR (CxC)
// ==========================================

router.get("/cxc", verifyPermission("cartera"), (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const query = `
    SELECT cxc.id, cxc.empresa_id, cxc.factura_venta_id, cxc.cliente_id, cxc.monto_total, cxc.saldo_pendiente, cxc.estado, cxc.fecha_vencimiento, cxc.fecha_creacion, c.nombre AS cliente_nombre, f.id AS factura_venta_id_real, 'cxc' as tipo_cxc
    FROM cuentas_por_cobrar cxc
    LEFT JOIN clientes c ON cxc.cliente_id = c.id
    LEFT JOIN facturas_venta f ON cxc.factura_venta_id = f.id
    WHERE cxc.empresa_id = ?
    
    UNION ALL
    
    SELECT s.id, s.empresa_id, NULL as factura_venta_id, s.cliente_id, s.total as monto_total, s.saldo_pendiente, s.estado, s.fecha_vencimiento, s.fecha_inicio as fecha_creacion, c.nombre AS cliente_nombre, NULL as factura_venta_id_real, 'separado' as tipo_cxc
    FROM separados s
    LEFT JOIN clientes c ON s.cliente_id = c.id
    WHERE s.empresa_id = ?
    
    ORDER BY fecha_creacion DESC
  `;
  pool.query(query, [empresa_id, empresa_id], (err: any, results: any) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

router.post("/cxc", verifyPermission("cartera"), (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { cliente_id, monto_total, fecha_vencimiento } = req.body;

  if (!cliente_id || !monto_total) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  const query = "INSERT INTO cuentas_por_cobrar (empresa_id, cliente_id, monto_total, saldo_pendiente, fecha_vencimiento, estado) VALUES (?, ?, ?, ?, ?, 'Pendiente')";
  pool.query(query, [empresa_id, cliente_id, monto_total, monto_total, fecha_vencimiento || null], (err: any, result: any) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: result.insertId, message: "Cuenta por cobrar creada manualmente" });
  });
});

router.post("/cxc/:id/abono", verifyPermission("cartera"), async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const cxc_id = req.params.id;
  const { monto, metodo_pago } = req.body;

  if (!monto || monto <= 0) return res.status(400).json({ error: "Monto inválido" });

  const promiseDb = pool.promise();
  const conn = await promiseDb.getConnection();

  try {
    await conn.beginTransaction();

    const [cxcRows]: any = await conn.query("SELECT saldo_pendiente FROM cuentas_por_cobrar WHERE id = ? AND empresa_id = ? FOR UPDATE", [cxc_id, empresa_id]);
    if (cxcRows.length === 0) throw new Error("Cuenta no encontrada");

    let saldo = parseFloat(cxcRows[0].saldo_pendiente);
    let abono = parseFloat(monto);

    if (abono > saldo) abono = saldo; // No abonar más de lo que debe
    const nuevoSaldo = saldo - abono;
    const nuevoEstado = nuevoSaldo <= 0 ? 'Pagada' : 'Pendiente';

    await conn.query("UPDATE cuentas_por_cobrar SET saldo_pendiente = ?, estado = ? WHERE id = ?", [nuevoSaldo, nuevoEstado, cxc_id]);
    await conn.query("INSERT INTO abonos_cxc (empresa_id, cxc_id, monto, metodo_pago) VALUES (?, ?, ?, ?)", [empresa_id, cxc_id, abono, metodo_pago || 'Efectivo']);

    // Registrar en movimientos_caja si se afecta la caja
    const sesion_caja_id = req.body.sesion_caja_id;
    if (sesion_caja_id) {
        await conn.query(
            "INSERT INTO movimientos_caja (empresa_id, usuario_id, sesion_caja_id, tipo, monto, descripcion) VALUES (?, ?, ?, 'Ingreso', ?, ?)",
            [empresa_id, req.user.id || req.user.cajero_id || 1, sesion_caja_id, abono, `Abono a CxC #${cxc_id}`]
        );
    }

    await conn.commit();
    res.json({ message: "Abono registrado", saldo_restante: nuevoSaldo, estado: nuevoEstado });
  } catch (err: any) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

router.get("/cxc/:id/abonos", verifyPermission("cartera"), (req: any, res: any) => {
    const empresa_id = req.user.empresa_id;
    pool.query("SELECT * FROM abonos_cxc WHERE cxc_id = ? AND empresa_id = ? ORDER BY fecha_pago DESC", [req.params.id, empresa_id], (err: any, results: any) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});


// ==========================================
// CUENTAS POR PAGAR (CxP)
// ==========================================

router.get("/cxp", verifyPermission("cartera"), (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const query = `
    SELECT * FROM cuentas_por_pagar
    WHERE empresa_id = ?
    ORDER BY fecha_creacion DESC
  `;
  pool.query(query, [empresa_id], (err: any, results: any) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

router.post("/cxp", verifyPermission("cartera"), (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { proveedor, numero_factura, monto_total, fecha_vencimiento } = req.body;

  if (!proveedor || !monto_total) {
    return res.status(400).json({ error: "Faltan datos obligatorios" });
  }

  const query = "INSERT INTO cuentas_por_pagar (empresa_id, proveedor, numero_factura, monto_total, saldo_pendiente, fecha_vencimiento, estado) VALUES (?, ?, ?, ?, ?, ?, 'Pendiente')";
  pool.query(query, [empresa_id, proveedor, numero_factura || '', monto_total, monto_total, fecha_vencimiento || null], (err: any, result: any) => {
    if (err) return res.status(500).json({ error: err.message });
    res.status(201).json({ id: result.insertId, message: "Cuenta por pagar creada manualmente" });
  });
});

router.post("/cxp/:id/abono", verifyPermission("cartera"), async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const cxp_id = req.params.id;
  const { monto, metodo_pago } = req.body;

  if (!monto || monto <= 0) return res.status(400).json({ error: "Monto inválido" });

  const promiseDb = pool.promise();
  const conn = await promiseDb.getConnection();

  try {
    await conn.beginTransaction();

    const [cxpRows]: any = await conn.query("SELECT saldo_pendiente FROM cuentas_por_pagar WHERE id = ? AND empresa_id = ? FOR UPDATE", [cxp_id, empresa_id]);
    if (cxpRows.length === 0) throw new Error("Cuenta no encontrada");

    let saldo = parseFloat(cxpRows[0].saldo_pendiente);
    let abono = parseFloat(monto);

    if (abono > saldo) abono = saldo; // No abonar más de lo que debe
    const nuevoSaldo = saldo - abono;
    const nuevoEstado = nuevoSaldo <= 0 ? 'Pagada' : 'Pendiente';

    await conn.query("UPDATE cuentas_por_pagar SET saldo_pendiente = ?, estado = ? WHERE id = ?", [nuevoSaldo, nuevoEstado, cxp_id]);
    await conn.query("INSERT INTO abonos_cxp (empresa_id, cxp_id, monto, metodo_pago) VALUES (?, ?, ?, ?)", [empresa_id, cxp_id, abono, metodo_pago || 'Efectivo']);

    // Registrar en movimientos_caja si se afecta la caja
    const sesion_caja_id = req.body.sesion_caja_id;
    if (sesion_caja_id) {
        await conn.query(
            "INSERT INTO movimientos_caja (empresa_id, usuario_id, sesion_caja_id, tipo, monto, descripcion) VALUES (?, ?, ?, 'Salida', ?, ?)",
            [empresa_id, req.user.id || req.user.cajero_id || 1, sesion_caja_id, abono, `Abono a CxP #${cxp_id}`]
        );
    }

    await conn.commit();
    res.json({ message: "Abono registrado", saldo_restante: nuevoSaldo, estado: nuevoEstado });
  } catch (err: any) {
    await conn.rollback();
    res.status(500).json({ error: err.message });
  } finally {
    conn.release();
  }
});

router.put("/cxp/:id/soporte", verifyPermission("cartera"), (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const cxp_id = req.params.id;
  const { soporte_url } = req.body;

  if (!soporte_url) return res.status(400).json({ error: "Soporte no proporcionado" });

  const query = "UPDATE cuentas_por_pagar SET soporte_url = ? WHERE id = ? AND empresa_id = ?";
  pool.query(query, [soporte_url, cxp_id, empresa_id], (err: any) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ message: "Soporte guardado con éxito" });
  });
});

router.get("/cxp/:id/abonos", verifyPermission("cartera"), (req: any, res: any) => {
    const empresa_id = req.user.empresa_id;
    pool.query("SELECT * FROM abonos_cxp WHERE cxp_id = ? AND empresa_id = ? ORDER BY fecha_pago DESC", [req.params.id, empresa_id], (err: any, results: any) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(results);
    });
});

export default router;
