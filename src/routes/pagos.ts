import express from "express";
import connection from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

// Todas las rutas de pagos requieren aislamiento por Empresa (Tenant)
router.use(verifyTokenAndTenant);

// Fetch payroll data for a specific month and year
router.get("/", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { fecha_inicio, fecha_fin, cajero_id } = req.query;
  
  console.log(`[DEBUG] GET /pagos recibida. Empresa: ${empresa_id}, Desde: ${fecha_inicio}, Hasta: ${fecha_fin}, Cajero: ${cajero_id || 'Todos'}`);
  
  if (!fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: "Debe seleccionar un rango de fechas válido." });
  }

  try {
    const queryVentas = `
      SELECT cajero_id, SUM(comision) as total_comisiones
      FROM (
        SELECT f.cajero_id, v.comision
        FROM ventas v
        JOIN facturas_venta f ON v.factura_id = f.id
        WHERE f.empresa_id = ? AND DATE(f.fecha) BETWEEN ? AND ?
        
        UNION ALL
        
        SELECT fe.cajero_id, ve.comision
        FROM ventas_electronicas ve
        JOIN facturas_electronicas fe ON ve.factura_electronica_id = fe.id
        WHERE fe.empresa_id = ? AND DATE(fe.fecha_emision) BETWEEN ? AND ?
      ) as t
      GROUP BY cajero_id;
    `;
    const queryPagos = `
      SELECT * FROM pagos_empleados 
      WHERE empresa_id = ? AND fecha_inicio = ? AND fecha_fin = ?;
    `;

    let queryCajeros = `SELECT * FROM cajeros WHERE empresa_id = ?`;
    let paramsCajeros: any[] = [empresa_id];
    if (cajero_id) {
        queryCajeros += ` AND id = ?`;
        paramsCajeros.push(cajero_id);
    }

    const [cajeros] = await connection.promise().query(queryCajeros, paramsCajeros);
    const [ventas] = await connection.promise().query(queryVentas, [empresa_id, fecha_inicio, fecha_fin, empresa_id, fecha_inicio, fecha_fin]);
    const [pagos] = await connection.promise().query(queryPagos, [empresa_id, fecha_inicio, fecha_fin]);

    const nomina = (cajeros as any[]).map(cajero => {
      const ventaCajero = (ventas as any[]).find(v => v.cajero_id === cajero.id);
      const comisiones = ventaCajero ? parseFloat(ventaCajero.total_comisiones) : 0;
      
      const salario_base = parseFloat(cajero.salario) || 0;
      const total_a_pagar = salario_base + comisiones;

      const pagoRegistrado = (pagos as any[]).find(p => p.cajero_id === cajero.id);
      const estado = pagoRegistrado ? "Pagado" : "Pendiente";

      return {
        cajero_id: cajero.id,
        nombre: cajero.nombre,
        documento: cajero.documento,
        salario_base,
        salario_pagado: pagoRegistrado ? parseFloat(pagoRegistrado.salario_base) : null,
        porcentaje_comision: cajero.porcentaje_comision_base,
        comisiones: pagoRegistrado ? parseFloat(pagoRegistrado.comisiones) : comisiones,
        total_a_pagar: pagoRegistrado ? parseFloat(pagoRegistrado.total_pagado) : total_a_pagar,
        estado,
        fecha_pago: pagoRegistrado ? pagoRegistrado.fecha_pago : null,
        pago_id: pagoRegistrado ? pagoRegistrado.id : null
      };
    });

    res.json(nomina);
  } catch (err: any) {
    console.error("Error en GET /pagos:", err);
    res.status(500).json({ 
        error: "Error interno al procesar la nómina.", 
        details: err.message,
        sqlState: err.sqlState 
    });
  }
});

// Mark payroll as paid
router.post("/", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { cajero_id, fecha_inicio, fecha_fin, salario_base, comisiones, total_pagado, metodo_pago } = req.body;
  
  if (!cajero_id || !fecha_inicio || !fecha_fin) {
    return res.status(400).json({ error: "Faltan datos para procesar el pago." });
  }

  // Check if already paid
  const checkQuery = `SELECT id FROM pagos_empleados WHERE empresa_id = ? AND cajero_id = ? AND fecha_inicio = ? AND fecha_fin = ?`;
  connection.query(checkQuery, [empresa_id, cajero_id, fecha_inicio, fecha_fin], (err: any, results: any[]) => {
    if (err) return res.status(500).json({ error: "Ocurrió un error al verificar duplicados. Inténtelo de nuevo." });
    
    if (results.length > 0) {
      return res.status(400).json({ error: "Este empleado ya tiene un pago registrado para este rango de fechas." });
    }

    const insertQuery = `
      INSERT INTO pagos_empleados (empresa_id, cajero_id, fecha_inicio, fecha_fin, salario_base, comisiones, total_pagado, metodo_pago)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `;

    connection.query(
      insertQuery,
      [empresa_id, cajero_id, fecha_inicio, fecha_fin, salario_base || 0, comisiones || 0, total_pagado || 0, metodo_pago || 'Efectivo'],
      (err: any, result: any) => {
        if (err) {
            console.error("Error en pagos_empleados:", err);
            return res.status(500).json({ error: "No se pudo registrar el pago debido a un fallo en el sistema. Soporte técnico ha sido notificado." });
        }
        res.status(201).json({ success: true, id: result.insertId });
      }
    );
  });
});

export default router;
