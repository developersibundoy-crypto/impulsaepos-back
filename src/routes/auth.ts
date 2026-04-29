import express from "express";
import connection from "../conection";
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

// Patch table to migrate old single-tenant 'administradores' into 'usuarios_plataforma' temporarily on load
connection.query(
  "INSERT IGNORE INTO usuarios_plataforma (empresa_id, username, password_hash, role) SELECT 1, username, password_hash, role FROM administradores;",
  (err: any) => { if (err) console.log("Migración ignorada: " + err.message); }
);

// REGISTRO PÚBLICO SAAS (AUTO-SERVICIO)
router.post("/registro-empresa", async (req: any, res: any) => {
  const { nombre_comercial, niti, telefono, correo, username, password } = req.body;

  if (!nombre_comercial || !username || !password) {
    return res.status(400).json({ error: "Nombre Comercial, Usuario y Contraseña son obligatorios" });
  }

  // 1. Validar que el username no exista ya en TODA la plataforma SaaS
  connection.query("SELECT * FROM usuarios_plataforma WHERE username = ?", [username], async (err: any, results: any[]) => {
    if (err) return res.status(500).json({ error: "Error interno de validación" });
    if (results.length > 0) return res.status(409).json({ error: "El nombre de usuario ya está tomado por otra tienda" });

    // 1.5 Validar que el NIT no esté registrado (Debe ser único)
    if (niti) {
      try {
        const [nitResults]: any = await connection.promise().query("SELECT id FROM empresas_suscritas WHERE nit = ?", [niti]);
        if (nitResults.length > 0) {
          return res.status(409).json({ error: `El NIT ${niti} ya ha sido registrado. Este número es único y no se puede repetir.` });
        }
      } catch (dbErr) {
        return res.status(500).json({ error: "Error al validar el NIT" });
      }
    }

    try {
      const promisePool = connection.promise();
      const dbConn = await promisePool.getConnection();

      try {
        await dbConn.beginTransaction();

        // Paso A: Crear Empresa con 7 días Trial
        const queryEmpresa = `
          INSERT INTO empresas_suscritas 
          (nombre_comercial, nit, correo_contacto, telefono_contacto, fecha_vencimiento_suscripcion, estado)
          VALUES (?, ?, ?, ?, DATE_ADD(CURRENT_DATE, INTERVAL 7 DAY), 'Trial')
        `;
        const [resEmp] = await dbConn.query(queryEmpresa, [nombre_comercial, niti || '', correo || '', telefono || '']);
        const empresa_id = (resEmp as any).insertId;

        // Paso B: Crear Perfil de Dueño Global para su nueva tienda
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);

        await dbConn.query(
          "INSERT INTO usuarios_plataforma (empresa_id, username, password_hash, role, permisos) VALUES (?, ?, ?, 'admin', 'all')",
          [empresa_id, username, hash]
        );

        // Paso C: Crear Configuración de Empresa por defecto para el nuevo Tenant
        await dbConn.query(
          "INSERT INTO empresa_config (empresa_id, nombre_empresa, nit, direccion, correo, resolucion) VALUES (?, ?, ?, ?, ?, ?)",
          [empresa_id, nombre_comercial, niti || '', 'Dirección Principal', correo || '', 'DOCUMENTO EQUIVALENTE DE FACTURA POS. Régimen Simplificado - No Responsable de IVA. Desarrollado por IMPULSA POS.']
        );

        await dbConn.commit();
        dbConn.release();

        // 3. Notificación "push/log" para Súper Administrador
        console.log(`[ALERTA SAAS]: 🎉 ¡Nueva empresa registrada!: ${nombre_comercial} (Admin: ${username}). 7 Días Gratis activados.`);

        res.status(201).json({
          success: true,
          message: "¡Tienda registrada con éxito! Disfruta de tus 7 días gratis.",
          empresa_id
        });
      } catch (txError: any) {
        await dbConn.rollback();
        dbConn.release();
        console.error("[ERROR CRÍTICO REGISTRO SAAS]:", txError);

        const errorMessage = txError.code === 'ER_DUP_ENTRY'
          ? "Ya existe una configuración activa o usuario con datos similares. Verifique los detalles."
          : `Error técnico: ${txError.message || "Fallo en transacción"}`;

        res.status(500).json({
          error: "No pudimos crear tu tienda SaaS.",
          detalle: errorMessage,
          code: txError.code
        });
      }
    } catch (error: any) {
      console.error("Error Obteniendo Conexión:", error);
      res.status(500).json({ error: "Error conectando a Base de Datos." });
    }
  });
});

