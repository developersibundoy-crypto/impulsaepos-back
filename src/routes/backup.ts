import express from "express";
import pool from "../conection";
import { verifyTokenAndTenant } from "../middlewares/authMiddleware";

const router = express.Router();

// Lista blanca explícita de tablas exportables. Todas tienen columna empresa_id.
// Nunca se incluyen usuarios, credenciales, OTP ni configuración de la plataforma.
const TABLAS_EXPORTABLES = [
  "productos",
  "categorias",
  "cajeros",
  "clientes",
  "proveedores",
  "ventas",
  "detalle_venta",
  "facturas_venta",
  "compras",
  "detalle_compra",
  "separados",
  "kardex",
  "empresa_config",
] as const;

// Respaldo de la empresa autenticada. La empresa sale SIEMPRE del token verificado, nunca de la petición.
router.get("/download", verifyTokenAndTenant, async (req: any, res: any) => {
  const empresaId = Number(req.user?.empresa_id);
  if (!Number.isSafeInteger(empresaId) || empresaId < 1) {
    return res.status(403).json({ error: "El respaldo requiere una empresa asociada a la sesión." });
  }

  try {
    const db = pool.promise();
    const datos: Record<string, unknown[]> = {};
    for (const tabla of TABLAS_EXPORTABLES) {
      // El nombre de tabla proviene de la lista blanca constante; el valor se parametriza.
      const [filas] = await db.query(`SELECT * FROM \`${tabla}\` WHERE empresa_id = ?`, [empresaId]);
      datos[tabla] = filas as unknown[];
    }

    const ahora = new Date();
    const pad = (n: number) => n.toString().padStart(2, "0");
    const fecha = `${ahora.getFullYear()}-${pad(ahora.getMonth() + 1)}-${pad(ahora.getDate())}`;
    const filename = `copia_seguridad_empresa${empresaId}_${fecha}.json`;

    res.setHeader("Content-Disposition", `attachment; filename=${filename}`);
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Access-Control-Expose-Headers", "Content-Disposition");
    res.send(
      JSON.stringify(
        {
          plataforma: "Sistema POS v1.0",
          empresa_id: empresaId,
          fecha_backup_hora: ahora.toLocaleString("es-CO", { timeZone: "America/Bogota" }),
          tablas_exportadas: TABLAS_EXPORTABLES.length,
          datos,
        },
        null,
        2
      )
    );
  } catch (error) {
    console.error("[BACKUP] Error generando la copia de seguridad:", error);
    res.status(500).json({ error: "No se pudo generar la copia de seguridad." });
  }
});

export default router;
