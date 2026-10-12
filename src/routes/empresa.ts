import express from "express";
import connection from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

// Todas las rutas de configuración requieren autenticación y aislamiento por Empresa (Tenant)
router.use(verifyTokenAndTenant);

// Obtener datos de la empresa del usuario autenticado
router.get("/", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  
  connection.query("SELECT * FROM empresa_config WHERE empresa_id = ?", [empresa_id], (err: any, results: any[]) => {
    if (err) return res.status(500).json({ error: err.message });
    if (results.length === 0) return res.status(404).json({ error: "Configuración no encontrada para su empresa" });
    const config = results[0];
    if (config.dias_alerta_vencimiento === undefined || config.dias_alerta_vencimiento === null) {
      config.dias_alerta_vencimiento = 30;
    }
    res.json(config);
  });
});

// Actualizar configuración de la empresa del usuario
router.put("/", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { 
    nombre_empresa, nit, direccion, telefono, correo, resolucion, representante_legal, logo,
    tipo_persona, tipo_responsabilidad, regimen, municipio_codigo, departamento_codigo, ciudad, matricula_mercantil,
    dias_alerta_vencimiento
  } = req.body;
  
  if (!nombre_empresa || !nit || !direccion || !correo) {
    return res.status(400).json({ error: "Nombre, NIT, Dirección y Correo son obligatorios" });
  }

  const diasAlerta = parseInt(dias_alerta_vencimiento, 10) > 0 ? parseInt(dias_alerta_vencimiento, 10) : 30;

  // Asegurar que la columna existe en la base de datos
  connection.query("ALTER TABLE empresa_config ADD COLUMN dias_alerta_vencimiento INT DEFAULT 30", () => {
    const query = `
      UPDATE empresa_config 
      SET nombre_empresa = ?, nit = ?, direccion = ?, telefono = ?, correo = ?, resolucion = ?, representante_legal = ?, logo = ?,
          tipo_persona = ?, tipo_responsabilidad = ?, regimen = ?, municipio_codigo = ?, departamento_codigo = ?, ciudad = ?, matricula_mercantil = ?,
          dias_alerta_vencimiento = ?
      WHERE empresa_id = ?
    `;
    
    connection.query(query, [
      nombre_empresa, nit, direccion, telefono || "", correo, resolucion || "", representante_legal || "", logo || null,
      tipo_persona || 'Persona Jurídica', tipo_responsabilidad || 'R-99-PN', regimen || 'Responsable de IVA', 
      municipio_codigo || '05001', departamento_codigo || '05', ciudad || 'Medellín', matricula_mercantil || '',
      diasAlerta,
      empresa_id
    ], (err, results: any) => {
      if (err) {
        console.error("Error al actualizar empresa_config:", err);
        return res.status(500).json({ error: err.message });
      }
      if (results.affectedRows === 0) {
          const qInsert = `
            INSERT INTO empresa_config 
            (empresa_id, nombre_empresa, nit, direccion, telefono, correo, resolucion, representante_legal, logo, 
             tipo_persona, tipo_responsabilidad, regimen, municipio_codigo, departamento_codigo, ciudad, matricula_mercantil, dias_alerta_vencimiento) 
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
          connection.query(qInsert, [
            empresa_id, nombre_empresa, nit, direccion, telefono || "", correo, resolucion || "", representante_legal || "", logo || null,
            tipo_persona || 'Persona Jurídica', tipo_responsabilidad || 'R-99-PN', regimen || 'Responsable de IVA', 
            municipio_codigo || '05001', departamento_codigo || '05', ciudad || 'Medellín', matricula_mercantil || '',
            diasAlerta
          ], (errI) => {
              if (errI) {
                  console.error("Error al insertar empresa_config inicial:", errI);
                  return res.status(500).json({ error: "Error al crear configuración inicial" });
              }
              return res.json({ message: "Configuración creada con éxito" });
          });
      } else {
          res.json({ message: "Configuración actualizada con éxito" });
      }
    });
  });
});

export default router;