// Registrar nuevo usuario interno (Cajeros de una tienda) - PROTEGIDO
router.post("/registro", verifyTokenAndTenant, async (req: any, res: any) => {
  const { empresa_id, username, password, role } = req.body;

  // Seguridad: Solo el dueño o un admin de la misma empresa puede crear usuarios
  if (req.user.role !== 'dueño' && req.user.role !== 'superadmin' && req.user.role !== 'admin') {
    return res.status(403).json({ error: "No tienes permisos para crear usuarios." });
  }

  // Seguridad: Un dueño no puede crear usuarios para otra empresa
  if (req.user.role !== 'superadmin' && req.user.empresa_id !== parseInt(empresa_id)) {
    return res.status(403).json({ error: "No puedes crear usuarios para otras empresas." });
  }

  if (!username || !password || !empresa_id) return res.status(400).json({ error: "Faltan datos" });

  connection.query("SELECT * FROM usuarios_plataforma WHERE username = ?", [username], async (err: any, results: any[]) => {
    if (err) return res.status(500).json({ error: "BD Error" });
    if (results.length > 0) return res.status(409).json({ error: "Usuario existe" });

    try {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(password, salt);
      connection.query(
        "INSERT INTO usuarios_plataforma (empresa_id, username, password_hash, role) VALUES (?, ?, ?, ?)",
        [empresa_id, username, hash, role || 'cajero'],
        (insertErr: any) => {
          if (insertErr) return res.status(500).json({ error: "Error de servidor al guardar cajero" });
          res.status(201).json({ success: true });
        }
      );
    } catch (error) { res.status(500).json({ error: "Error cifrando" }); }
  });
});

// Login
router.post("/login", (req: any, res: any) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Requerido user y pass" });

  connection.query(
    "SELECT u.*, e.estado as estado_empresa, e.fecha_vencimiento_suscripcion, e.nombre_comercial FROM usuarios_plataforma u LEFT JOIN empresas_suscritas e ON u.empresa_id = e.id WHERE u.username = ?",
    [username],
    async (err: any, results: any[]) => {
      if (err) return res.status(500).json({ error: "Error de conexion a la base de datos" });
      if (results.length === 0) return res.status(401).json({ error: "Credenciales inválidas" });

      const admin = results[0];
      const validPassword = await bcrypt.compare(password, admin.password_hash);
      if (!validPassword) return res.status(401).json({ error: "Credenciales inválidas" });

      const hoy = new Date();
      const fecVen = new Date(admin.fecha_vencimiento_suscripcion);

      /* 
      if (admin.role !== 'superadmin' && fecVen < hoy) {
        return res.status(403).json({
          error: "Suscripción Expirada",
          reason: "expired",
          empresa_id: admin.empresa_id
        });
      }
      */

      if (!process.env.JWT_SECRET) {
        console.error("JWT_SECRET missing in ENV!");
        return res.status(500).json({ error: "Error de configuración de seguridad." });
      }

      // Determinar permisos efectivos (compatibilidad con usuarios previos)
      let effectivePermisos = admin.permisos;
      const isAdminRole = ['admin', 'superadmin', 'dueño'].includes(admin.role);
      if (!effectivePermisos && isAdminRole) {
        effectivePermisos = 'all';
      }

      const token = jwt.sign(
        { 
          id: admin.id, 
          role: admin.role, 
          username: admin.username, 
          empresa_id: admin.empresa_id, 
          nombre_comercial: admin.nombre_comercial,
          cajero_id: admin.cajero_id,
          permisos: effectivePermisos
        },
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
      );

      res.json({ 
        success: true, 
        token, 
        role: admin.role, 
        username: admin.username, 
        empresa_id: admin.empresa_id, 
        nombre_comercial: admin.nombre_comercial,
        cajero_id: admin.cajero_id,
        permisos: effectivePermisos
      });
    }
  );
});

