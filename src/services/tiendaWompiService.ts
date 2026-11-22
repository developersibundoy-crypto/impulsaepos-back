import crypto from "crypto";
import { firmaValida, WompiEvento } from "./wompiEventos";

/**
 * Servicio para gestión criptográfica y transaccional de Wompi por tienda/comercio.
 */

/**
 * Calcula la firma de integridad SHA-256 obligatoria para el widget/checkout de Wompi.
 * Fórmula oficial Wompi: SHA256(referencia + montoEnCentavos + moneda + secretoIntegridad)
 */
export function calcularFirmaIntegridad(
  referencia: string,
  montoCentavos: number,
  moneda: string = "COP",
  secretoIntegridad: string
): string {
  if (!referencia || !Number.isSafeInteger(montoCentavos) || montoCentavos <= 0 || !secretoIntegridad) {
    throw new Error("Parámetros inválidos para generar la firma de integridad de Wompi.");
  }
  const cadena = `${referencia}${montoCentavos}${moneda}${secretoIntegridad.trim()}`;
  return crypto.createHash("sha256").update(cadena).digest("hex");
}

/**
 * Enmascara secretos para retornarlos de forma segura a la interfaz administrativa.
 * Muestra solo los últimos 4 caracteres precedidos por viñetas.
 */
export function enmascararSecreto(secreto: string | null | undefined): string {
  if (!secreto || typeof secreto !== "string") return "";
  const trim = secreto.trim();
  if (trim.length <= 4) return "••••";
  return "••••••••" + trim.slice(-4);
}

/**
 * Valida la consistencia de las llaves con el ambiente seleccionado.
 */
export function validarFormatoLlaves(
  ambiente: "sandbox" | "produccion",
  publicKey: string,
  integritySecret?: string,
  eventSecret?: string
): { valido: boolean; error?: string } {
  const pk = (publicKey || "").trim();
  if (!pk) {
    return { valido: false, error: "La Llave Pública es requerida." };
  }

  if (ambiente === "sandbox" && !pk.startsWith("pub_test_")) {
    return { valido: false, error: "En ambiente de Pruebas (Sandbox), la Llave Pública debe iniciar con 'pub_test_'." };
  }

  if (ambiente === "produccion" && !pk.startsWith("pub_prod_")) {
    return { valido: false, error: "En ambiente de Producción, la Llave Pública debe iniciar con 'pub_prod_'." };
  }

  if (integritySecret && !integritySecret.startsWith("••••")) {
    const is = integritySecret.trim();
    if (ambiente === "sandbox" && !is.startsWith("test_integrity_")) {
      return { valido: false, error: "El Secreto de Integridad de pruebas debe iniciar con 'test_integrity_'." };
    }
    if (ambiente === "produccion" && !is.startsWith("prod_integrity_")) {
      return { valido: false, error: "El Secreto de Integridad de producción debe iniciar con 'prod_integrity_'." };
    }
  }

  if (eventSecret && !eventSecret.startsWith("••••")) {
    const es = eventSecret.trim();
    if (ambiente === "sandbox" && !es.startsWith("test_events_")) {
      return { valido: false, error: "El Secreto de Eventos de pruebas debe iniciar con 'test_events_'." };
    }
    if (ambiente === "produccion" && !es.startsWith("prod_events_")) {
      return { valido: false, error: "El Secreto de Eventos de producción debe iniciar con 'prod_events_'." };
    }
  }

  return { valido: true };
}

/**
 * Valida la autenticidad del evento de webhook recibido de Wompi usando el secreto de eventos de la tienda.
 */
export function validarWebhookTienda(evento: WompiEvento, secretoEventos: string): boolean {
  if (!secretoEventos) return false;
  return firmaValida(evento, secretoEventos.trim());
}
