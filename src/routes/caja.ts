import express from "express";
import connection from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

const centavos = (n: any) => Math.round(Number(n) * 100);

function getQueryVentas(empresa_id: any, cajero_id: any, fecha_apertura: any) {
  const sql = `
    SELECT 
      COALESCE(SUM(total_bruto), 0) as total_ventas,
      COALESCE(SUM(efectivo), 0) as total_efectivo,
      COALESCE(SUM(IF(metodo_pago LIKE '%Transferencia%' OR metodo_pago = 'Mixto', transferencia, 0)), 0) as total_transferencia,
      COALESCE(SUM(IF(metodo_pago = 'Tarjeta', transferencia, 0)), 0) as total_tarjeta,
      COALESCE(SUM(IF(metodo_pago = 'Addi', transferencia, 0)), 0) as total_addi,
      COALESCE(SUM(IF(metodo_pago = 'Sistecredito', transferencia, 0)), 0) as total_sistecredito,
      COALESCE(SUM(IF(tipo_origen = 'ABONO_SEPARADO' AND total_bruto > 0, total_bruto, 0)), 0) as total_abonos_separados,
      COALESCE(SUM(IF(tipo_origen = 'ABONO_SEPARADO' AND total_bruto < 0, ABS(total_bruto), 0)), 0) as total_devoluciones_separados,
      COALESCE(SUM(IF(tipo_origen = 'ABONO_SEPARADO' AND total_bruto > 0, efectivo, 0)), 0) as efectivo_abonos_separados,
      COALESCE(SUM(IF(tipo_origen = 'ABONO_SEPARADO' AND total_bruto < 0, ABS(efectivo), 0)), 0) as efectivo_devoluciones_separados
    FROM (
      SELECT 
        'VENTA' as tipo_origen,
        total as total_bruto,
        pago_efectivo as efectivo,
        pago_transferencia as transferencia,
        metodo_pago,
        fecha,
        cajero_id,
        empresa_id
      FROM facturas_venta

      UNION ALL

      SELECT 
        'FACTURA_ELECTRONICA' as tipo_origen,
        total as total_bruto,
        pago_efectivo as efectivo,
        pago_transferencia as transferencia,
        metodo_pago,
        fecha_emision as fecha,
        cajero_id,
        empresa_id
      FROM facturas_electronicas

      UNION ALL

      SELECT 
        'ABONO_SEPARADO' as tipo_origen,
        monto as total_bruto,
        pago_efectivo as efectivo,
        pago_transferencia as transferencia,
        metodo_pago,
        fecha_pago as fecha,
        cajero_id,
        empresa_id
      FROM abonos_separados

      UNION ALL

      SELECT 
        'CAMBIO_FACTURA' as tipo_origen,
        saldo_adicional as total_bruto,
        IF(metodo_pago = 'Efectivo', saldo_adicional, 0) as efectivo,
        IF(metodo_pago != 'Efectivo', saldo_adicional, 0) as transferencia,
        metodo_pago,
        fecha,
        cajero_id,
        empresa_id
      FROM cambios_factura
      WHERE saldo_adicional > 0
    ) AS todas_ventas
    WHERE empresa_id = ? 
      ${cajero_id ? "AND (cajero_id = ? OR cajero_id IS NULL)" : ""}
      AND fecha >= ?
  `;

  const params = cajero_id ? [empresa_id, cajero_id, fecha_apertura] : [empresa_id, fecha_apertura];
  return { sql, params };
}

