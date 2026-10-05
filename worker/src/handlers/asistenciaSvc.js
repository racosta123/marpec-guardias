// Servicio de asistencia: reúne marcas, ajustes y autorizaciones de un turno, calcula el resultado
// (asistencias/{turnoId}) y lo guarda SOLO si cambió. Las marcas nunca se modifican.
import { calcularAsistencia, configEfectiva, horaEfectiva, fechaLocal, MIN } from "../asistencia.js";
import { commit, getDocument, runQuery } from "../google.js";
import { notificarUnaVez } from "../push.js";

const H = 3600 * 1000;
// Un turno "releva" a otro si es del mismo sitio y empieza entre 2 h antes y 4 h después del fin del primero.
const RELEVO_ANTES_MS = 2 * H;
const RELEVO_DESPUES_MS = 4 * H;

export async function cargarConfig(env) {
  return configEfectiva(await getDocument(env, "configuracion/empresa"));
}

export async function buscarSucesor(env, turno, turnoId) {
  const candidatos = (await runQuery(env, "turnos", [
    { campo: "sitioId", op: "EQUAL", valor: turno.sitioId },
    { campo: "inicioMs", op: "GREATER_THAN_OR_EQUAL", valor: turno.finMs - RELEVO_ANTES_MS },
    { campo: "inicioMs", op: "LESS_THAN", valor: turno.finMs + RELEVO_DESPUES_MS },
  ])).filter((t) => t.id !== turnoId && t.estado !== "cancelado" && t.inicioMs > turno.inicioMs)
    .sort((a, b) => a.inicioMs - b.inicioMs);
  const s = candidatos[0];
  if (!s) return { existe: false };
  const marca = await getDocument(env, `marcas/${s.id}_entrada`);
  const ajustes = await runQuery(env, "ajustesAsistencia", [{ campo: "turnoId", op: "EQUAL", valor: s.id }]);
  return { existe: true, turnoId: s.id, guardiaUid: s.guardiaUid ?? null, inicioMs: s.inicioMs, entradaMs: horaEfectiva(marca?.tsMs ?? null, ajustes, "entrada") };
}

// Turno saliente: el último del mismo sitio que termina entre 4 h antes y 2 h después del inicio de `turno`.
export async function buscarPredecesor(env, turno, turnoId) {
  const previos = (await runQuery(env, "turnos", [
    { campo: "sitioId", op: "EQUAL", valor: turno.sitioId },
    { campo: "inicioMs", op: "GREATER_THAN_OR_EQUAL", valor: turno.inicioMs - 40 * H },
    { campo: "inicioMs", op: "LESS_THAN", valor: turno.inicioMs },
  ])).filter((t) => t.id !== turnoId && t.estado !== "cancelado" && t.guardiaUid && t.finMs >= turno.inicioMs - 4 * H && t.finMs <= turno.inicioMs + 2 * H)
    .sort((a, b) => b.finMs - a.finMs);
  return previos[0] || null;
}

const sinVolatiles = ({ calculadoMs, ...r }) => r;
const igual = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());

