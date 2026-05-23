import express from "express";
import connection from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

// Middleware de seguridad obligatorio
router.use(verifyTokenAndTenant);

// Obtener Kardex filtrado por Tenant con Paginación y Búsqueda
router.get("/", (req: any, res: any) => {
  const { productoId, startDate, endDate, tipo, search = '', page = 1, limit = 50 } = req.query;
  const empresa_id = req.user.empresa_id;
  const offset = (parseInt(page as string) - 1) * parseInt(limit as string);

  let baseQuery = `
    SELECT 
      k.*, 
      IFNULL(p.nombre, '(PRODUCTO ELIMINADO)') as producto_nombre, 
      IFNULL(p.referencia, k.referencia) as codigo_barras
    FROM kardex k
    LEFT JOIN productos p ON k.producto_id = p.id
    WHERE k.empresa_id = ?
  `;

  let countQuery = `
    SELECT COUNT(*) as total 
    FROM kardex k
    LEFT JOIN productos p ON k.producto_id = p.id
    WHERE k.empresa_id = ?
  `;

  const params: any[] = [empresa_id];

  if (productoId) {
    baseQuery += " AND k.producto_id = ?";
    countQuery += " AND k.producto_id = ?";
    params.push(productoId);
  }
  if (startDate) {
    baseQuery += " AND k.fecha >= ?";
    countQuery += " AND k.fecha >= ?";
    params.push(startDate);
  }
  if (endDate) {
    baseQuery += " AND k.fecha <= ?";
    countQuery += " AND k.fecha <= ?";
    params.push(`${endDate} 23:59:59`);
  }
  if (tipo) {
    baseQuery += " AND k.tipo_movimiento = ?";
    countQuery += " AND k.tipo_movimiento = ?";
    params.push(tipo);
  }
  if (search) {
    const searchClause = " AND (p.nombre LIKE ? OR p.referencia LIKE ? OR k.referencia LIKE ?)";
    baseQuery += searchClause;
    countQuery += searchClause;
    const searchParam = `%${search}%`;
    params.push(searchParam, searchParam, searchParam);
  }

  baseQuery += " ORDER BY k.fecha DESC LIMIT ? OFFSET ?";
  const queryParams = [...params, parseInt(limit as string), offset];

  connection.query(countQuery, params, (countErr: any, countRes: any) => {
    if (countErr) return res.status(500).json({ error: countErr.message });
    const total = countRes[0].total;

    connection.query(baseQuery, queryParams, (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({
        data: results,
        total,
        page: parseInt(page as string),
        last_page: Math.ceil(total / parseInt(limit as string))
      });
    });
  });
});

export default router;