// Obtener estado actual de la caja para un usuario
router.get("/estado-actual", verifyTokenAndTenant, (req: any, res: any) => {
  const usuario_id = req.user.id;
  const empresa_id = req.user.empresa_id;

  const query = `
    SELECT * FROM sesiones_caja 
    WHERE usuario_id = ? AND empresa_id = ? AND estado = 'Abierta'
    ORDER BY fecha_apertura DESC LIMIT 1
  `;

  connection.query(query, [usuario_id, empresa_id], async (err: any, results: any[]) => {
    if (err) {
      console.error("Error al consultar caja:", err);
      return res.status(500).json({ error: "Error al consultar caja" });
    }

    if (results.length === 0) {
      return res.json({ abierta: false });
    }

    const sesion = results[0];
    const cajero_id = req.user.cajero_id;
    const { sql: queryVentas, params } = getQueryVentas(empresa_id, cajero_id, sesion.fecha_apertura);

    connection.query(queryVentas, params, (errV: any, resultsV: any[]) => {
      if (errV) {
        console.error("Error al calcular ventas:", errV);
        return res.status(500).json({ error: "Error al calcular ventas" });
      }

      const totals = resultsV[0];

      // Consultar movimientos manuales (Ingresos y Salidas)
      const queryMovs = `
          SELECT 
            SUM(IF(tipo = 'Ingreso', ABS(monto), 0)) as total_ingresos,
            SUM(IF(tipo = 'Salida', ABS(monto), 0)) as total_salidas
          FROM movimientos_caja
          WHERE sesion_caja_id = ? AND empresa_id = ?
        `;

      connection.query(queryMovs, [sesion.id, empresa_id], (errM: any, resultsM: any[]) => {
        if (errM) {
          console.error("Error al calcular movimientos:", errM);
          return res.status(500).json({ error: "Error al calcular movimientos" });
        }

        const movs = resultsM[0];
        const ingresos = parseFloat(movs.total_ingresos || 0);
        const salidas = parseFloat(movs.total_salidas || 0);
        const total_efectivo_ventas = parseFloat(totals.total_efectivo || 0);

        res.json({
          abierta: true,
          sesion: {
            ...sesion,
            total_ventas: parseFloat(totals.total_ventas || 0),
            total_efectivo: total_efectivo_ventas,
            total_transferencia: parseFloat(totals.total_transferencia || 0),
            total_tarjeta: parseFloat(totals.total_tarjeta || 0),
            total_addi: parseFloat(totals.total_addi || 0),
            total_sistecredito: parseFloat(totals.total_sistecredito || 0),
            total_abonos_separados: parseFloat(totals.total_abonos_separados || 0),
            total_devoluciones_separados: parseFloat(totals.total_devoluciones_separados || 0),
            efectivo_abonos_separados: parseFloat(totals.efectivo_abonos_separados || 0),
            efectivo_devoluciones_separados: parseFloat(totals.efectivo_devoluciones_separados || 0),
            total_ingresos: ingresos,
            total_salidas: salidas,
            // FÓRMULA MAESTRA: Base + Efectivo de Ventas y Abonos + Ajustes Positivos - Ajustes Negativos
            valor_esperado: parseFloat(sesion.base_caja) + total_efectivo_ventas + ingresos - salidas
          }
        });
      });
    });
  });
});

// Apertura de caja
router.post("/apertura", verifyTokenAndTenant, (req: any, res: any) => {
  const { base_caja } = req.body;
  const usuario_id = req.user.id;
  const empresa_id = req.user.empresa_id;

  console.log(`[CAJA_APERTURA] Intento por Usuario: ${usuario_id}, Empresa: ${empresa_id}, Base: ${base_caja}`);

  if (base_caja === undefined || base_caja === null) {
    return res.status(400).json({ error: "El valor base es obligatorio" });
  }

  // Verificar si ya tiene una abierta
  connection.query(
    "SELECT id FROM sesiones_caja WHERE usuario_id = ? AND empresa_id = ? AND estado = 'Abierta'",
    [usuario_id, empresa_id],
    (err: any, results: any[]) => {
      if (err) {
        console.error("Error verificando sesión abierta:", err);
        return res.status(500).json({ error: "Error de servidor" });
      }

      if (results.length > 0) return res.status(400).json({ error: "Ya existe una sesión de caja abierta" });

      const queryInsert = `
        INSERT INTO sesiones_caja (empresa_id, usuario_id, base_caja, estado)
        VALUES (?, ?, ?, 'Abierta')
      `;

      connection.query(queryInsert, [empresa_id, usuario_id, base_caja], (errI: any) => {
        if (errI) {
          console.error("Error al insertar sesión de caja:", errI);
          return res.status(500).json({ error: "Error al abrir caja", detalle: errI.message });
        }
        // Notificar por Socket
        if (req.io) {
          req.io.to(`empresa_${empresa_id}`).emit('caja_abierta', { usuario_id, base_caja });
        }
        res.json({ success: true, message: "Caja abierta correctamente" });
      });

    }
  );
});

