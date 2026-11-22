import type { Pool } from "mysql2/promise";
import { parsearReferencia, resolverPlan, PreciosPlan } from "./wompiEventos";

export interface PagoAprobado {
  proveedor: "wompi";
  eventoId: string;
  referencia: unknown;
  montoCentavos: number;
  moneda: string;
}

export type ResultadoPago =
  | { estado: "aplicado"; empresaId: number; dias: number }
  | { estado: "conciliar" | "rechazado"; motivo: string }
  | { estado: "duplicado" };

const SQL_EXTENDER_SUSCRIPCION = `
  UPDATE empresas_suscritas
     SET estado = 'Active',
         fecha_vencimiento_suscripcion = CASE
           WHEN fecha_vencimiento_suscripcion < CURRENT_DATE() THEN DATE_ADD(CURRENT_DATE(), INTERVAL ? DAY)
           ELSE DATE_ADD(fecha_vencimiento_suscripcion, INTERVAL ? DAY)
         END
   WHERE id = ?`;

/**
 * Registra un pago aprobado y extiende la suscripción exactamente una vez.
 *
 * - La clave UNIQUE (proveedor, evento_id) de pagos_saas_eventos garantiza la idempotencia, incluso
 *   con reintentos o entregas concurrentes: el segundo intento espera, ve el duplicado y no suma.
 * - Evento y extensión se confirman en una sola transacción: no existe "pago registrado sin extender"
 *   ni "extendido sin registrar".
 * - Los días se deducen del importe pagado. Si el importe no corresponde a ningún plan, la moneda no es
 *   COP, la empresa no existe o la referencia contradice el importe, el evento se guarda como
 *   'conciliar' para revisión manual y NO se extiende nada.
 */
export async function registrarPagoAprobado(
  pool: Pool,
  pago: PagoAprobado,
  precios: PreciosPlan
): Promise<ResultadoPago> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const ref = parsearReferencia(pago.referencia);
    let empresaId: number | null = ref ? ref.empresaId : null;
    let dias: number | null = null;
    let estado: "aplicado" | "conciliar" = "aplicado";
    let motivo: string | null = null;

    const plan = resolverPlan(pago.montoCentavos, precios);
    if (!ref) {
      estado = "conciliar"; motivo = "referencia no reconocida";
    } else if (pago.moneda !== "COP") {
      estado = "conciliar"; motivo = "moneda distinta de COP";
    } else if (!plan) {
      estado = "conciliar"; motivo = "importe no corresponde a ningún plan";
    } else if (ref.diasDeclarados !== null && (ref.diasDeclarados !== plan.dias || ref.feDeclarada !== plan.fe)) {
      estado = "conciliar"; motivo = "la referencia contradice el importe pagado";
    } else {
      dias = plan.dias;
    }

    if (estado === "aplicado" && empresaId !== null) {
      // FOR UPDATE serializa renovaciones concurrentes de la misma empresa.
      const [emp]: any = await conn.query("SELECT id FROM empresas_suscritas WHERE id = ? FOR UPDATE", [empresaId]);
      if (emp.length !== 1) {
        estado = "conciliar"; motivo = "empresa inexistente"; dias = null;
      }
    }

    try {
      await conn.query(
        `INSERT INTO pagos_saas_eventos (proveedor, evento_id, referencia, empresa_id, monto_centavos, moneda, dias, estado, detalle)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          pago.proveedor, pago.eventoId, String(pago.referencia ?? "").slice(0, 255),
          empresaId,
          pago.montoCentavos, pago.moneda.slice(0, 3), dias, estado, motivo,
        ]
      );
    } catch (e: any) {
      if (e.code === "ER_DUP_ENTRY") {
        await conn.rollback();
        return { estado: "duplicado" };
      }
      throw e;
    }

    if (estado !== "aplicado" || empresaId === null || dias === null) {
      await conn.commit();
      return { estado: "conciliar", motivo: motivo || "requiere revisión" };
    }

    await conn.query(
      "INSERT INTO pagos_suscripcion (empresa_id, wompi_transaction_id, monto, dias_agregados, metodo_pago) VALUES (?, ?, ?, ?, 'Wompi')",
      [empresaId, pago.eventoId, pago.montoCentavos / 100, dias]
    );
    const [upd]: any = await conn.query(SQL_EXTENDER_SUSCRIPCION, [dias, dias, empresaId]);
    if (upd.affectedRows !== 1) throw new Error("No se pudo extender la suscripción");

    await conn.commit();
    return { estado: "aplicado", empresaId, dias };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

export interface ActivacionManual {
  empresaId: number;
  dias: number;
  monto: number;
  operador: string;
  idOperacion: string;
}

/** Activación manual (pago físico): registro y extensión atómicos, con identificador de operación único. */
export async function activarManual(pool: Pool, a: ActivacionManual): Promise<{ ok: true } | { ok: false; motivo: string }> {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [emp]: any = await conn.query("SELECT id FROM empresas_suscritas WHERE id = ? FOR UPDATE", [a.empresaId]);
    if (emp.length !== 1) {
      await conn.rollback();
      return { ok: false, motivo: "Empresa no encontrada." };
    }
    await conn.query(
      "INSERT INTO pagos_suscripcion (empresa_id, wompi_transaction_id, monto, dias_agregados, metodo_pago) VALUES (?, ?, ?, ?, ?)",
      [a.empresaId, a.idOperacion, a.monto, a.dias, `Manual (${a.operador}`.slice(0, 98) + ")"]
    );
    await conn.query(SQL_EXTENDER_SUSCRIPCION, [a.dias, a.dias, a.empresaId]);
    await conn.commit();
    return { ok: true };
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}
