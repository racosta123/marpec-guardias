// Servicio de rondines: reúne programa, puntos, escaneos y ajustes de un turno, calcula el estado de
// cada rondín y lo guarda en rondines/{turnoId}_{indice} SOLO si cambió. Los escaneos nunca se tocan.
import { fechaLocal } from "../asistencia.js";
import { calcularRondin, generarSlots, programaEfectivo } from "../rondines.js";
import { commit, getDocument, runQuery } from "../google.js";
import { notificarUnaVez } from "../push.js";

const MIN = 60000;
// Comparación canónica (Firestore devuelve las llaves de los mapas ordenadas; el cálculo no).
const canon = (v) => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => [k, canon(v[k])])) : v);
const igual = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));

export async function puntosActivos(env, sitioId) {
  return (await runQuery(env, "puntos", [{ campo: "sitioId", op: "EQUAL", valor: sitioId }]))
    .filter((p) => p.activo !== false)
    .sort((a, b) => a.orden - b.orden || a.nombre.localeCompare(b.nombre, "es"));
}

// Contexto de un turno: programa, puntos, slots y hora efectiva de entrada.
export async function contextoTurno(env, turnoId, turno) {
  turno = turno || (await getDocument(env, `turnos/${turnoId}`));
  if (!turno || !turno.guardiaUid || turno.estado !== "programado") return null;
  const programaDoc = await getDocument(env, `programasRondin/${turno.sitioId}`);
  if (!programaDoc || programaDoc.activo === false) return { turno, programa: null, slots: [], puntos: [] };
  const [puntos, asis, guardia] = await Promise.all([puntosActivos(env, turno.sitioId), getDocument(env, `asistencias/${turnoId}`), getDocument(env, `usuarios/${turno.guardiaUid}`)]);
  const programa = programaEfectivo(programaDoc);
  return { turno, programa, programaDoc, puntos, slots: puntos.length ? generarSlots(turno, programa) : [], entradaMs: asis?.entradaMs ?? null, guardiaNombre: guardia?.nombre || "" };
}

// Calcula (y guarda si cambió) un rondín concreto.
export async function recalcularRondin(env, turnoId, slot, ctx, { ahora = Date.now() } = {}) {
  const rondinId = `${turnoId}_${slot.indice}`;
  const [previo, escaneos, ajustes] = await Promise.all([
    getDocument(env, `rondines/${rondinId}`),
    runQuery(env, "escaneos", [{ campo: "rondinId", op: "EQUAL", valor: rondinId }]),
    runQuery(env, "ajustesRondin", [{ campo: "rondinId", op: "EQUAL", valor: rondinId }]),
  ]);
  // Los puntos requeridos se congelan cuando abre la ventana del rondín (cambios posteriores no lo alteran).
  const actuales = ctx.puntos.map((p) => ({ puntoId: p.id, nombre: p.nombre, orden: p.orden }));
  const requeridos = previo?.requeridos?.length && ahora >= slot.abreMs ? previo.requeridos : actuales;
  const c = calcularRondin({ slot, modo: ctx.programa.modo, requeridos, escaneos, ajustes, ahora, entradaMs: ctx.entradaMs });
  const t = ctx.turno;
  const doc = {
    rondinId, turnoId, indice: slot.indice, sitioId: t.sitioId, sitioNombre: t.sitioNombre || "", supervisorUid: t.supervisorUid ?? null,
    guardiaUid: t.guardiaUid, guardiaNombre: ctx.guardiaNombre || "", modo: ctx.programa.modo, fecha: fechaLocal(slot.programadoMs),
    programadoMs: slot.programadoMs, abreMs: slot.abreMs, cierraInicioMs: slot.cierraInicioMs, venceMs: slot.venceMs,
    requeridos, estado: c.estado, iniciadoMs: c.iniciadoMs, finalizadoMs: c.finalizadoMs, total: c.total, hechos: c.hechos, porcentaje: c.porcentaje,
    faltantes: c.faltantes, saltados: c.saltados, siguientePuntoId: c.siguientePuntoId, detalle: c.detalle,
    justificadoPor: c.justificadoPor, justificadoMotivo: c.justificadoMotivo,
    ...(t.prueba === true ? { prueba: true } : {}),
  };
  const { calculadoMs, calculadoEn, ...prev } = previo || {};
  if (!previo || !igual(doc, prev)) {
    await commit(env, [{ path: `rondines/${rondinId}`, data: { ...doc, calculadoMs: ahora }, serverTimeField: "calculadoEn" }]);
    // Push: rondín no iniciado o incompleto (una vez por rondín y estado; nunca por rondines viejos).
    if (["no_iniciado", "incompleto"].includes(doc.estado) && previo?.estado !== doc.estado && ahora - slot.venceMs < 2 * 3600e3)
      await notificarUnaVez(env, `rondin-${rondinId}-${doc.estado}`, { evento: "rondin", sitioId: t.sitioId, prueba: t.prueba === true });
  }
  return { ...doc, calculadoMs: ahora };
}

// Recalcula los rondines de un turno. `soloActivos`: omite los ya cerrados hace tiempo y los lejanos.
export async function recalcularRondinesTurno(env, turnoId, { ahora = Date.now(), turno, soloActivos = false } = {}) {
  const ctx = await contextoTurno(env, turnoId, turno);
  if (!ctx || !ctx.programa || !ctx.slots.length) return [];
  const out = [];
  for (const slot of ctx.slots) {
    if (soloActivos && (ahora < slot.abreMs - 10 * MIN || ahora > slot.venceMs + 10 * MIN)) continue;
    out.push(await recalcularRondin(env, turnoId, slot, ctx, { ahora }));
  }
  return out;
}

export async function recalcularRondinesVentana(env, desdeMs, hastaMs, { ahora = Date.now(), sitioId, supervisorUid, soloActivos = true } = {}) {
  const turnos = (await runQuery(env, "turnos", [
    { campo: "inicioMs", op: "GREATER_THAN_OR_EQUAL", valor: desdeMs }, { campo: "inicioMs", op: "LESS_THAN", valor: hastaMs },
  ], { limite: 500 })).filter((t) => t.guardiaUid && t.estado === "programado" && (!sitioId || t.sitioId === sitioId) && (!supervisorUid || t.supervisorUid === supervisorUid));
  let n = 0;
  for (const t of turnos) {
    const { id, ...turno } = t;
    n += (await recalcularRondinesTurno(env, id, { ahora, turno, soloActivos })).length;
  }
  return n;
}
