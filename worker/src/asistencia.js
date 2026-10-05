// Cálculo de asistencia (lógica pura, sin red). Todo en milisegundos UTC; la zona America/Hermosillo
// (UTC-7 fijo) solo interviene para agrupar por día/semana. Los resultados NO tocan las marcas.
import { TZ_OFFSET_MS } from "./common.js";

export const MIN = 60000;
const DIA = 86400000;

// Valores por defecto de la configuración de empresa (se sobrescriben con configuracion/empresa).
export const CONFIG_DEFECTO = {
  toleranciaRetardoMin: 10,
  limiteFaltaMin: 30,
  retardosPorFalta: 3,
  ventanaEntradaMin: 30, // el guardia puede marcar entrada desde N min antes del inicio
  toleranciaRelevoMin: 30, // alerta si el relevo no llega al fin del turno + N min
  retencionVisitantesDias: 90, // días que se conservan los registros y fotos de visitantes
  offlineMaxHoras: 12, // antigüedad máxima de un registro capturado sin internet para aceptarlo
  // Límites de horas extra dobles por semana, configurables por año (reforma 2027: 12 h).
  limitesExtraPorAnio: [{ anio: 2026, horasSemana: 9 }, { anio: 2027, horasSemana: 12 }],
};

export const configEfectiva = (c = {}) => ({ ...CONFIG_DEFECTO, ...Object.fromEntries(Object.entries(c || {}).filter(([, v]) => v !== undefined && v !== null)) });

// Hora efectiva: el último ajuste (corrección con motivo) manda; si no hay, la marca original.
export function horaEfectiva(marcaMs, ajustes, tipo) {
  const del = (ajustes || []).filter((a) => a.tipo === tipo).sort((x, y) => (y.tsMs || 0) - (x.tsMs || 0));
  if (del.length) return del[0].horaMs;
  return marcaMs ?? null;
}

// Entradas:
//   turno      { inicioMs, finMs, estado }
//   entradaMs / salidaMs  horas efectivas (marca o ajuste) o null
//   ahora      ms
//   config     configEfectiva(...)
//   sucesor    { existe, turnoId?, guardiaUid?, entradaMs? }  (turno que releva en el mismo sitio)
//   cierreAutorizado  bool (supervisor autorizó cerrar sin relevo)
//   decisionExtra     { estado:'autorizado'|'rechazado', minutos } | null  (última decisión del supervisor)
export function calcularAsistencia({ turno, entradaMs = null, salidaMs = null, ahora, config, sucesor = { existe: false }, cierreAutorizado = false, decisionExtra = null }) {
  const c = configEfectiva(config);
  const out = {
    estado: "programado", entradaMs, salidaMs, retardoMin: 0, retardo: false, falta: false, motivoFalta: null,
    minutosExtra: 0, extraEnCurso: false, extraEstado: "ninguno", salidaAnticipadaMin: 0,
    relevoRequerido: Boolean(sucesor.existe), relevoLlegado: sucesor.entradaMs != null, cierreAutorizado: Boolean(cierreAutorizado), relevoAlerta: false,
    puedeCerrar: false,
  };
  if (turno.estado === "cancelado") return { ...out, estado: "cancelado" };

  const { inicioMs, finMs } = turno;
  out.puedeCerrar = !out.relevoRequerido || out.relevoLlegado || out.cierreAutorizado;

  if (entradaMs != null) {
    const tarde = Math.floor((entradaMs - inicioMs) / MIN);
    out.retardoMin = Math.max(0, tarde);
    if (tarde > c.limiteFaltaMin) { out.falta = true; out.motivoFalta = "entrada_tardia"; }
    else if (tarde > c.toleranciaRetardoMin) out.retardo = true;
  } else if (ahora > inicioMs + c.limiteFaltaMin * MIN) {
    out.falta = true;
    out.motivoFalta = "sin_entrada";
  }

  if (entradaMs != null) {
    if (salidaMs != null) out.minutosExtra = Math.max(0, Math.floor((salidaMs - finMs) / MIN));
    else if (ahora > finMs) { out.minutosExtra = Math.max(0, Math.floor((ahora - finMs) / MIN)); out.extraEnCurso = true; }
    if (salidaMs != null && salidaMs < finMs) out.salidaAnticipadaMin = Math.ceil((finMs - salidaMs) / MIN);
  }
  if (out.minutosExtra > 0) {
    out.extraEstado = !out.extraEnCurso && decisionExtra && decisionExtra.minutos === out.minutosExtra ? decisionExtra.estado : "pendiente";
  }

  // Alerta de relevo: el saliente sigue en el puesto, ya pasó fin + tolerancia y el relevo no ha marcado entrada.
  out.relevoAlerta = entradaMs != null && salidaMs == null && out.relevoRequerido && !out.relevoLlegado && !out.cierreAutorizado
    && ahora > finMs + c.toleranciaRelevoMin * MIN;

  if (entradaMs == null) out.estado = out.falta ? "falta" : ahora < inicioMs - c.ventanaEntradaMin * MIN ? "programado" : "por_marcar";
  else if (salidaMs != null) out.estado = "cumplido";
  else if (out.relevoAlerta) out.estado = "relevo_no_llego";
  else out.estado = ahora > finMs ? "salida_pendiente" : "en_turno";
  return out;
}

// ---- agrupación por semana (lunes a domingo, hora de Hermosillo) ----
export const fechaLocal = (ms) => new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 10);
export function lunesDe(ms) {
  const d = new Date(ms + TZ_OFFSET_MS);
  const dow = (d.getUTCDay() + 6) % 7; // 0 = lunes
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
}

// Límite de horas extra dobles por semana para un año: el del año exacto o, si no existe, el del año
// configurado más reciente anterior. null si no hay ninguno configurado.
export function limiteHorasSemana(config, anio) {
  const l = (configEfectiva(config).limitesExtraPorAnio || []).filter((x) => x && Number.isInteger(x.anio)).sort((a, b) => a.anio - b.anio);
  const aplicable = [...l].reverse().find((x) => x.anio <= anio);
  return aplicable ? aplicable.horasSemana : null;
}

// asistencias: [{ guardiaUid, inicioMs, minutosExtra, extraEstado }] → acumulado por guardia y semana.
export function acumuladoSemanal(asistencias, config) {
  const mapa = new Map();
  for (const a of asistencias) {
    if (!a.minutosExtra || a.extraEstado === "ninguno" || !a.guardiaUid) continue;
    const semana = lunesDe(a.inicioMs);
    const k = `${a.guardiaUid}|${semana}`;
    const f = mapa.get(k) || { guardiaUid: a.guardiaUid, semana, anio: Number(semana.slice(0, 4)), pendienteMin: 0, autorizadoMin: 0, rechazadoMin: 0 };
    f[`${a.extraEstado}Min`] += a.minutosExtra;
    mapa.set(k, f);
  }
  return [...mapa.values()].map((f) => {
    const limite = limiteHorasSemana(config, f.anio);
    const considerado = (f.pendienteMin + f.autorizadoMin) / 60;
    return { ...f, limiteHoras: limite, horasConsideradas: Math.round(considerado * 100) / 100, excedeLimite: limite != null && considerado > limite };
  }).sort((a, b) => a.semana.localeCompare(b.semana) || a.guardiaUid.localeCompare(b.guardiaUid));
}

export const DIA_MS = DIA;