// --- NUEVAS RUTAS DE RECUPERACIÓN SEGURA CON OTP ---

// 1. Solicitar Código (Valida NIT + Username)
router.post("/solicitar-codigo", (req: any, res: any) => {
  const { username, nit } = req.body;
  if (!username || !nit) return res.status(400).json({ error: "Usuario y NIT son obligatorios" });

  const query = `
    SELECT u.id, e.correo_contacto, e.telefono_contacto 
    FROM usuarios_plataforma u
    INNER JOIN empresas_suscritas e ON u.empresa_id = e.id
    WHERE u.username = ? AND e.nit = ?
  `;

  connection.query(query, [username, nit], (err: any, results: any[]) => {
    if (err) return res.status(500).json({ error: "Error de servidor" });
    if (results.length === 0) return res.status(404).json({ error: "No se encontró un usuario con ese NIT y Usuario" });

    const { correo_contacto, telefono_contacto } = results[0];

    // Obscurecer datos para seguridad
    const obscureEmail = (email: string) => {
      if (!email) return "No registrado";
      const parts = email.split('@');
      const u = parts[0];
      const d = parts[1];
      return `${u.slice(0, 2)}***@${d}`;
    };
    const obscurePhone = (phone: string) => {
      if (!phone) return "No registrado";
      return `***-***-${phone.slice(-4)}`;
    };

    res.json({
      success: true,
      email: obscureEmail(correo_contacto || ''),
      phone: obscurePhone(telefono_contacto || '')
    });
  });
});

// 2. Enviar Código vía Email o SMS
router.post("/enviar-codigo", (req: any, res: any) => {
  const { username, nit, metodo } = req.body;
  if (!username || !nit || !metodo) return res.status(400).json({ error: "Faltan datos para el envío" });

  const query = `
    SELECT u.id, e.correo_contacto, e.telefono_contacto 
    FROM usuarios_plataforma u
    INNER JOIN empresas_suscritas e ON u.empresa_id = e.id
    WHERE u.username = ? AND e.nit = ?
  `;

  connection.query(query, [username, nit], async (err: any, results: any[]) => {
    if (err || results.length === 0) return res.status(404).json({ error: "Usuario no válido" });

    const user = results[0];
    const codigo = Math.floor(100000 + Math.random() * 900000).toString(); // 6 dígitos
    const expiracion = new Date(Date.now() + 10 * 60000); // 10 minutos

    // Guardar en DB
    connection.query(
      "INSERT INTO otp_verifications (usuario_id, codigo, tipo, expiracion) VALUES (?, ?, ?, ?)",
      [user.id, codigo, metodo, expiracion],
      (otpErr: any) => {
        if (otpErr) return res.status(500).json({ error: "Error al generar código" });

        // SIMULACIÓN DE ENVÍO PROFESIONAL EN LOGS
        if (metodo === 'email') {
          console.log(`[MAILER]: Enviando código ${codigo} a ${user.correo_contacto}`);
        } else {
          console.log(`[SMS_GATEWAY]: Enviando código ${codigo} a ${user.telefono_contacto}`);
        }

        res.json({ success: true, message: `Código enviado vía ${metodo === 'email' ? 'Correo Electrónico' : 'Mensaje de Texto'}` });
      }
    );
  });
});

