import express from "express";
import connection from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";
import bcrypt from 'bcryptjs';

const router = express.Router();

// Todas las rutas de cajeros requieren autenticación y Tenant
router.use(verifyTokenAndTenant);

// Listar cajeros
router.get("/", (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const query = `
    SELECT c.*, u.username, u.permisos, u.id as usuario_id
    FROM cajeros c 
    LEFT JOIN usuarios_plataforma u ON c.id = u.cajero_id 
    WHERE c.empresa_id = ?
  `;
  connection.query(query, [empresa_id], (err: any, results: any) => {
    if (err) return res.status(500).json({ error: "No se pudo obtener la lista de empleados." });
    res.json(results);
  });
});

// Crear cajero y usuario asociado
router.post("/", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { nombre, documento, telefono, direccion, fecha_contrato, salario, paga_comisiones, porcentaje_comision, username, password, permisos } = req.body;
  if (!nombre) return res.status(400).json({ error: "Nombre es requerido" });

  const promisePool = connection.promise();
  const conn = await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Insertar en cajeros
    const queryCajero = `
      INSERT INTO cajeros (empresa_id, nombre, documento, telefono, direccion, fecha_contrato, salario, paga_comisiones, porcentaje_comision) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `;
    const [resCajero]: any = await conn.query(queryCajero, [
      empresa_id, nombre, documento || '', telefono || '', direccion || '', fecha_contrato || null, salario || 0, paga_comisiones ? 1 : 0, porcentaje_comision || 0
    ]);
    const cajero_id = resCajero.insertId;

    // 2. Si se proporcionó usuario, crearlo en usuarios_plataforma
    if (username && password) {
      // Validar si usuario ya existe
      const [existing]: any = await conn.query("SELECT id FROM usuarios_plataforma WHERE username = ?", [username]);
      if (existing.length > 0) throw new Error("El nombre de usuario ya está en uso por otro acceso.");

      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(password, salt);
      const permisosStr = permisos ? (typeof permisos === 'string' ? permisos : JSON.stringify(permisos)) : null;

      await conn.query(
        "INSERT INTO usuarios_plataforma (empresa_id, username, password_hash, role, cajero_id, permisos) VALUES (?, ?, ?, 'cajero', ?, ?)",
        [empresa_id, username, hash, cajero_id, permisosStr]
      );
    }

    await conn.commit();
    res.status(201).json({ id: cajero_id, success: true });
  } catch (error: any) {
    if (conn) await conn.rollback();
    console.error("Error al crear cajero:", error);
    res.status(500).json({ error: error.message || "Error al registrar vendedor" });
  } finally {
    if (conn) conn.release();
  }
});

// Actualizar cajero y usuario
router.put("/:id", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const { nombre, documento, telefono, direccion, fecha_contrato, salario, paga_comisiones, porcentaje_comision, username, password, permisos } = req.body;
  const cajero_id = req.params.id;

  if (!nombre) return res.status(400).json({ error: "Nombre es requerido" });

  const promisePool = connection.promise();
  const conn = await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    // 1. Actualizar cajero
    const query = `
      UPDATE cajeros SET nombre = ?, documento = ?, telefono = ?, direccion = ?, fecha_contrato = ?, salario = ?, paga_comisiones = ?, porcentaje_comision = ?
      WHERE id = ? AND empresa_id = ?
    `;
    await conn.query(query, [
      nombre, documento || '', telefono || '', direccion || '', fecha_contrato || null, salario || 0, paga_comisiones ? 1 : 0, porcentaje_comision || 0, cajero_id, empresa_id
    ]);

    if (username) {
      // Validar si el username ya está tomado por OTRO usuario (que no sea este cajero)
      const [duplicate]: any = await conn.query(
        "SELECT id FROM usuarios_plataforma WHERE username = ? AND (cajero_id IS NULL OR cajero_id != ?)", 
        [username, cajero_id]
      );
      if (duplicate.length > 0) throw new Error(`El nombre de usuario '${username}' ya está en uso por otro colaborador.`);
    }

    // 2. Gestionar usuario asociado
    const permisosStr = permisos ? (typeof permisos === 'string' ? permisos : JSON.stringify(permisos)) : null;
    
    // Buscar si ya tiene usuario
    const [users]: any = await conn.query("SELECT id FROM usuarios_plataforma WHERE cajero_id = ?", [cajero_id]);
    
    if (users.length > 0) {
      if (username) {
        // Update existing user
        let updateQuery = "UPDATE usuarios_plataforma SET username = ?, permisos = ?, role = ?";
        let params = [username, permisosStr, req.body.role || 'cajero'];
        
        if (password) {
          const salt = await bcrypt.genSalt(10);
          const hash = await bcrypt.hash(password, salt);
          updateQuery += ", password_hash = ?";
          params.push(hash);
        }
        
        updateQuery += " WHERE cajero_id = ?";
        params.push(cajero_id as any);
        await conn.query(updateQuery, params);
      }
    } else if (username && password) {
      // Create user if didn't exist
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(password, salt);
      await conn.query(
        "INSERT INTO usuarios_plataforma (empresa_id, username, password_hash, role, cajero_id, permisos) VALUES (?, ?, ?, ?, ?, ?)",
        [empresa_id, username, hash, req.body.role || 'cajero', cajero_id, permisosStr]
      );
    }

    await conn.commit();
    res.json({ success: true, message: "Vendedor actualizado" });
  } catch (error: any) {
    if (conn) await conn.rollback();
    console.error("Error al actualizar cajero:", error);
    res.status(500).json({ error: error.message || "Error al actualizar vendedor" });
  } finally {
    if (conn) conn.release();
  }
});

// Eliminar cajero
router.delete("/:id", async (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  const cajero_id = req.params.id;

  const promisePool = connection.promise();
  const conn = await promisePool.getConnection();

  try {
    await conn.beginTransaction();

    // Eliminar usuario asociado primero por el FK
    await conn.query("DELETE FROM usuarios_plataforma WHERE cajero_id = ?", [cajero_id]);
    // Eliminar cajero
    const [result]: any = await conn.query("DELETE FROM cajeros WHERE id = ? AND empresa_id = ?", [cajero_id, empresa_id]);
    
    if (result.affectedRows === 0) throw new Error("No se encontró el cajero");

    await conn.commit();
    res.json({ success: true, message: "Vendedor eliminado" });
  } catch (error: any) {
    if (conn) await conn.rollback();
    res.status(500).json({ error: "No se pudo eliminar al vendedor. Es posible que tenga registros de ventas vinculados." });
  } finally {
    if (conn) conn.release();
  }
});

export default router;
