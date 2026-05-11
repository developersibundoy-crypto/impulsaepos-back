import express from "express";
import connection from "../conection";
import crypto from "crypto";
import { verifyTokenAndTenant, verifySuperAdmin } from "../middlewares/authMiddleware";

const router = express.Router();

// NOTA: Wompi requiere un endpoint público para mandar el Evento (No requiere Token JWT local)
// Webhook URL a configurar en el Dashboard de Wompi: https://tudominio.com/api/suscripciones/wompi-webhook
router.post("/wompi-webhook", (req: any, res: any) => {
  const evento = req.body;

  if (evento && evento.event === "transaction.updated") {
    const transaction = evento.data.transaction;

    // Solo si la transacción es aprobada
    if (transaction.status === "APPROVED") {
      const { reference, id: wompiTxId, amount_in_cents } = transaction;
      const parts = reference.split("_");
      if (parts[0] === "SUB" && parts[1]) {
        let dias = 30;
        let empresa_id = 0;

        // Nuevo formato: SUB_DIAS_EMPRESAID_TIMESTAMP
        // Antiguo formato: SUB_EMPRESAID_TIMESTAMP
        if (parts.length >= 4) {
           dias = parseInt(parts[1], 10);
           empresa_id = parseInt(parts[2], 10);
        } else {
           empresa_id = parseInt(parts[1], 10);
           // Fallback por monto si es formato antiguo
           const monto = amount_in_cents / 100;
           if (monto === 378000) dias = 180;
           else if (monto === 672000) dias = 365;
        }

        const montoPesos = amount_in_cents / 100;

        // Registrar Pago
        const qPago = "INSERT INTO pagos_suscripcion (empresa_id, wompi_transaction_id, monto, dias_agregados) VALUES (?, ?, ?, ?)";
        connection.query(qPago, [empresa_id, wompiTxId, montoPesos, dias], (err: any) => {
          if (err) console.error("Error registrando pago en BD", err);
          
          // Sumar X días a su fecha de vencimiento o desde HOY si estaba expirado
          const qActualizarSuscripcion = `
            UPDATE empresas_suscritas 
            SET estado = 'Active',
            fecha_vencimiento_suscripcion = CASE 
                WHEN fecha_vencimiento_suscripcion < CURRENT_DATE() THEN DATE_ADD(CURRENT_DATE(), INTERVAL ? DAY)
                ELSE DATE_ADD(fecha_vencimiento_suscripcion, INTERVAL ? DAY)
            END
            WHERE id = ?
          `;
          connection.query(qActualizarSuscripcion, [dias, dias, empresa_id], (err2: any) => {
             if(err2) console.error("Error renovando la tienda", err2);
             console.log(`[WOMPI] Suscripción pagada éxito: Empresa #${empresa_id} pagó $${montoPesos} por ${dias} días.`);
          });
        });
      }
    }
  }

  // Wompi exige respuesta 200 rápida
  res.status(200).send("OK");
});

// Endpoint para obtener estado de la suscripción (Protegido para el Front de cada Tenant)
router.get("/estado", verifyTokenAndTenant, (req: any, res: any) => {
  const empresa_id = req.user.empresa_id;
  
  if(req.user.role === 'superadmin') {
     return res.json({ estado: 'Active', diasRestantes: 9999 });
  }

  connection.query(
    "SELECT estado, fecha_vencimiento_suscripcion, DATEDIFF(fecha_vencimiento_suscripcion, CURRENT_DATE()) as diasRestantes FROM empresas_suscritas WHERE id = ?", 
    [empresa_id], 
    (err: any, results: any) => {
      if (err || results.length === 0) return res.status(500).json({ error: "Error consultando estado." });
      res.json(results[0]);
    }
  );
});

// Endpoint exclusivo Super Administrador: Ver TODAS las tiendas
router.get("/superadmin/empresas", verifySuperAdmin, (req: any, res: any) => {
  connection.query(
    `SELECT e.*, 
            (SELECT SUM(monto) FROM pagos_suscripcion WHERE empresa_id = e.id) as total_recaudado,
            (SELECT dias_agregados FROM pagos_suscripcion WHERE empresa_id = e.id ORDER BY id DESC LIMIT 1) as ultimo_plan_dias,
            u.username as owner_username
     FROM empresas_suscritas e
     LEFT JOIN usuarios_plataforma u ON u.empresa_id = e.id AND u.role = 'dueño'
     ORDER BY e.fecha_registro DESC`, 
    (err: any, results: any) => {
      if (err) return res.status(500).json({ error: "Error consultando tiendas SaaS." });
      res.json(results);
    }
  );
});

// Endpoint exclusivo Super Administrador: Ver HISTORIAL DE PAGOS
router.get("/superadmin/pagos", verifySuperAdmin, (req: any, res: any) => {

  connection.query(
    `SELECT p.*, e.nombre_comercial 
     FROM pagos_suscripcion p
     JOIN empresas_suscritas e ON p.empresa_id = e.id
     ORDER BY p.id DESC`,
    (err: any, results: any) => {
      if (err) {
         if (err.code === 'ER_NO_SUCH_TABLE') {
            return res.json([]);
         }
         return res.status(500).json({ error: "Error consultando historial de pagos." });
      }
      res.json(results);
    }
  );
});

