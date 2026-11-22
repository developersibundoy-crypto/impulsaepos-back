import jwt from 'jsonwebtoken';

export const verifyTokenAndTenant = (req: any, res: any, next: any) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader) {
    return res.status(403).json({ error: 'Token es requerido' });
  }

  const token = authHeader.split(' ')[1]; // "Bearer token..."
  if (!token) return res.status(403).json({ error: 'Token inválido' });

  if (!process.env.JWT_SECRET) {
    console.error("CRITICAL ERROR: JWT_SECRET environment variable is not defined!");
    return res.status(500).json({ error: "Configuración de seguridad incompleta en el servidor." });
  }

  jwt.verify(token, process.env.JWT_SECRET, (err: any, decoded: any) => {
    if (err) {
      return res.status(401).json({ error: 'Token expirado o inválido' });
    }

    // Seguridad SaaS activa: Ya no permitimos tokens sin empresa_id (excepto superadmins si aplica)
    if (!decoded.empresa_id && decoded.role !== 'superadmin') {
       return res.status(401).json({ error: 'Token no contiene identificación de empresa (Tenant ID missing)'});
    }
    
    req.user = decoded; // { id, role, username, empresa_id }

    next();
  });
};

/**
 * Evalúa si un usuario del token tiene acceso a un módulo (misma semántica que verifyPermission).
 * Superadmin, permisos 'all' y admin/dueño sin lista explícita tienen acceso total.
 */
export const tienePermiso = (user: any, module: string): boolean => {
  if (!user) return false;
  if (user.role === 'superadmin' || user.permisos === 'all') return true;
  if (user.role === 'admin' || user.role === 'dueño') {
    if (!user.permisos || user.permisos === "" || user.permisos === "null") return true;
  }
  try {
    const list = JSON.parse(user.permisos || "[]");
    return Array.isArray(list) && list.includes(module);
  } catch (e) {
    return false;
  }
};

/**
 * Middleware para validar permisos específicos por módulo.
 * @param module Nombre del módulo a validar (ej: 'ingreso', 'ventas', 'reportes')
 */
export const verifyPermission = (module: string) => {
  return (req: any, res: any, next: any) => {
    // 1. Primero verificar que el token sea válido
    verifyTokenAndTenant(req, res, () => {
      const user = req.user;

      // Superadmin o admins con 'all' tienen acceso total
      if (user.role === 'superadmin' || user.permisos === 'all') {
        return next();
      }

      // El dueño de la empresa (admin) usualmente tiene acceso total por defecto si permisos está vacío
      if (user.role === 'admin' || user.role === 'dueño') {
        if (!user.permisos || user.permisos === "" || user.permisos === "null") {
          return next();
        }
      }

      // Validar lista de permisos (JSON string en el token)
      try {
        const list = JSON.parse(user.permisos || "[]");
        if (list.includes(module)) {
          return next();
        }
      } catch (e) {
        console.error("Error parsing user permissions in backend:", e);
      }

      // Si no tiene acceso
      console.warn(`[INTENTO ACCESO NO AUTORIZADO]: Usuario ${user.username} (Empresa: ${user.empresa_id}) intentó acceder al módulo '${module}' sin permisos.`);
      return res.status(403).json({ 
        error: "🚫 No tienes permiso para realizar esta acción.",
        detalle: `Se requiere acceso al módulo: ${module}`
      });
    });
  };
};

/**
 * Middleware para rutas críticas de SuperAdministrador SaaS.
 * Restringe el acceso únicamente a usuarios con rol 'superadmin' 
 * que pertenezcan a la Empresa Matriz (ID 1).
 */
export const verifySuperAdmin = (req: any, res: any, next: any) => {
  verifyTokenAndTenant(req, res, () => {
    if (req.user.role === 'superadmin' && parseInt(req.user.empresa_id) === 1) {
      next();
    } else {
      console.warn(`[INTENTO ACCESO SUPERADMIN]: Usuario ${req.user.username} intentó acceder sin privilegios suficientes.`);
      res.status(403).json({ 
        error: "Acceso Denegado. No autorizado. Requiere rol superadmin y pertenecer a la empresa autorizada." 
      });
    }
  });
};
