import express from "express";
import connection from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

router.use(verifyTokenAndTenant);

// ─── GET /sorteo/premios ─────────────────────────────────────

router.get("/premios", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  connection.query(
    "SELECT * FROM premios_sorteo WHERE empresa_id = ? ORDER BY orden_entrega ASC, nombre ASC",
    [empresa_id],
    (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(results);
    }
  );
});

// ─── POST /sorteo/premios ────────────────────────────────────

router.post("/premios", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { nombre, descripcion, cantidad_disponible, cantidad_max_ganadores, estado, imagen, orden_entrega, fecha_vigencia } = req.body;

  if (!nombre) return res.status(400).json({ error: "Nombre del premio es requerido" });

  connection.query(
    `INSERT INTO premios_sorteo (empresa_id, nombre, descripcion, cantidad_disponible, cantidad_max_ganadores, estado, imagen, orden_entrega, fecha_vigencia) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [empresa_id, nombre, descripcion || null, cantidad_disponible ?? 0, cantidad_max_ganadores ?? null, estado || 'Activo', imagen || null, orden_entrega ?? 0, fecha_vigencia || null],
    (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ id: results.insertId, ...req.body });
    }
  );
});

// ─── PUT /sorteo/premios/:id ─────────────────────────────────

router.put("/premios/:id", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;
  const { nombre, descripcion, cantidad_disponible, cantidad_max_ganadores, estado, imagen, orden_entrega, fecha_vigencia } = req.body;

  connection.query(
    `UPDATE premios_sorteo SET nombre = ?, descripcion = ?, cantidad_disponible = ?, cantidad_max_ganadores = ?, estado = ?, imagen = ?, orden_entrega = ?, fecha_vigencia = ? WHERE id = ? AND empresa_id = ?`,
    [nombre, descripcion || null, cantidad_disponible ?? 0, cantidad_max_ganadores ?? null, estado || 'Activo', imagen || null, orden_entrega ?? 0, fecha_vigencia || null, id, empresa_id],
    (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      if (results.affectedRows === 0) return res.status(404).json({ error: "Premio no encontrado" });
      res.json({ message: "Premio actualizado" });
    }
  );
});

// ─── DELETE /sorteo/premios/:id ──────────────────────────────

router.delete("/premios/:id", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;

  connection.query(
    "DELETE FROM premios_sorteo WHERE id = ? AND empresa_id = ?",
    [id, empresa_id],
    (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      if (results.affectedRows === 0) return res.status(404).json({ error: "Premio no encontrado" });
      res.json({ message: "Premio eliminado" });
    }
  );
});

// ─── GET /sorteo/clientes ────────────────────────────────────

router.get("/clientes", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;

  // Check if config has purchase filters
  connection.query(
    "SELECT filtro_monto_min, filtro_compras_min, filtro_fecha_inicio, filtro_fecha_fin FROM sorteo_config WHERE empresa_id = ?",
    [empresa_id],
    (errCfg: any, configRows: any) => {
      if (errCfg) return res.status(500).json({ error: errCfg.message });

      const cfg = configRows[0] || {};
      const hasPurchaseFilter = cfg.filtro_monto_min && cfg.filtro_fecha_inicio && cfg.filtro_fecha_fin;

      let purchaseJoin = "";
      let purchaseWhere = "";
      let params: any[] = [empresa_id];

      if (hasPurchaseFilter) {
        const minAmount = parseFloat(cfg.filtro_monto_min);
        const minPurchases = parseInt(cfg.filtro_compras_min) || 1;

        purchaseJoin = `
          INNER JOIN (
            SELECT cliente_id, COUNT(*) as total_compras
            FROM (
              SELECT fv.cliente_id, fv.total, fv.fecha FROM facturas_venta fv
              WHERE fv.empresa_id = ? AND fv.total >= ? AND fv.fecha >= ? AND fv.fecha <= ?
              UNION ALL
              SELECT fe.cliente_id, fe.total, fe.fecha_emision as fecha FROM facturas_electronicas fe
              WHERE fe.empresa_id = ? AND fe.total >= ? AND fe.fecha_emision >= ? AND fe.fecha_emision <= ?
            ) compras
            GROUP BY cliente_id
            HAVING COUNT(*) >= ?
          ) pc ON c.id = pc.cliente_id
        `;
        params.push(empresa_id, minAmount, cfg.filtro_fecha_inicio, cfg.filtro_fecha_fin);
        params.push(empresa_id, minAmount, cfg.filtro_fecha_inicio, cfg.filtro_fecha_fin);
        params.push(minPurchases);
      }

      connection.query(
        `SELECT c.id, c.nombre, c.telefono, c.documento,
           COALESCE(h.gano, 0) as ya_gano,
           h.premio_nombre as premio_ganado,
           h.fecha as fecha_premio,
           h.estado_entrega
         FROM clientes c
         ${purchaseJoin}
         LEFT JOIN (
           SELECT cliente_id, 1 as gano, premio_nombre, fecha, estado_entrega
           FROM sorteo_historial
           WHERE empresa_id = ?
           GROUP BY cliente_id
         ) h ON c.id = h.cliente_id
         WHERE c.empresa_id = ? AND c.estado = 'Activo'
         ORDER BY c.nombre ASC`,
        hasPurchaseFilter
          ? [...params, empresa_id, empresa_id]
          : [empresa_id, empresa_id, empresa_id],
        (err: any, results: any) => {
          if (err) return res.status(500).json({ error: err.message });
          res.json(results);
        }
      );
    }
  );
});

// ─── GET /sorteo/estado ──────────────────────────────────────

router.get("/estado", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;

  const qConfig = `SELECT * FROM sorteo_config WHERE empresa_id = ?`;
  const qPremiosActivos = `SELECT COUNT(*) as total, COALESCE(SUM(cantidad_disponible), 0) as disponibles FROM premios_sorteo WHERE empresa_id = ? AND estado = 'Activo' AND cantidad_disponible > 0`;
  const qTotalGiros = `SELECT COUNT(*) as total FROM sorteo_historial WHERE empresa_id = ?`;
  const qGanadores = `SELECT COUNT(DISTINCT cliente_id) as total FROM sorteo_historial WHERE empresa_id = ?`;
  connection.query(qConfig, [empresa_id], (err: any, configRows: any) => {
    if (err) return res.status(500).json({ error: err.message });

    const cfg = configRows[0] || {};
    const hasPurchaseFilter = cfg.filtro_monto_min && cfg.filtro_fecha_inicio && cfg.filtro_fecha_fin;

    let purchaseSubquery = "";
    let purchaseParams: any[] = [];
    if (hasPurchaseFilter) {
      const minAmount = parseFloat(cfg.filtro_monto_min);
      const minPurchases = parseInt(cfg.filtro_compras_min) || 1;
      purchaseSubquery = `
        AND c.id IN (
          SELECT cliente_id FROM (
            SELECT fv.cliente_id FROM facturas_venta fv
            WHERE fv.empresa_id = ? AND fv.total >= ? AND fv.fecha >= ? AND fv.fecha <= ?
            UNION ALL
            SELECT fe.cliente_id FROM facturas_electronicas fe
            WHERE fe.empresa_id = ? AND fe.total >= ? AND fe.fecha_emision >= ? AND fe.fecha_emision <= ?
          ) compras GROUP BY cliente_id HAVING COUNT(*) >= ?
        )
      `;
      purchaseParams = [empresa_id, minAmount, cfg.filtro_fecha_inicio, cfg.filtro_fecha_fin,
                        empresa_id, minAmount, cfg.filtro_fecha_inicio, cfg.filtro_fecha_fin,
                        minPurchases];
    }

    const qClientesDisponibles = `
      SELECT COUNT(*) as total FROM clientes c
      WHERE c.empresa_id = ? AND c.estado = 'Activo'
      AND c.id NOT IN (SELECT cliente_id FROM sorteo_historial WHERE empresa_id = ?)
      ${purchaseSubquery}
    `;

    connection.query(qPremiosActivos, [empresa_id], (err2: any, premiosRows: any) => {
      if (err2) return res.status(500).json({ error: err2.message });

      connection.query(qTotalGiros, [empresa_id], (err3: any, girosRows: any) => {
        if (err3) return res.status(500).json({ error: err3.message });

        connection.query(qGanadores, [empresa_id], (err4: any, ganadoresRows: any) => {
          if (err4) return res.status(500).json({ error: err4.message });

          connection.query(qClientesDisponibles, [empresa_id, empresa_id, ...purchaseParams], (err5: any, clientesRows: any) => {
            if (err5) return res.status(500).json({ error: err5.message });

            res.json({
              config: configRows[0] || null,
              premiosActivos: premiosRows[0].total,
              premiosDisponibles: premiosRows[0].disponibles,
              totalGiros: girosRows[0].total,
              totalGanadores: ganadoresRows[0].total,
              clientesDisponibles: clientesRows[0].total
            });
          });
        });
      });
    });
  });
});

// ─── POST /sorteo/girar ──────────────────────────────────────

router.post("/girar", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const usuario_id = req.user.id;
  const usuario_nombre = req.user.username || "Sistema";
  const { cliente_id } = req.body;

  if (!cliente_id) return res.status(400).json({ error: "cliente_id es requerido" });

  // 1. Verify client exists and hasn't won yet
  // 2. Verify active prizes exist
  // 3. Assign prize FIFO by orden_entrega
  // 4. Record history
  // 5. Decrement prize stock
  // 6. Update or create sorteo_config

  connection.query(
    "SELECT id, nombre FROM clientes WHERE id = ? AND empresa_id = ? AND estado = 'Activo'",
    [cliente_id, empresa_id],
    (err: any, clientes: any) => {
      if (err) return res.status(500).json({ error: err.message });
      if (clientes.length === 0) return res.status(400).json({ error: "Cliente no encontrado" });

      const cliente = clientes[0];

      // Check if already won
      connection.query(
        "SELECT id FROM sorteo_historial WHERE empresa_id = ? AND cliente_id = ?",
        [empresa_id, cliente_id],
        (err2: any, historial: any) => {
          if (err2) return res.status(500).json({ error: err2.message });
          if (historial.length > 0) return res.status(400).json({ error: "Este cliente ya ha ganado un premio" });

          // Get next available prize (FIFO by orden_entrega)
          connection.query(
            `SELECT id, nombre, cantidad_disponible FROM premios_sorteo
             WHERE empresa_id = ? AND estado = 'Activo' AND cantidad_disponible > 0
             ORDER BY orden_entrega ASC, id ASC LIMIT 1`,
            [empresa_id],
            (err3: any, premios: any) => {
              if (err3) return res.status(500).json({ error: err3.message });
              if (premios.length === 0) return res.status(400).json({ error: "No hay premios disponibles" });

              const premio = premios[0];

              // Get or create sorteo_config
              connection.query(
                "SELECT id, numero_sorteo FROM sorteo_config WHERE empresa_id = ?",
                [empresa_id],
                (err4: any, configRows: any) => {
                  if (err4) return res.status(500).json({ error: err4.message });

                  const now = new Date();
                  const fecha = now.toISOString().slice(0, 10);
                  const hora = now.toTimeString().slice(0, 8);
                  let numero_sorteo = 1;
                  let configId = null;

                  if (configRows.length > 0) {
                    numero_sorteo = configRows[0].numero_sorteo;
                    configId = configRows[0].id;
                  }

                  // Insert history
                  connection.query(
                    `INSERT INTO sorteo_historial (empresa_id, cliente_id, cliente_nombre, premio_id, premio_nombre, fecha, hora, usuario_id, usuario_nombre, numero_sorteo, estado_entrega)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'Pendiente')`,
                    [empresa_id, cliente_id, cliente.nombre, premio.id, premio.nombre, fecha, hora, usuario_id, usuario_nombre, numero_sorteo],
                    (err5: any, result: any) => {
                      if (err5) return res.status(500).json({ error: err5.message });

                      // Decrement prize stock
                      connection.query(
                        "UPDATE premios_sorteo SET cantidad_disponible = cantidad_disponible - 1 WHERE id = ? AND empresa_id = ?",
                        [premio.id, empresa_id],
                        (err6: any) => {
                          if (err6) return res.status(500).json({ error: err6.message });

                          res.json({
                            success: true,
                            cliente: { id: cliente.id, nombre: cliente.nombre },
                            premio: { id: premio.id, nombre: premio.nombre },
                            fecha,
                            hora,
                            numero_sorteo,
                            historial_id: result.insertId
                          });
                        }
                      );
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});

// ─── GET /sorteo/historial ───────────────────────────────────

router.get("/historial", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { startDate, endDate } = req.query;

  let dateFilter = "";
  let params: any[] = [empresa_id];

  if (startDate) {
    dateFilter += " AND sh.fecha >= ?";
    params.push(startDate);
  }
  if (endDate) {
    dateFilter += " AND sh.fecha <= ?";
    params.push(endDate);
  }

  connection.query(
    `SELECT sh.*, p.imagen
     FROM sorteo_historial sh
     LEFT JOIN premios_sorteo p ON sh.premio_id = p.id
     WHERE sh.empresa_id = ? ${dateFilter}
     ORDER BY sh.creado_en DESC`,
    params,
    (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(results);
    }
  );
});

// ─── PUT /sorteo/historial/:id/entregar ─────────────────────

router.put("/historial/:id/entregar", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { id } = req.params;

  connection.query(
    "UPDATE sorteo_historial SET estado_entrega = 'Entregado' WHERE id = ? AND empresa_id = ?",
    [id, empresa_id],
    (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      if (results.affectedRows === 0) return res.status(404).json({ error: "Registro no encontrado" });
      res.json({ message: "Premio marcado como entregado" });
    }
  );
});

// ─── POST /sorteo/reiniciar ──────────────────────────────────

router.post("/reiniciar", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;

  connection.query(
    "SELECT id, numero_sorteo FROM sorteo_config WHERE empresa_id = ?",
    [empresa_id],
    (err: any, configRows: any) => {
      if (err) return res.status(500).json({ error: err.message });

      const nuevoNumero = configRows.length > 0 ? configRows[0].numero_sorteo + 1 : 1;

      const upsertConfig = configRows.length > 0
        ? `UPDATE sorteo_config SET estado = 'Activo', numero_sorteo = ?, fecha_inicio = CURDATE(), fecha_fin = NULL WHERE empresa_id = ?`
        : `INSERT INTO sorteo_config (empresa_id, estado, numero_sorteo, fecha_inicio) VALUES (?, 'Activo', ?, CURDATE())`;

      const params = configRows.length > 0 ? [nuevoNumero, empresa_id] : [empresa_id, nuevoNumero];

      connection.query(upsertConfig, params, (err2: any) => {
        if (err2) return res.status(500).json({ error: err2.message });

        // Restore all prize stocks to their original values
        // Since we track cantidad_disponible decrements, we reset them
        // We need the original quantities from a separate field
        // For simplicity, we add back the delivered amounts
        connection.query(
          `UPDATE premios_sorteo p
           JOIN (
             SELECT premio_id, COUNT(*) as entregados
             FROM sorteo_historial
             WHERE empresa_id = ? AND premio_id IS NOT NULL
           ) h ON p.id = h.premio_id
           SET p.cantidad_disponible = p.cantidad_disponible + h.entregados
           WHERE p.empresa_id = ?`,
          [empresa_id, empresa_id],
          (err3: any) => {
            if (err3) return res.status(500).json({ error: err3.message });

            res.json({ message: "Sorteo reiniciado", numero_sorteo: nuevoNumero });
          }
        );
      });
    }
  );
});

// ─── GET /sorteo/config ───────────────────────────────────────

router.get("/config", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  connection.query(
    "SELECT * FROM sorteo_config WHERE empresa_id = ?",
    [empresa_id],
    (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json(results[0] || null);
    }
  );
});

// ─── POST /sorteo/config ─────────────────────────────────────

router.post("/config", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { filtro_monto_min, filtro_compras_min, filtro_fecha_inicio, filtro_fecha_fin } = req.body;

  connection.query(
    `INSERT INTO sorteo_config (empresa_id, estado, numero_sorteo, fecha_inicio, filtro_monto_min, filtro_compras_min, filtro_fecha_inicio, filtro_fecha_fin)
     VALUES (?, 'Activo', 1, CURDATE(), ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE filtro_monto_min = VALUES(filtro_monto_min), filtro_compras_min = VALUES(filtro_compras_min), filtro_fecha_inicio = VALUES(filtro_fecha_inicio), filtro_fecha_fin = VALUES(filtro_fecha_fin)`,
    [empresa_id, filtro_monto_min || null, filtro_compras_min || null, filtro_fecha_inicio || null, filtro_fecha_fin || null],
    (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ message: "Configuración guardada" });
    }
  );
});

export default router;
