import crypto from "crypto";

/**
 * Verificación y validación de eventos de Wompi para el cobro SaaS.
 * Son funciones puras (sin acceso a base de datos) para poder probarlas de forma aislada.
 */

export interface WompiEvento {
  event?: string;
  data?: any;
  timestamp?: number;
  signature?: { properties?: string[]; checksum?: string };
}

// Propiedades que la firma debe cubrir obligatoriamente: id, estado e importe de la transacción.
const PROPIEDADES_OBLIGATORIAS = ["transaction.id", "transaction.status", "transaction.amount_in_cents"];

function valorPorRuta(origen: any, ruta: string): string | null {
  let actual = origen;
  for (const clave of ruta.split(".")) {
    if (actual === null || typeof actual !== "object" || !(clave in actual)) return null;
    actual = actual[clave];
  }
  if (actual === null || actual === undefined || typeof actual === "object") return null;
  return String(actual);
}

/** Calcula el checksum que Wompi debió enviar: SHA256(valores firmados + timestamp + secreto de eventos). */
export function checksumEsperado(evento: WompiEvento, secreto: string): string | null {
  const props = evento?.signature?.properties;
  if (!Array.isArray(props) || props.length === 0 || props.length > 20) return null;
  if (!PROPIEDADES_OBLIGATORIAS.every((p) => props.includes(p))) return null;
  if (typeof evento.timestamp !== "number" || !Number.isFinite(evento.timestamp)) return null;

  let cadena = "";
  for (const prop of props) {
    if (typeof prop !== "string" || !/^[a-zA-Z0-9_.]+$/.test(prop)) return null;
    const valor = valorPorRuta(evento.data, prop);
    if (valor === null) return null;
    cadena += valor;
  }
  cadena += String(evento.timestamp) + secreto;
  return crypto.createHash("sha256").update(cadena).digest("hex");
}

/** Comparación en tiempo constante. Sin secreto configurado siempre devuelve false (falla cerrado). */
export function firmaValida(evento: WompiEvento, secreto: string): boolean {
  if (!secreto) return false;
  const esperado = checksumEsperado(evento, secreto);
  const recibido = evento?.signature?.checksum;
  if (!esperado || typeof recibido !== "string" || !/^[a-fA-F0-9]{64}$/.test(recibido)) return false;
  return crypto.timingSafeEqual(Buffer.from(esperado, "hex"), Buffer.from(recibido.toLowerCase(), "hex"));
}

export interface ReferenciaPago {
  empresaId: number;
  /** Días declarados en la referencia (solo formato nuevo). Se contrasta con el importe, no se confía en él. */
  diasDeclarados: number | null;
  feDeclarada: boolean;
}

/**
 * Formatos que emite el frontend actual:
 *  - SUB_<30|180|365>[_FE]_<empresa>_<timestamp>   (PricingPlans)
 *  - SUB_<empresa>_<timestamp>                       (Dashboard, formato antiguo)
 *  - SUB_LOGIN_<empresa>_<timestamp>                 (renovación desde el login)
 */
export function parsearReferencia(referencia: unknown): ReferenciaPago | null {
  if (typeof referencia !== "string" || referencia.length > 100) return null;
  let m = /^SUB_(30|180|365)(_FE)?_(\d{1,9})_(\d{10,15})$/.exec(referencia);
  if (m) return { empresaId: Number(m[3]), diasDeclarados: Number(m[1]), feDeclarada: Boolean(m[2]) };
  m = /^SUB_LOGIN_(\d{1,9})_(\d{10,15})$/.exec(referencia) || /^SUB_(\d{1,9})_(\d{10,15})$/.exec(referencia);
  if (m && Number(m[1]) > 0) return { empresaId: Number(m[1]), diasDeclarados: null, feDeclarada: false };
  return null;
}

export interface PreciosPlan {
  mes: number;
  semestre: number;
  anio: number;
}

// Planes con facturación electrónica: mismos importes que ofrece PricingPlans.tsx.
const PRECIOS_FE = { 30: 10000000, 180: 54000000, 365: 96000000 } as const;

/** Resuelve el plan por el importe pagado (centavos). Los días jamás se toman de la referencia. */
export function resolverPlan(montoCentavos: number, precios: PreciosPlan): { dias: number; fe: boolean } | null {
  const catalogo: { dias: number; fe: boolean; centavos: number }[] = [
    { dias: 30, fe: false, centavos: precios.mes },
    { dias: 180, fe: false, centavos: precios.semestre },
    { dias: 365, fe: false, centavos: precios.anio },
    { dias: 30, fe: true, centavos: PRECIOS_FE[30] },
    { dias: 180, fe: true, centavos: PRECIOS_FE[180] },
    { dias: 365, fe: true, centavos: PRECIOS_FE[365] },
  ];
  const plan = catalogo.find((p) => Number.isSafeInteger(p.centavos) && p.centavos > 0 && p.centavos === montoCentavos);
  return plan ? { dias: plan.dias, fe: plan.fe } : null;
}