// 3. Validar Código
router.post("/verificar-codigo", (req: any, res: any) => {
  const { username, nit, codigo } = req.body;

  if (!codigo) return res.status(400).json({ error: "Código requerido" });

  const query = `
    SELECT o.id, o.usuario_id 
    FROM otp_verifications o
    INNER JOIN usuarios_plataforma u ON o.usuario_id = u.id
    INNER JOIN empresas_suscritas e ON u.empresa_id = e.id
    WHERE u.username = ? AND e.nit = ? AND o.codigo = ? AND o.usado = 0 AND o.expiracion > NOW()
    ORDER BY o.fecha_creacion DESC LIMIT 1
  `;

  connection.query(query, [username, nit, codigo], (err: any, results: any[]) => {
    if (err) return res.status(500).json({ error: "Error de validación" });
    if (results.length === 0) return res.status(400).json({ error: "Código inválido o expirado" });

    res.json({ success: true, message: "Identidad verificada" });
  });
});

// 4. Restablecer con Código (Paso Final)
router.post("/restablecer-final", async (req: any, res: any) => {
  const { username, nit, codigo, newPassword } = req.body;

  if (!newPassword || newPassword.length < 6) return res.status(400).json({ error: "La contraseña debe tener al menos 6 caracteres" });

  const query = `
    SELECT o.id, o.usuario_id 
    FROM otp_verifications o
    INNER JOIN usuarios_plataforma u ON o.usuario_id = u.id
    INNER JOIN empresas_suscritas e ON u.empresa_id = e.id
    WHERE u.username = ? AND e.nit = ? AND o.codigo = ? AND o.usado = 0 AND o.expiracion > NOW()
    ORDER BY o.fecha_creacion DESC LIMIT 1
  `;

  connection.query(query, [username, nit, codigo], async (err: any, results: any[]) => {
    if (err || results.length === 0) return res.status(400).json({ error: "Sesión de recuperación no válida" });

    const { id: otpId, usuario_id } = results[0];

    try {
      const salt = await bcrypt.genSalt(10);
      const hash = await bcrypt.hash(newPassword, salt);

      connection.query(
        "UPDATE usuarios_plataforma SET password_hash = ? WHERE id = ?",
        [hash, usuario_id],
        (updateErr) => {
          if (updateErr) return res.status(500).json({ error: "Error al actualizar contraseña" });

          // Marcar OTP como usado
          connection.query("UPDATE otp_verifications SET usado = 1 WHERE id = ?", [otpId]);

          res.json({ success: true, message: "Contraseña restaurada exitosamente" });
        }
      );
    } catch (e) { res.status(500).json({ error: "Error en cifrado" }); }
  });
});

// 5. Cambio de Contraseña desde Perfil (Ruta Protegida)
router.post("/cambiar-password-perfil", verifyTokenAndTenant, async (req: any, res: any) => {
  const { currentPassword, newPassword } = req.body;
  const userId = req.user.id;

  if (!currentPassword || !newPassword) return res.status(400).json({ error: "Datos faltantes" });
  if (newPassword.length < 6) return res.status(400).json({ error: "Nueva clave muy corta (min 6 carac.)" });

  connection.query("SELECT password_hash FROM usuarios_plataforma WHERE id = ?", [userId], async (err: any, results: any[]) => {
    if (err || results.length === 0) return res.status(404).json({ error: "Usuario no encontrado" });

    const valid = await bcrypt.compare(currentPassword, results[0].password_hash);
    if (!valid) return res.status(401).json({ error: "La contraseña actual es incorrecta" });

    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(newPassword, salt);

    connection.query("UPDATE usuarios_plataforma SET password_hash = ? WHERE id = ?", [hash, userId], (updErr) => {
      if (updErr) return res.status(500).json({ error: "Error al guardar nueva clave" });
      res.json({ success: true, message: "Contraseña actualizada exitosamente" });
    });
  });
});

export default router;