// Endpoint para ELIMINAR una empresa (Solo Super Admin)
router.delete("/superadmin/empresas/:id", verifySuperAdmin, (req: any, res: any) => {
  const id = req.params.id;
  
  // Seguridad: No permitir borrar la empresa principal #1
  if (id == '1') {
    return res.status(400).json({ error: "No se puede eliminar la empresa principal del sistema por seguridad." });
  }

  // Al tener ON DELETE CASCADE en las tablas hijas, esto limpia todo automáticamente
  connection.query("DELETE FROM empresas_suscritas WHERE id = ?", [id], (err: any, result: any) => {
    if (err) {
      console.error("Error eliminando empresa:", err);
      return res.status(500).json({ error: "Error técnico al eliminar la empresa." });
    }
    
    if (result.affectedRows === 0) return res.status(404).json({ error: "Empresa no encontrada." });

    res.json({ success: true, message: "Empresa y todos sus datos relacionados (productos, ventas, usuarios) han sido eliminados." });
  });
});

// --- CONFIGURACIÓN GLOBAL SAAS (Solo Super Admin) ---

router.get("/superadmin/config", verifySuperAdmin, (req: any, res: any) => {
  connection.query("SELECT * FROM plataforma_config WHERE id = 1", async (err: any, results: any) => {
    if (err) {
      console.error("[ERROR CONFIG GLOBAL]:", err);
      
      // Si el error es porque la tabla no existe, intentamos crearla al vuelo para evitar el bloqueo del usuario
      if (err.code === 'ER_NO_SUCH_TABLE') {
         console.log("Intentando crear tabla plataforma_config automáticamente...");
         const createQuery = `
           CREATE TABLE IF NOT EXISTS plataforma_config (
             id INT AUTO_INCREMENT PRIMARY KEY,
             wompi_public_key VARCHAR(255) DEFAULT '',
             wompi_private_key VARCHAR(255) DEFAULT '',
             wompi_integrity_secret VARCHAR(255) DEFAULT '',
             wompi_event_secret VARCHAR(255) DEFAULT '',
             precio_mes_centavos BIGINT DEFAULT 7000000,
             precio_semestre_centavos BIGINT DEFAULT 37800000,
             precio_anio_centavos BIGINT DEFAULT 67200000,
             ultima_actualizacion TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
           );
         `;
         connection.query(createQuery, (err2) => {
            if (err2) return res.status(500).json({ error: "Error fatal creando tabla de configuración" });
            connection.query("INSERT IGNORE INTO plataforma_config (id) VALUES (1)", () => {
               return res.json({ id: 1 }); // Retornar objeto vacío inicial
            });
         });
         return;
      }
      
      return res.status(500).json({ error: "Error obteniendo configuración global." });
    }
    res.json(results[0] || {});
  });
});

router.post("/superadmin/config", verifySuperAdmin, (req: any, res: any) => {
  const { 
    wompi_public_key, 
    wompi_private_key, 
    wompi_integrity_secret, 
    wompi_event_secret,
    precio_mes_centavos,
    precio_semestre_centavos,
    precio_anio_centavos
  } = req.body;

  const query = `
    UPDATE plataforma_config 
    SET wompi_public_key = ?, 
        wompi_private_key = ?, 
        wompi_integrity_secret = ?, 
        wompi_event_secret = ?,
        precio_mes_centavos = ?,
        precio_semestre_centavos = ?,
        precio_anio_centavos = ?
    WHERE id = 1
  `;
  const params = [
    wompi_public_key || '', 
    wompi_private_key || '', 
    wompi_integrity_secret || '', 
    wompi_event_secret || '',
    precio_mes_centavos || 7000000,
    precio_semestre_centavos || 37800000,
    precio_anio_centavos || 67200000
  ];

  connection.query(query, params, (err: any) => {
    if (err) return res.status(500).json({ error: "Error actualizando configuración global." });
    res.json({ success: true, message: "Configuración de plataforma actualizada correctamente." });
  });
});

// Endpoint exclusivo Super Administrador: ACTIVACIÓN MANUAL (Para pagos en físico)
router.post("/superadmin/activar-manual", verifySuperAdmin, (req: any, res: any) => {
  const { empresa_id, dias, monto } = req.body;

  if (!empresa_id || !dias) {
    return res.status(400).json({ error: "Faltan datos requeridos (ID empresa o días)." });
  }

  // 1. Registrar el pago en el historial como 'MANUAL_SUPERADMIN'
  const qPago = "INSERT INTO pagos_suscripcion (empresa_id, wompi_transaction_id, monto, dias_agregados) VALUES (?, ?, ?, ?)";
  connection.query(qPago, [empresa_id, 'MANUAL_SUPERADMIN', monto || 0, dias], (err: any) => {
    if (err) {
      console.error("Error registrando pago manual:", err);
      return res.status(500).json({ error: "Error técnico al registrar el pago manual." });
    }
    
    // 2. Actualizar la fecha de vencimiento de la empresa
    // Si ya está vencida, sumamos desde hoy. Si no, sumamos a la fecha actual de vencimiento.
    const qActualizarSuscripcion = `
      UPDATE empresas_suscritas 
      SET estado = 'Active',
      fecha_vencimiento_suscripcion = CASE 
          WHEN fecha_vencimiento_suscripcion < CURRENT_DATE() THEN DATE_ADD(CURRENT_DATE(), INTERVAL ? DAY)
          ELSE DATE_ADD(fecha_vencimiento_suscripcion, INTERVAL ? DAY)
      END
      WHERE id = ?
    `;
    connection.query(qActualizarSuscripcion, [dias, dias, empresa_id], (err2: any) => {
       if(err2) {
         console.error("Error actualizando vencimiento:", err2);
         return res.status(500).json({ error: "Error actualizando la fecha de vencimiento." });
       }
       res.json({ success: true, message: `Activación manual de ${dias} días para la empresa #${empresa_id} completada exitosamente.` });
    });
  });
});

export default router;
