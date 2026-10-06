// Licencia de demostración (lado cliente). El estado lo da el Worker (GET público y mínimo /licencia/estado); la
// verdadera barrera son el Worker (403 "demo_vencido") y las reglas de Firestore: esto solo avisa y muestra la pantalla.
import { config } from "./config.js";

export const DIAS_AVISO = 10;
export const MENSAJE_VENCIDO = "Periodo de demostración concluido. Para continuar usando MARPEC Guardias, contacta a Diagonal Catorce.";
const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];

// null si no se pudo consultar (sin conexión): no se bloquea nada por no poder preguntar.
export async function estadoLicencia() {
  try {
    const r = await fetch(`${config.workerUrl}/licencia/estado`, { cache: "no-store", referrerPolicy: "no-referrer" });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// "2026-11-04" -> "4 de noviembre de 2026" (el día ya viene en hora de Hermosillo).
export function fechaLarga(dia) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dia || "");
  return m ? `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}` : "";
}

// Banner solo para administradores y supervisores, a partir de 10 días antes del vencimiento.
export function debeAvisar(estado, rol) {
  return !!estado && estado.modo === "demo" && !estado.vencido && Number.isFinite(estado.diasRestantes)
    && estado.diasRestantes <= DIAS_AVISO && (rol === "admin" || rol === "supervisor");
}

export function textoBanner(estado) {
  return `Periodo de demostración próximo a vencer: vence el ${fechaLarga(estado.venceDia)}. Para continuar, contacta a Diagonal Catorce.`;
}
