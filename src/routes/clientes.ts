import express from "express";
import connection from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

// Interceptar y proteger todas las rutas de clientes
router.use(verifyTokenAndTenant);

router.get("/", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  connection.query("SELECT * FROM clientes WHERE empresa_id = ?", [empresa_id], (err: any, results: any) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

router.post("/", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { 
    nombre, documento, dv, tipo_documento, correo, direccion, telefono, correo_electronico_facturacion,
    tipo_persona, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido, razon_social,
    nombre_comercial, regimen_tributario, responsabilidad_fiscal, codigo_tributario_dian,
    obligado_facturar, gran_contribuyente, autorretenedor, correo_alternativo, telefono_fijo,
    pais, departamento, ciudad, codigo_postal, estado, observaciones
  } = req.body;
  
  const finalNombre = nombre || (tipo_persona === 'Jurídica' ? razon_social : `${primer_nombre || ''} ${segundo_nombre || ''} ${primer_apellido || ''} ${segundo_apellido || ''}`.replace(/\s+/g, ' ').trim());

  if (!finalNombre) return res.status(400).json({ error: "Nombre o Razón Social es requerido" });

  connection.query(
    `INSERT INTO clientes (
      empresa_id, nombre, documento, dv, tipo_documento, correo, direccion, telefono, correo_electronico_facturacion,
      tipo_persona, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido, razon_social,
      nombre_comercial, regimen_tributario, responsabilidad_fiscal, codigo_tributario_dian,
      obligado_facturar, gran_contribuyente, autorretenedor, correo_alternativo, telefono_fijo,
      pais, departamento, ciudad, codigo_postal, estado, observaciones
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      empresa_id, finalNombre, documento || '', dv || null, tipo_documento || '13', correo || '', direccion || '', telefono || '', correo_electronico_facturacion || correo || '',
      tipo_persona || 'Natural', primer_nombre || '', segundo_nombre || '', primer_apellido || '', segundo_apellido || '', razon_social || '',
      nombre_comercial || '', regimen_tributario || '', responsabilidad_fiscal || '', codigo_tributario_dian || '',
      obligado_facturar ? 1 : 0, gran_contribuyente ? 1 : 0, autorretenedor ? 1 : 0, correo_alternativo || '', telefono_fijo || '',
      pais || 'Colombia', departamento || '', ciudad || '', codigo_postal || '', estado || 'Activo', observaciones || ''
    ],
    (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      res.status(201).json({ id: results.insertId, ...req.body });
    }
  );
});

router.delete("/:id", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  connection.query("DELETE FROM clientes WHERE id = ? AND empresa_id = ?", [req.params.id, empresa_id], (err: any, results: any) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true });
  });
});

router.put("/:id", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const clienteId = req.params.id;
  const { 
    nombre, documento, dv, tipo_documento, correo, direccion, telefono, correo_electronico_facturacion,
    tipo_persona, primer_nombre, segundo_nombre, primer_apellido, segundo_apellido, razon_social,
    nombre_comercial, regimen_tributario, responsabilidad_fiscal, codigo_tributario_dian,
    obligado_facturar, gran_contribuyente, autorretenedor, correo_alternativo, telefono_fijo,
    pais, departamento, ciudad, codigo_postal, estado, observaciones
  } = req.body;

  const finalNombre = nombre || (tipo_persona === 'Jurídica' ? razon_social : `${primer_nombre || ''} ${segundo_nombre || ''} ${primer_apellido || ''} ${segundo_apellido || ''}`.replace(/\s+/g, ' ').trim());

  if (!finalNombre) return res.status(400).json({ error: "Nombre o Razón Social es requerido" });

  const query = `
    UPDATE clientes 
    SET nombre = ?, documento = ?, dv = ?, tipo_documento = ?, correo = ?, direccion = ?, telefono = ?, correo_electronico_facturacion = ?,
        tipo_persona = ?, primer_nombre = ?, segundo_nombre = ?, primer_apellido = ?, segundo_apellido = ?, razon_social = ?,
        nombre_comercial = ?, regimen_tributario = ?, responsabilidad_fiscal = ?, codigo_tributario_dian = ?,
        obligado_facturar = ?, gran_contribuyente = ?, autorretenedor = ?, correo_alternativo = ?, telefono_fijo = ?,
        pais = ?, departamento = ?, ciudad = ?, codigo_postal = ?, estado = ?, observaciones = ?
    WHERE id = ? AND empresa_id = ?
  `;

  connection.query(
    query,
    [
      finalNombre, documento || '', dv || null, tipo_documento || '13', correo || '', direccion || '', telefono || '', correo_electronico_facturacion || correo || '',
      tipo_persona || 'Natural', primer_nombre || '', segundo_nombre || '', primer_apellido || '', segundo_apellido || '', razon_social || '',
      nombre_comercial || '', regimen_tributario || '', responsabilidad_fiscal || '', codigo_tributario_dian || '',
      obligado_facturar ? 1 : 0, gran_contribuyente ? 1 : 0, autorretenedor ? 1 : 0, correo_alternativo || '', telefono_fijo || '',
      pais || 'Colombia', departamento || '', ciudad || '', codigo_postal || '', estado || 'Activo', observaciones || '',
      clienteId, empresa_id
    ],
    (err: any, results: any) => {
      if (err) return res.status(500).json({ error: err.message });
      if (results.affectedRows === 0) return res.status(404).json({ error: "Cliente no encontrado" });
      res.json({ success: true, message: "Cliente actualizado" });
    }
  );
});

export default router;