// Cierre de caja
router.post("/cierre", verifyTokenAndTenant, async (req: any, res: any) => {
  const { dinero_reportado } = req.body;
  const usuario_id = req.user.id;
  const empresa_id = req.user.empresa_id;
  const cajero_id = req.user.cajero_id;

  if (dinero_reportado === undefined || dinero_reportado === null || !Number.isFinite(Number(dinero_reportado))) {
    return res.status(400).json({ error: "El dinero reportado es obligatorio" });
  }

  let conn: any;
  try {
    conn = await connection.promise().getConnection();
    await conn.beginTransaction();

    const [results]: any = await conn.query(
      "SELECT * FROM sesiones_caja WHERE usuario_id = ? AND empresa_id = ? AND estado = 'Abierta' ORDER BY fecha_apertura DESC LIMIT 1 FOR UPDATE",
      [usuario_id, empresa_id]
    );
    if (!results.length) {
      await conn.rollback();
      return res.status(404).json({ error: 'No hay sesión abierta para cerrar' });
    }
    const sesion = results[0];
    const { sql, params } = getQueryVentas(empresa_id, cajero_id, sesion.fecha_apertura);
    const [ventas]: any = await conn.query(sql, params);
    const totals = ventas[0];

    const [movimientos]: any = await conn.query(`SELECT
      SUM(IF(tipo = 'Ingreso', ABS(monto), 0)) AS total_ingresos,
      SUM(IF(tipo = 'Salida', ABS(monto), 0)) AS total_salidas
      FROM movimientos_caja WHERE sesion_caja_id = ? AND empresa_id = ?`, [sesion.id, empresa_id]);

    const total_ventas = Number(totals.total_ventas || 0);
    const total_efectivo = Number(totals.total_efectivo || 0);
    const total_transferencia = Number(totals.total_transferencia || 0);
    const total_tarjeta = Number(totals.total_tarjeta || 0);
    const total_addi = Number(totals.total_addi || 0);
    const total_sistecredito = Number(totals.total_sistecredito || 0);
    const total_abonos_separados = Number(totals.total_abonos_separados || 0);
    const total_devoluciones_separados = Number(totals.total_devoluciones_separados || 0);
    const efectivo_abonos_separados = Number(totals.efectivo_abonos_separados || 0);
    const efectivo_devoluciones_separados = Number(totals.efectivo_devoluciones_separados || 0);

    const ingresos = Number(movimientos[0].total_ingresos || 0);
    const salidas = Number(movimientos[0].total_salidas || 0);
    const valor_esperado = Number(sesion.base_caja) + total_efectivo + ingresos - salidas;
    const diferencia = Number(dinero_reportado) - valor_esperado;

    await conn.query(`UPDATE sesiones_caja SET fecha_cierre = CURRENT_TIMESTAMP,
      total_ventas = ?, total_efectivo = ?, total_transferencia = ?, total_tarjeta = ?,
      total_addi = ?, total_sistecredito = ?, total_ingresos = ?, total_salidas = ?,
      dinero_reportado = ?, diferencia = ?, estado = 'Cerrada' WHERE id = ? AND empresa_id = ?`,
      [total_ventas, total_efectivo, total_transferencia, total_tarjeta, total_addi, total_sistecredito,
        ingresos, salidas, dinero_reportado, diferencia, sesion.id, empresa_id]);

    await conn.commit();

    if (req.io) req.io.to(`empresa_${empresa_id}`).emit('caja_cerrada', { usuario_id, resumen: { total_ventas, dinero_reportado, diferencia } });

    res.json({ success: true, resumen: {
      total_ventas, total_efectivo, total_transferencia, total_tarjeta, total_addi, total_sistecredito,
      total_abonos_separados,
      total_devoluciones_separados,
      efectivo_abonos_separados,
      efectivo_devoluciones_separados,
      total_ingresos: ingresos, total_salidas: salidas, valor_esperado, diferencia, dinero_reportado
    } });
  } catch (error: any) {
    if (conn) await conn.rollback();
    console.error('Error al cerrar caja:', error);
    res.status(500).json({ error: 'Error al cerrar caja' });
  } finally {
    if (conn) conn.release();
  }
});

