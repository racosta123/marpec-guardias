// Configuración de empresa (solo admin). En esta fase solo se guarda; la usa la Fase 3.
import { auditoria, authenticate, bad, int, readJson, requireRol, TZ } from "../common.js";
import { commit } from "../google.js";
import { CONFIG_DEFECTO } from "../asistencia.js";

export async function guardarConfig(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin");
  const b = await readJson(request);
  const toleranciaRetardoMin = int(b.toleranciaRetardoMin, "Tolerancia de retardo (min)", 0, 120);
  const limiteFaltaMin = int(b.limiteFaltaMin, "Límite de falta (min)", 1, 480);
  const retardosPorFalta = int(b.retardosPorFalta, "Retardos por falta", 1, 20);
  if (limiteFaltaMin <= toleranciaRetardoMin) throw bad("El límite de falta debe ser mayor que la tolerancia de retardo.");
  // Fase 3 (opcionales; si no vienen se usan los valores por defecto)
  const ventanaEntradaMin = b.ventanaEntradaMin === undefined ? CONFIG_DEFECTO.ventanaEntradaMin : int(b.ventanaEntradaMin, "Ventana de entrada (min)", 0, 240);
  const toleranciaRelevoMin = b.toleranciaRelevoMin === undefined ? CONFIG_DEFECTO.toleranciaRelevoMin : int(b.toleranciaRelevoMin, "Tolerancia de relevo (min)", 0, 240);
  const retencionVisitantesDias = b.retencionVisitantesDias === undefined ? CONFIG_DEFECTO.retencionVisitantesDias : int(b.retencionVisitantesDias, "Retención de visitantes (días)", 7, 1825);
  let limitesExtraPorAnio = CONFIG_DEFECTO.limitesExtraPorAnio;
  if (b.limitesExtraPorAnio !== undefined) {
    if (!Array.isArray(b.limitesExtraPorAnio) || b.limitesExtraPorAnio.length > 12) throw bad("Límites de horas extra: hasta 12 años.");
    const vistos = new Set();
    limitesExtraPorAnio = b.limitesExtraPorAnio.map((x) => {
      const anio = int(x?.anio, "Año", 2020, 2100);
      const horasSemana = int(x?.horasSemana, "Horas extra por semana", 1, 60);
      if (vistos.has(anio)) throw bad(`Año repetido: ${anio}.`);
      vistos.add(anio);
      return { anio, horasSemana };
    }).sort((p, q) => p.anio - q.anio);
  }
  const data = { toleranciaRetardoMin, limiteFaltaMin, retardosPorFalta, ventanaEntradaMin, toleranciaRelevoMin, retencionVisitantesDias, limitesExtraPorAnio, zonaHoraria: TZ };
  await commit(env, [
    { path: "configuracion/empresa", data, serverTimeField: "actualizadoEn" },
    auditoria(actor, "config.guardar", "configuracion/empresa", data),
  ]);
  return { status: 200, body: { ok: true } };
}
