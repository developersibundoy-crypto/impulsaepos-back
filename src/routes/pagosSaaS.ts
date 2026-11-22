import express from "express";
import connection from "../conection";
import crypto from "crypto";
import { verifyTokenAndTenant, verifySuperAdmin } from "../middlewares/authMiddleware";
import { firmaValida } from "../services/wompiEventos";
import { registrarPagoAprobado, activarManual } from "../services/pagosSaasService";

const router = express.Router();

// NOTA: Wompi requiere un endpoint público para mandar el Evento (No requiere Token JWT local).
// La autenticidad se garantiza verificando la firma del evento con el "secreto de eventos" configurado
// en plataforma_config (wompi_event_secret). Sin secreto configurado el endpoint no procesa nada.
// Webhook URL a configurar en el Dashboard de Wompi: https://tudominio.com/api/suscripciones/wompi-webhook
router.post("/wompi-webhook", async (req: any, res: any) => {
  const evento = req.body;
  try {
    const [cfg]: any = await connection.promise().query(
      "SELECT wompi_event_secret, precio_mes_centavos, precio_semestre_centavos, precio_anio_centavos FROM plataforma_config WHERE id = 1"
    );
    const config = cfg[0] || {};
    const secreto: string = config.wompi_event_secret || "";

    if (!secreto) {
      // 503: Wompi reintentará cuando el administrador configure el secreto. Nunca se procesa sin verificar.
      console.error("[WOMPI] Evento recibido pero wompi_event_secret no está configurado: no se procesa.");
      return res.status(503).json({ error: "Eventos de pasarela no configurados." });
    }
    if (!firmaValida(evento, secreto)) {
      console.warn("[WOMPI] Evento rechazado: firma inválida.");
      return res.status(401).json({ error: "Firma inválida." });
    }

    // Solo interesan las transacciones aprobadas; el resto se confirma sin efecto.
    const transaction = evento?.data?.transaction;
    if (evento.event !== "transaction.updated" || !transaction || transaction.status !== "APPROVED") {
      return res.status(200).send("OK");
    }

    const eventoId = String(transaction.id ?? "");
    const montoCentavos = Number(transaction.amount_in_cents);
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(eventoId) || !Number.isSafeInteger(montoCentavos) || montoCentavos <= 0) {
      console.warn("[WOMPI] Evento firmado pero con transacción mal formada.");
      return res.status(400).json({ error: "Transacción mal formada." });
    }

    const resultado = await registrarPagoAprobado(
      connection.promise(),
      {
        proveedor: "wompi",
        eventoId,
        referencia: transaction.reference,
        montoCentavos,
        moneda: String(transaction.currency || ""),
      },
      {
        mes: Number(config.precio_mes_centavos),
        semestre: Number(config.precio_semestre_centavos),
        anio: Number(config.precio_anio_centavos),
      }
    );

    if (resultado.estado === "aplicado") {
      console.log(`[WOMPI] Suscripción pagada: empresa #${resultado.empresaId}, ${resultado.dias} días (tx ${eventoId}).`);
    } else if (resultado.estado === "conciliar") {
      console.warn(`[WOMPI] Pago ${eventoId} guardado para conciliación manual: ${resultado.motivo}.`);
    } else if (resultado.estado === "duplicado") {
      console.log(`[WOMPI] Evento ${eventoId} ya procesado: sin cambios.`);
    }
    // Wompi exige respuesta 200 rápida; un duplicado también es un éxito.
    return res.status(200).send("OK");
  } catch (err) {
    // Error transitorio (BD caída, etc.): 500 para que Wompi reintente. Es seguro porque es idempotente.
    console.error("[WOMPI] Error procesando evento:", err);
    return res.status(500).json({ error: "Error procesando el evento." });
  }
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
router.post("/superadmin/activar-manual", verifySuperAdmin, async (req: any, res: any) => {
  const empresaId = Number(req.body?.empresa_id);
  const dias = Number(req.body?.dias);
  const monto = req.body?.monto === undefined || req.body?.monto === "" ? 0 : Number(req.body.monto);

  if (!Number.isSafeInteger(empresaId) || empresaId < 1 || !Number.isSafeInteger(dias) || dias < 1 || dias > 3660) {
    return res.status(400).json({ error: "Datos inválidos: empresa_id debe ser un entero positivo y dias un entero entre 1 y 3660." });
  }
  if (!Number.isFinite(monto) || monto < 0 || monto > 1e12) {
    return res.status(400).json({ error: "El monto debe ser un número mayor o igual a cero." });
  }

  try {
    // Registro del pago y extensión de la suscripción en una sola transacción.
    const resultado = await activarManual(connection.promise(), {
      empresaId, dias, monto,
      operador: String(req.user?.username || "superadmin"),
      idOperacion: `MANUAL_${crypto.randomUUID()}`,
    });
    if (!resultado.ok) return res.status(404).json({ error: (resultado as any).motivo });
    res.json({ success: true, message: `Activación manual de ${dias} días para la empresa #${empresaId} completada exitosamente.` });
  } catch (err) {
    console.error("Error en activación manual:", err);
    res.status(500).json({ error: "Error técnico al registrar la activación manual." });
  }
});

// --- MÓDULO DE GASTOS / SALIDAS DE DINERO SAAS (SUPER ADMIN) ---
// La tabla saas_gastos la crea la migración 20261120_001_pagos_saas_eventos (no se hace DDL en peticiones).

// Listar todas las salidas de dinero
router.get("/superadmin/gastos", verifySuperAdmin, (req: any, res: any) => {
  connection.query(
    "SELECT * FROM saas_gastos ORDER BY fecha DESC, id DESC",
    (err: any, results: any[]) => {
      if (err) {
        console.error("Error consultando saas_gastos:", err);
        return res.status(500).json({ error: "Error consultando gastos SaaS" });
      }
      res.json(results || []);
    }
  );
});

// Crear nueva salida de dinero
router.post("/superadmin/gastos", verifySuperAdmin, (req: any, res: any) => {
  const { categoria, descripcion, monto, fecha, metodo_pago, comprobante_url } = req.body;

  if (!categoria || !descripcion || !monto) {
    return res.status(400).json({ error: "Categoría, descripción y monto son obligatorios." });
  }

  const montoNum = parseFloat(monto);
  if (isNaN(montoNum) || montoNum <= 0) {
    return res.status(400).json({ error: "El monto debe ser un valor numérico positivo." });
  }

  const fechaGasto = fecha || new Date().toISOString().slice(0, 10);
  const user = req.user?.username || "superadmin";

  const q = `
    INSERT INTO saas_gastos (categoria, descripcion, monto, fecha, metodo_pago, comprobante_url, creado_por)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  connection.query(
    q,
    [categoria, descripcion, montoNum, fechaGasto, metodo_pago || "Transferencia", comprobante_url || null, user],
    (err: any, result: any) => {
      if (err) {
        console.error("Error registrando gasto SaaS:", err);
        return res.status(500).json({ error: "Error registrando la salida de dinero." });
      }
      res.json({
        success: true,
        id: result.insertId,
        message: "Salida de dinero registrada exitosamente."
      });
    }
  );
});

// Eliminar salida de dinero
router.delete("/superadmin/gastos/:id", verifySuperAdmin, (req: any, res: any) => {
  const { id } = req.params;
  connection.query("DELETE FROM saas_gastos WHERE id = ?", [id], (err: any, result: any) => {
    if (err) {
      console.error("Error eliminando gasto SaaS:", err);
      return res.status(500).json({ error: "Error al eliminar la salida de dinero." });
    }
    if (result.affectedRows === 0) {
      return res.status(404).json({ error: "Registro no encontrado." });
    }
    res.json({ success: true, message: "Gasto eliminado exitosamente." });
  });
});

export default router;
