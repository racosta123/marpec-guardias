// Configuración de empresa (solo admin). En esta fase solo se guarda; la usa la Fase 3.
import { auditoria, authenticate, bad, int, readJson, requireRol, TZ } from "../common.js";
import { commit } from "../google.js";

export async function guardarConfig(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const b = await readJson(request);
  const toleranciaRetardoMin = int(b.toleranciaRetardoMin, "Tolerancia de retardo (min)", 0, 120);
  const limiteFaltaMin = int(b.limiteFaltaMin, "Límite de falta (min)", 1, 480);
  const retardosPorFalta = int(b.retardosPorFalta, "Retardos por falta", 1, 20);
  if (limiteFaltaMin <= toleranciaRetardoMin) throw bad("El límite de falta debe ser mayor que la tolerancia de retardo.");
  const data = { toleranciaRetardoMin, limiteFaltaMin, retardosPorFalta, zonaHoraria: TZ };
  await commit(env, [
    { path: "configuracion/empresa", data, serverTimeField: "actualizadoEn" },
    auditoria(actor, "config.guardar", "configuracion/empresa", data),
  ]);
  return { status: 200, body: { ok: true } };
}
