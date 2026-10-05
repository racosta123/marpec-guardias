// Rondines: programación (slots) y cálculo del estado de cada rondín. Lógica pura, sin red.
// Todo en milisegundos UTC; la zona America/Hermosillo (UTC-7 fijo) solo se usa para horarios fijos.
import { bad, localAMs, RE_HORA } from "./common.js";

const MIN = 60000;
const H = 60 * MIN;
export const MAX_SLOTS_TURNO = 60;

export const PROGRAMA_DEFECTO = {
  modo: "libre", // "ordenada" | "libre"
  frecuencia: { tipo: "cada_horas", cadaHoras: 2 }, // o { tipo: "horarios", horarios: ["22:00", "02:00"] }
  toleranciaInicioMin: 15, // el rondín puede iniciar desde (programado − tol) hasta (programado + tol)
  toleranciaFinMin: 45, // debe quedar completo a más tardar a (programado + tolFin)
};

export const programaEfectivo = (p) => ({ ...PROGRAMA_DEFECTO, ...(p || {}), frecuencia: { ...PROGRAMA_DEFECTO.frecuencia, ...((p && p.frecuencia) || {}) } });

// Rondines programados dentro de un turno. cada_horas: inicio + k·X (k ≥ 1) mientras sea antes del fin.
// horarios fijos: cada HH:MM (hora de Hermosillo) que caiga dentro del turno, también si cruza medianoche.
export function generarSlots(turno, programa) {
  const p = programaEfectivo(programa);
  const f = p.frecuencia;
  const marcas = new Set();
  if (f.tipo === "cada_horas") {
    const paso = Math.round(Number(f.cadaHoras) * H);
    if (!(paso >= 30 * MIN)) return [];
    for (let t = turno.inicioMs + paso; t < turno.finMs && marcas.size < MAX_SLOTS_TURNO; t += paso) marcas.add(t);
  } else if (f.tipo === "horarios") {
    const dia = (ms) => new Date(ms - 7 * H).toISOString().slice(0, 10);
    let d = dia(turno.inicioMs - 24 * H);
    const ultimo = dia(turno.finMs + 24 * H);
    for (let guardia = 0; d <= ultimo && guardia < 8; guardia++) {
      for (const hh of f.horarios || []) {
        const ms = localAMs(d, hh);
        if (ms >= turno.inicioMs && ms < turno.finMs) marcas.add(ms);
      }
      d = dia(localAMs(d, "12:00") + 24 * H);
    }
  }
  return [...marcas].sort((a, b) => a - b).slice(0, MAX_SLOTS_TURNO).map((programadoMs, indice) => ({
    indice, programadoMs,
    abreMs: programadoMs - p.toleranciaInicioMin * MIN,
    cierraInicioMs: programadoMs + p.toleranciaInicioMin * MIN,
    venceMs: programadoMs + p.toleranciaFinMin * MIN,
  }));
}

export function validarPrograma(b) {
  const modo = b.modo;
  if (modo !== "ordenada" && modo !== "libre") throw bad("Modo: ordenada o libre.");
  const f = b.frecuencia || {};
  let frecuencia;
  if (f.tipo === "cada_horas") {
    const x = f.cadaHoras;
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0.5 || x > 24) throw bad("Cada cuántas horas: entre 0.5 y 24.");
    frecuencia = { tipo: "cada_horas", cadaHoras: x };
  } else if (f.tipo === "horarios") {
    if (!Array.isArray(f.horarios) || f.horarios.length < 1 || f.horarios.length > 24 || !f.horarios.every((h) => typeof h === "string" && RE_HORA.test(h)))
      throw bad("Horarios fijos: de 1 a 24 horas en formato HH:MM.");
    frecuencia = { tipo: "horarios", horarios: [...new Set(f.horarios)].sort() };
  } else throw bad("Frecuencia: cada_horas u horarios.");
  const ti = b.toleranciaInicioMin, tf = b.toleranciaFinMin;
  if (!Number.isInteger(ti) || ti < 0 || ti > 120) throw bad("Tolerancia para empezar: 0 a 120 min.");
  if (!Number.isInteger(tf) || tf < 5 || tf > 480) throw bad("Tolerancia para terminar: 5 a 480 min.");
  if (tf < ti) throw bad("La tolerancia para terminar debe ser mayor o igual que la de empezar.");
  return { modo, frecuencia, toleranciaInicioMin: ti, toleranciaFinMin: tf };
}

