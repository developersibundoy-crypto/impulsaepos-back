import express from "express";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";
import puntosService from "../services/puntosService";

const router = express.Router();

router.use(verifyTokenAndTenant);

// ─── CONFIGURACIÓN ───────────────────────────────────────────────────────────────

router.get("/config", async (req: any, res: any) => {
  try {
    const config = await puntosService.getConfig(req.user.empresa_id);
    res.json(config);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/config", async (req: any, res: any) => {
  try {
    await puntosService.saveConfig(req.user.empresa_id, req.body);
    res.json({ success: true, message: "Configuración de fidelización guardada." });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── NIVELES ─────────────────────────────────────────────────────────────────────

router.get("/niveles", async (req: any, res: any) => {
  try {
    const niveles = await puntosService.getNiveles(req.user.empresa_id);
    res.json(niveles);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/niveles", async (req: any, res: any) => {
  try {
    await puntosService.saveNivel(req.user.empresa_id, req.body);
    res.status(201).json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/niveles/:id", async (req: any, res: any) => {
  try {
    await puntosService.saveNivel(req.user.empresa_id, { ...req.body, id: parseInt(req.params.id) });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/niveles/:id", async (req: any, res: any) => {
  try {
    await puntosService.deleteNivel(req.user.empresa_id, parseInt(req.params.id));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CAMPAÑAS ────────────────────────────────────────────────────────────────────

router.get("/campanias", async (req: any, res: any) => {
  try {
    const campanias = await puntosService.getCampanias(req.user.empresa_id);
    res.json(campanias);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/campanias", async (req: any, res: any) => {
  try {
    await puntosService.saveCampania(req.user.empresa_id, req.body);
    res.status(201).json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/campanias/:id", async (req: any, res: any) => {
  try {
    await puntosService.saveCampania(req.user.empresa_id, { ...req.body, id: parseInt(req.params.id) });
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.delete("/campanias/:id", async (req: any, res: any) => {
  try {
    await puntosService.deleteCampania(req.user.empresa_id, parseInt(req.params.id));
    res.json({ success: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── CLIENTE ─────────────────────────────────────────────────────────────────────

router.get("/cliente/:id", async (req: any, res: any) => {
  try {
    const clienteId = parseInt(req.params.id);
    if (isNaN(clienteId) || clienteId <= 0) return res.status(400).json({ error: "ID de cliente inválido." });

    const data = await puntosService.getClienteData(req.user.empresa_id, clienteId);
    if (!data) return res.status(404).json({ error: "Cliente no encontrado." });

    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── REDIMIR PUNTOS ──────────────────────────────────────────────────────────────

router.post("/redimir", async (req: any, res: any) => {
  try {
    const { cliente_id, total_venta, puntos_solicitados, factura_id } = req.body;
    const cajeroId = req.user.cajero_id || null;

    if (!cliente_id || !total_venta || !puntos_solicitados) {
      return res.status(400).json({ error: "cliente_id, total_venta y puntos_solicitados son requeridos." });
    }

    const result = await puntosService.redimir(
      req.user.empresa_id,
      cliente_id,
      total_venta,
      puntos_solicitados,
      cajeroId,
      factura_id || null,
      req.io
    );

    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── AJUSTE MANUAL ───────────────────────────────────────────────────────────────

router.post("/ajustar", async (req: any, res: any) => {
  try {
    const { cliente_id, puntos, motivo } = req.body;
    const cajeroId = req.user.cajero_id || null;

    if (!cliente_id || !puntos || !motivo) {
      return res.status(400).json({ error: "cliente_id, puntos y motivo son requeridos." });
    }

    const result = await puntosService.ajusteManual(
      req.user.empresa_id,
      cliente_id,
      parseInt(puntos),
      motivo,
      cajeroId
    );

    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── MOVIMIENTOS (AUDITORÍA) ─────────────────────────────────────────────────────

router.get("/movimientos", async (req: any, res: any) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const clienteId = req.query.cliente_id ? parseInt(req.query.cliente_id as string) : null;
    const tipo = req.query.tipo as string || null;

    const result = await puntosService.getMovimientos(req.user.empresa_id, page, limit, clienteId, tipo);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── BREAKAGE ────────────────────────────────────────────────────────────────────

router.get("/breakage", async (req: any, res: any) => {
  try {
    const fecha = req.query.fecha as string || undefined;
    const data = await puntosService.getBreakage(req.user.empresa_id, fecha);
    res.json(data);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── EXPIRACIÓN ──────────────────────────────────────────────────────────────────

router.post("/expiracion", async (req: any, res: any) => {
  try {
    const result = await puntosService.ejecutarExpiracion(req.user.empresa_id);
    res.json({ success: true, ...result });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// ─── ENDPOINTS ANTERIORES (COMPATIBILIDAD) ───────────────────────────────────────

router.get("/historial", async (req: any, res: any) => {
  try {
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const clienteId = req.query.cliente_id ? parseInt(req.query.cliente_id as string) : null;

    const result = await puntosService.getMovimientos(req.user.empresa_id, page, limit, clienteId);
    res.json(result);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/premios", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const offset = (page - 1) * limit;
  const cliente_id = req.query.cliente_id ? parseInt(req.query.cliente_id as string) : null;

  try {
    const pool = (await import("../conection")).default;
    let whereClause = "hp.empresa_id = ?";
    const params: any[] = [empresa_id];
    if (cliente_id) { whereClause += " AND hp.cliente_id = ?"; params.push(cliente_id); }

    const [[{ total }]]: any = await pool.promise().query(
      `SELECT COUNT(*) AS total FROM historial_premios hp WHERE ${whereClause}`, params
    );
    const [rows]: any = await pool.promise().query(
      `SELECT hp.*, c.nombre AS cliente_nombre, ca.nombre AS cajero_nombre
       FROM historial_premios hp
       LEFT JOIN clientes c ON hp.cliente_id = c.id
       LEFT JOIN cajeros ca ON hp.cajero_id = ca.id
       WHERE ${whereClause}
       ORDER BY hp.fecha DESC LIMIT ? OFFSET ?`,
      [...params, limit, offset]
    );

    res.json({ data: rows, total, page, last_page: Math.ceil(total / limit) });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/canjear/:clienteId", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const cliente_id = parseInt(req.params.clienteId);
  const cajero_id = req.user.cajero_id || null;

  try {
    const pool = (await import("../conection")).default;
    const [clienteRows]: any = await pool.promise().query(
      "SELECT id, nombre, puntos_acumulados FROM clientes WHERE id = ? AND empresa_id = ?",
      [cliente_id, empresa_id]
    );
    if (clienteRows.length === 0) return res.status(404).json({ error: "Cliente no encontrado." });

    const puntosActuales = clienteRows[0].puntos_acumulados || 0;
    if (puntosActuales <= 0) return res.status(400).json({ error: "El cliente no tiene puntos para canjear." });

    const [configRows]: any = await pool.promise().query(
      "SELECT meta_puntos, descripcion_premio FROM config_fidelizacion WHERE empresa_id = ?",
      [empresa_id]
    );
    const premio = configRows[0]?.descripcion_premio || "Premio de fidelización";

    await pool.promise().query(
      "INSERT INTO historial_premios (empresa_id, cliente_id, puntos_canjeados, descripcion_premio, cajero_id) VALUES (?, ?, ?, ?, ?)",
      [empresa_id, cliente_id, puntosActuales, premio, cajero_id]
    );
    await pool.promise().query(
      "UPDATE clientes SET puntos_acumulados = 0 WHERE id = ? AND empresa_id = ?",
      [cliente_id, empresa_id]
    );

    res.json({ success: true, message: `Premio canjeado. ${puntosActuales} puntos reiniciados.`, puntos_canjeados: puntosActuales, premio });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
