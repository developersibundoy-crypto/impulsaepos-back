import express from "express";
import connection from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

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
    
    // Calcular ventas desde la apertura
    // Necesitamos el cajero_id asociado al usuario para filtrar facturas_venta
    // El cajero_id viene en el token (req.user.cajero_id)
    const cajero_id = req.user.cajero_id;

      const queryVentas = `
        SELECT 
          SUM(total_bruto) as total_ventas,
          SUM(efectivo) as total_efectivo,
          SUM(transferencia) as total_transferencia
        FROM (
          -- Ventas directas
          SELECT total as total_bruto, pago_efectivo as efectivo, pago_transferencia as transferencia, fecha, cajero_id, empresa_id FROM facturas_venta
          UNION ALL
          -- Ventas electrónicas
          SELECT total as total_bruto, pago_efectivo as efectivo, pago_transferencia as transferencia, fecha_emision as fecha, cajero_id, empresa_id FROM facturas_electronicas
          UNION ALL
          -- Abonos y pagos de separados (Layaway)
          SELECT monto as total_bruto, pago_efectivo as efectivo, pago_transferencia as transferencia, fecha_pago as fecha, cajero_id, empresa_id FROM abonos_separados
        ) AS todas_ventas
        WHERE empresa_id = ? 
        ${cajero_id ? "AND cajero_id = ?" : ""}
        AND fecha >= ?
      `;

      const params = cajero_id ? [empresa_id, cajero_id, sesion.fecha_apertura] : [empresa_id, sesion.fecha_apertura];

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
              total_ventas: totals.total_ventas || 0,
              total_efectivo: total_efectivo_ventas,
              total_transferencia: totals.total_transferencia || 0,
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
router.post("/cierre", verifyTokenAndTenant, (req: any, res: any) => {
  const { dinero_reportado } = req.body;
  const usuario_id = req.user.id;
  const empresa_id = req.user.empresa_id;
  const cajero_id = req.user.cajero_id;

  if (dinero_reportado === undefined || dinero_reportado === null) {
    return res.status(400).json({ error: "El dinero reportado es obligatorio" });
  }

  // Obtener la sesión abierta
  connection.query(
    "SELECT * FROM sesiones_caja WHERE usuario_id = ? AND empresa_id = ? AND estado = 'Abierta' ORDER BY fecha_apertura DESC LIMIT 1",
    [usuario_id, empresa_id],
    (err: any, results: any[]) => {
      if (err || results.length === 0) return res.status(404).json({ error: "No hay sesión abierta para cerrar" });

      const sesion = results[0];

      // Calcular ventas finales
      const queryVentas = `
        SELECT 
          SUM(total_bruto) as total_ventas,
          SUM(efectivo) as total_efectivo,
          SUM(transferencia) as total_transferencia
        FROM (
          SELECT total as total_bruto, pago_efectivo as efectivo, pago_transferencia as transferencia, fecha, cajero_id, empresa_id FROM facturas_venta
          UNION ALL
          SELECT total as total_bruto, pago_efectivo as efectivo, pago_transferencia as transferencia, fecha_emision as fecha, cajero_id, empresa_id FROM facturas_electronicas
          UNION ALL
          SELECT monto as total_bruto, pago_efectivo as efectivo, pago_transferencia as transferencia, fecha_pago as fecha, cajero_id, empresa_id FROM abonos_separados
        ) AS todas_ventas
        WHERE empresa_id = ? 
        ${cajero_id ? "AND cajero_id = ?" : ""}
        AND fecha >= ?
      `;

      const params = cajero_id ? [empresa_id, cajero_id, sesion.fecha_apertura] : [empresa_id, sesion.fecha_apertura];

      connection.query(queryVentas, params, (errV: any, resultsV: any[]) => {
        if (errV) return res.status(500).json({ error: "Error al calcular ventas finales" });

        const totals = resultsV[0];
        const total_ventas = totals.total_ventas || 0;
        const total_efectivo = totals.total_efectivo || 0;
        const total_transferencia = totals.total_transferencia || 0;

        // Consultar movimientos manuales antes de cerrar
        const queryMovs = `
          SELECT 
            SUM(IF(tipo = 'Ingreso', ABS(monto), 0)) as total_ingresos,
            SUM(IF(tipo = 'Salida', ABS(monto), 0)) as total_salidas
          FROM movimientos_caja
          WHERE sesion_caja_id = ? AND empresa_id = ?
        `;

        connection.query(queryMovs, [sesion.id, empresa_id], (errM: any, resultsM: any[]) => {
          if (errM) return res.status(500).json({ error: "Error al calcular movimientos finales" });

          const movs = resultsM[0];
          const ingresos = parseFloat(movs.total_ingresos || 0);
          const salidas = parseFloat(movs.total_salidas || 0);

          const valor_esperado = parseFloat(sesion.base_caja) + parseFloat(total_efectivo) + ingresos - salidas;
          const diferencia = parseFloat(dinero_reportado) - valor_esperado;

          const queryUpdate = `
            UPDATE sesiones_caja SET
              fecha_cierre = CURRENT_TIMESTAMP,
              total_ventas = ?,
              total_efectivo = ?,
              total_transferencia = ?,
              total_ingresos = ?,
              total_salidas = ?,
              dinero_reportado = ?,
              diferencia = ?,
              estado = 'Cerrada'
            WHERE id = ?
          `;

          connection.query(queryUpdate, [total_ventas, total_efectivo, total_transferencia, ingresos, salidas, dinero_reportado, diferencia, sesion.id], (errU: any) => {
            if (errU) return res.status(500).json({ error: "Error al cerrar caja" });
            // Notificar por Socket
            if (req.io) {
               req.io.to(`empresa_${empresa_id}`).emit('caja_cerrada', { usuario_id, resumen: { total_ventas, dinero_reportado, diferencia } });
            }
            res.json({ 
              success: true, 
              resumen: {
                total_ventas,
                total_efectivo,
                total_transferencia,
                total_ingresos: ingresos,
                total_salidas: salidas,
                valor_esperado,
                diferencia,
                dinero_reportado
              }
            });
          });
        });
      });
    }
  );
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
    query += " AND s.fecha_apertura >= ?";
    params.push(desde);
  }
  if (hasta) {
    query += " AND s.fecha_apertura <= ?";
    params.push(hasta);
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
router.post("/movimiento", verifyTokenAndTenant, (req: any, res: any) => {
  const { monto, descripcion, tipo, sesion_caja_id } = req.body;
  const usuario_id = req.user.id;
  const empresa_id = req.user.empresa_id;

  if (!monto || !descripcion || !tipo || !sesion_caja_id) {
    return res.status(400).json({ error: "Faltan campos obligatorios" });
  }

  if (monto <= 0) {
    return res.status(400).json({ error: "El monto debe ser mayor a cero" });
  }

  const query = `
    INSERT INTO movimientos_caja (empresa_id, usuario_id, sesion_caja_id, tipo, monto, descripcion)
    VALUES (?, ?, ?, ?, ?, ?)
  `;

  connection.query(query, [empresa_id, usuario_id, sesion_caja_id, tipo, monto, descripcion], (err: any) => {
    if (err) {
      console.error("Error al registrar movimiento:", err);
      return res.status(500).json({ error: "Error al registrar movimiento" });
    }
    // Notificar por Socket
    if (req.io) {
       req.io.to(`empresa_${empresa_id}`).emit('caja_movimiento', { tipo, monto, descripcion });
    }
    res.json({ success: true, message: "Movimiento registrado con éxito" });
  });
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