// Recalcula y guarda asistencias/{turnoId}. Devuelve el resultado (o null si el turno no tiene guardia).
export async function recalcularTurno(env, turnoId, { ahora = Date.now(), config, turno } = {}) {
  turno = turno || (await getDocument(env, `turnos/${turnoId}`));
  if (!turno || !turno.guardiaUid) return null;
  config = config || (await cargarConfig(env));

  const [entrada, salida, ajustes, autorizaciones, guardia, previo] = await Promise.all([
    getDocument(env, `marcas/${turnoId}_entrada`),
    getDocument(env, `marcas/${turnoId}_salida`),
    runQuery(env, "ajustesAsistencia", [{ campo: "turnoId", op: "EQUAL", valor: turnoId }]),
    runQuery(env, "autorizaciones", [{ campo: "turnoId", op: "EQUAL", valor: turnoId }]),
    getDocument(env, `usuarios/${turno.guardiaUid}`),
    getDocument(env, `asistencias/${turnoId}`),
  ]);
  const sucesor = await buscarSucesor(env, turno, turnoId);

  const entradaMs = horaEfectiva(entrada?.tsMs ?? null, ajustes, "entrada");
  const salidaMs = horaEfectiva(salida?.tsMs ?? null, ajustes, "salida");
  const cierre = autorizaciones.find((a) => a.tipo === "cierre");
  const decisionExtra = autorizaciones.filter((a) => a.tipo === "extra").sort((x, y) => y.tsMs - x.tsMs)[0] || null;
  const r = calcularAsistencia({
    turno: { inicioMs: turno.inicioMs, finMs: turno.finMs, estado: turno.estado }, entradaMs, salidaMs, ahora, config, sucesor,
    cierreAutorizado: Boolean(cierre), decisionExtra: decisionExtra ? { estado: decisionExtra.decision, minutos: decisionExtra.minutos } : null,
  });

  const ult = [...ajustes].sort((a, b) => b.tsMs - a.tsMs)[0];
  const doc = {
    turnoId, sitioId: turno.sitioId, sitioNombre: turno.sitioNombre || "", supervisorUid: turno.supervisorUid ?? null,
    guardiaUid: turno.guardiaUid, guardiaNombre: guardia?.nombre || "", inicioMs: turno.inicioMs, finMs: turno.finMs,
    fecha: fechaLocal(turno.inicioMs), plantilla: turno.plantilla || "",
    estado: r.estado, entradaMs: r.entradaMs, salidaMs: r.salidaMs,
    retardo: r.retardo, retardoMin: r.retardoMin, falta: r.falta, motivoFalta: r.motivoFalta,
    minutosExtra: r.minutosExtra, extraEnCurso: r.extraEnCurso, extraEstado: r.extraEstado, salidaAnticipadaMin: r.salidaAnticipadaMin,
    relevoRequerido: r.relevoRequerido, relevoLlegado: r.relevoLlegado, relevoAlerta: r.relevoAlerta, cierreAutorizado: r.cierreAutorizado, puedeCerrar: r.puedeCerrar,
    sucesorTurnoId: sucesor.turnoId ?? null, sucesorGuardiaUid: sucesor.guardiaUid ?? null,
    ventanaEntradaDesdeMs: turno.inicioMs - config.ventanaEntradaMin * MIN,
    entradaDistanciaM: entrada?.distanciaM ?? null, entradaPrecisionM: entrada?.precisionM ?? null, fotoEntrada: Boolean(entrada?.fotoKey),
    salidaDistanciaM: salida?.distanciaM ?? null, salidaPrecisionM: salida?.precisionM ?? null, fotoSalida: Boolean(salida?.fotoKey),
    notasEntrega: salida?.notasEntrega ?? "",
    entradaSinConexion: entrada?.sin_conexion === true, salidaSinConexion: salida?.sin_conexion === true,
    entradaOriginalMs: entrada?.tsMs ?? null, salidaOriginalMs: salida?.tsMs ?? null, ajustes: ajustes.length, ultimoAjusteMotivo: ult?.motivo ?? null,
    extraResueltoPor: decisionExtra && r.extraEstado !== "pendiente" ? decisionExtra.autorNombre : null,
    extraMotivo: decisionExtra && r.extraEstado !== "pendiente" ? decisionExtra.motivo : null,
    cierreAutorizadoPor: cierre?.autorNombre ?? null, cierreMotivo: cierre?.motivo ?? null,
    ...(turno.prueba === true ? { prueba: true } : {}),
  };
  if (!previo || !igual(sinVolatiles(doc), sinVolatiles(Object.fromEntries(Object.entries(previo).filter(([k]) => k !== "calculadoMs" && k !== "calculadoEn"))))) {
    await commit(env, [{ path: `asistencias/${turnoId}`, data: { ...doc, calculadoMs: ahora }, serverTimeField: "calculadoEn" }]);
  }
  // Push al supervisor del sitio y al admin cuando el relevo no llega (una sola vez por turno; nunca por alertas viejas).
  if (doc.relevoAlerta === true && previo?.relevoAlerta !== true && ahora - turno.finMs < 6 * H)
    await notificarUnaVez(env, `relevo-${turnoId}`, { evento: "relevo", sitioId: turno.sitioId, prueba: turno.prueba === true });
  return { ...doc, calculadoMs: ahora };
}

// Recalcula todos los turnos con guardia cuyo inicio cae en [desdeMs, hastaMs).
export async function recalcularVentana(env, desdeMs, hastaMs, { sitioId, supervisorUid, omitirCerrados = false, ahora = Date.now() } = {}) {
  const config = await cargarConfig(env);
  const turnos = (await runQuery(env, "turnos", [
    { campo: "inicioMs", op: "GREATER_THAN_OR_EQUAL", valor: desdeMs },
    { campo: "inicioMs", op: "LESS_THAN", valor: hastaMs },
  ], { limite: 500 })).filter((t) => t.guardiaUid && t.estado === "programado" && (!sitioId || t.sitioId === sitioId) && (!supervisorUid || t.supervisorUid === supervisorUid));
  let n = 0;
  for (const t of turnos) {
    if (omitirCerrados) {
      const previo = await getDocument(env, `asistencias/${t.id}`);
      if (previo && previo.estado === "cumplido") continue;
    }
    const { id, ...turno } = t;
    await recalcularTurno(env, id, { ahora, config, turno });
    n++;
  }
  return n;
}