// requeridos: [{ puntoId, nombre, orden }] (orden ascendente)
// escaneos: [{ puntoId, tsMs, nota?, foto?, distanciaM? }]   ajustes: [{ tipo, puntoId?, tsMs, motivo, autorNombre }]
export function calcularRondin({ slot, modo, requeridos, escaneos = [], ajustes = [], ahora, entradaMs = null }) {
  const hechos = new Map();
  for (const e of [...escaneos].sort((a, b) => a.tsMs - b.tsMs)) if (!hechos.has(e.puntoId)) hechos.set(e.puntoId, { tsMs: e.tsMs, origen: "escaneo", ...e });
  for (const a of ajustes) if (a.tipo === "marcar_punto" && !hechos.has(a.puntoId)) hechos.set(a.puntoId, { puntoId: a.puntoId, tsMs: a.horaMs ?? a.tsMs, origen: "ajuste", motivo: a.motivo, autorNombre: a.autorNombre });
  const justificado = ajustes.find((a) => a.tipo === "justificar_rondin") || null;

  const faltantes = requeridos.filter((r) => !hechos.has(r.puntoId));
  const iniciadoMs = escaneos.length ? Math.min(...escaneos.map((e) => e.tsMs)) : null;
  const total = requeridos.length;
  const hechosN = total - faltantes.length;
  const completo = total > 0 && faltantes.length === 0;
  const finalizadoMs = completo ? Math.max(...[...hechos.values()].map((h) => h.tsMs)) : null;

  let estado;
  if (justificado) estado = "justificado";
  else if (completo) estado = "completo";
  else if (iniciadoMs !== null || hechosN > 0) estado = ahora > slot.venceMs ? "incompleto" : "en_curso";
  else if (entradaMs === null && ahora > slot.cierraInicioMs) estado = "no_exigible"; // el guardia nunca entró: ya es falta
  else if (ahora < slot.abreMs) estado = "programado";
  else if (ahora <= slot.cierraInicioMs) estado = "pendiente";
  else estado = "no_iniciado";

  const siguiente = modo === "ordenada" ? faltantes[0] || null : null;
  return {
    estado, iniciadoMs, finalizadoMs, total, hechos: hechosN,
    porcentaje: total ? Math.round((hechosN / total) * 100) : 0,
    faltantes: faltantes.map((f) => ({ puntoId: f.puntoId, nombre: f.nombre, orden: f.orden })),
    // "punto saltado": el rondín terminó su plazo con puntos pendientes habiendo escaneado otros
    saltados: estado === "incompleto" ? faltantes.map((f) => f.nombre) : [],
    siguientePuntoId: siguiente ? siguiente.puntoId : null,
    justificadoPor: justificado ? justificado.autorNombre : null, justificadoMotivo: justificado ? justificado.motivo : null,
    detalle: requeridos.map((r) => {
      const h = hechos.get(r.puntoId);
      return { puntoId: r.puntoId, nombre: r.nombre, orden: r.orden, hecho: Boolean(h), tsMs: h ? h.tsMs : null, origen: h ? h.origen : null,
        nota: h?.nota || "", foto: Boolean(h?.fotoKey), sin_conexion: h?.sin_conexion === true, distanciaM: h?.distanciaM ?? null, ajusteMotivo: h?.motivo || null, ajustePor: h?.autorNombre || null };
    }),
  };
}

// Qué rondín atiende un escaneo en `ahora`: primero uno ya iniciado y vigente; si no, el primero cuya
// ventana de inicio esté abierta. `estados`: { [indice]: estado calculado }.
export function elegirSlot(slots, estados, ahora) {
  const vigentes = slots.filter((s) => ahora >= s.abreMs && ahora <= s.venceMs && !["completo", "justificado"].includes(estados[s.indice]));
  return vigentes.find((s) => estados[s.indice] === "en_curso") || vigentes.find((s) => ahora <= s.cierraInicioMs) || null;
}

// Cumplimiento: completos / exigibles (completo + incompleto + no_iniciado).
export function cumplimiento(rondines) {
  const exig = rondines.filter((r) => ["completo", "incompleto", "no_iniciado"].includes(r.estado));
  const ok = exig.filter((r) => r.estado === "completo").length;
  return { exigibles: exig.length, completos: ok, incompletos: exig.filter((r) => r.estado === "incompleto").length, noIniciados: exig.filter((r) => r.estado === "no_iniciado").length, porcentaje: exig.length ? Math.round((ok / exig.length) * 1000) / 10 : null };
}