// Historial de reportes
router.get("/reportes", verifyTokenAndTenant, (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { desde, hasta, usuario_id } = req.query;

  let query = `
    SELECT s.*, u.username 
    FROM sesiones_caja s
    JOIN usuarios_plataforma u ON s.usuario_id = u.id
    WHERE s.empresa_id = ?
  `;
  const params: any[] = [empresa_id];

  if (desde) {
    query += " AND (s.fecha_cierre >= ? OR s.estado = 'Abierta')";
    params.push(`${desde} 00:00:00`);
  }
  if (hasta) {
    query += " AND s.fecha_apertura <= ?";
    params.push(`${hasta} 23:59:59`);
  }
  if (usuario_id) {
    query += " AND s.usuario_id = ?";
    params.push(usuario_id);
  }
  if (req.query.estado) {
    query += " AND s.estado = ?";
    params.push(req.query.estado);
  }

  query += " ORDER BY s.fecha_apertura DESC";

  connection.query(query, params, (err: any, results: any[]) => {
    if (err) return res.status(500).json({ error: "Error al obtener reportes" });
    res.json(results);
  });
});

// Registro de movimiento manual (Ingreso / Salida)
router.post("/movimiento", verifyTokenAndTenant, async (req: any, res: any) => {
  const { monto, descripcion, tipo, sesion_caja_id } = req.body;
  const usuario_id = req.user.id;
  const empresa_id = req.user.empresa_id;

  if (!monto || !descripcion || !tipo || !sesion_caja_id) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }

  if (/^(ABONO_SEPARADO|DEVOLUCION_SEPARADO)\s*:/i.test(String(descripcion).trim())) {
    return res.status(400).json({ error: 'Referencia reservada para auditoría de separados' });
  }

  if (!Number.isFinite(Number(monto)) || monto <= 0 || !['Ingreso', 'Salida'].includes(tipo)) {
    return res.status(400).json({ error: "El monto debe ser mayor a cero" });
  }

  const query = `
    INSERT INTO movimientos_caja (empresa_id, usuario_id, sesion_caja_id, tipo, monto, descripcion)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  let conn: any;
  try {
    centavos(monto);
    conn = await connection.promise().getConnection();
    await conn.beginTransaction();
    const [sesiones]: any = await conn.query("SELECT id FROM sesiones_caja WHERE id = ? AND empresa_id = ? AND usuario_id = ? AND estado = 'Abierta' FOR UPDATE", [sesion_caja_id, empresa_id, usuario_id]);
    if (!sesiones.length) throw new Error('La sesión no está abierta o no pertenece al usuario');
    await conn.query(query, [empresa_id, usuario_id, sesion_caja_id, tipo, monto, descripcion]);
    await conn.commit();
    // Notificar por Socket
    if (req.io) {
      req.io.to(`empresa_${empresa_id}`).emit('caja_movimiento', { tipo, monto, descripcion });
    }
    res.json({ success: true, message: "Movimiento registrado con éxito" });
  } catch (err: any) {
    if (conn) await conn.rollback();
    res.status(400).json({ error: err.message });
  } finally { if (conn) conn.release(); }
});

// Obtener detalles de movimientos de una sesión
router.get("/movimientos/:sesion_id", verifyTokenAndTenant, (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { sesion_id } = req.params;

  const query = "SELECT * FROM movimientos_caja WHERE sesion_caja_id = ? AND empresa_id = ? ORDER BY fecha DESC";
  connection.query(query, [sesion_id, empresa_id], (err: any, results: any[]) => {
    if (err) return res.status(500).json({ error: "Error al obtener movimientos" });
    res.json(results);
  });
});

export default router;
