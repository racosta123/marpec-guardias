// Revisión de registros capturados sin conexión (supervisor del sitio o admin): aceptar o ajustar con motivo.
// El registro original NO se toca. La decisión es un documento nuevo e inmutable (revisionesOffline) con autor y motivo;
// offlineVista (lo que lee el supervisor) refleja el estado. Ajustar una ENTRADA o SALIDA corrige además la hora efectiva
// de asistencia mediante un ajuste normal (ajustesAsistencia) para que el cálculo de retardos/extras use la hora buena.
import { auditoria, authenticate, id as vId, randomId, readJson, requireRol, str } from "../common.js";
import { HttpError, commit, getDocument, runQuery } from "../google.js";
import { horaEfectiva } from "../asistencia.js";
import { recalcularTurno } from "./asistenciaSvc.js";
import { sitioParaGestion, soloCampos } from "./turnoActivo.js";
import { bad } from "../common.js";

export async function revisarOffline(env, request) {
  const actor = await authenticate(env, request);
  requireRol(actor, "admin", "supervisor");
  const b = await readJson(request, 2048);
  soloCampos(b, ["registroId", "accion", "motivo", "horaAjustadaMs"]);
  const registroId = vId(b.registroId, "registroId");
  const v = await getDocument(env, `offlineVista/${registroId}`);
  if (!v) throw new HttpError(404, "not_found");
  await sitioParaGestion(env, actor, v.sitioId); // supervisor ACTUAL del sitio o admin
  if (v.estadoRevision !== "pendiente") throw new HttpError(409, "ya_revisado", `Este registro ya fue ${v.estadoRevision}.`);
  if (b.accion !== "aceptar" && b.accion !== "ajustar") throw bad("Acción: aceptar o ajustar.");
  const motivo = b.accion === "ajustar" ? str(b.motivo, "Motivo", 5, 300) : str(b.motivo, "Motivo", 0, 300, { opcional: true });
  let horaAjustadaMs = null;
  if (b.accion === "ajustar") {
    if (!Number.isSafeInteger(b.horaAjustadaMs) || b.horaAjustadaMs < v.tsMs - 24 * 3600e3 || b.horaAjustadaMs > v.recibidoMs + 60000) throw bad("Hora ajustada: debe estar dentro de las 24 h previas al registro y no ser futura.");
    horaAjustadaMs = b.horaAjustadaMs;
  }
  const ahora = Date.now();
  const escrituras = [
    {
      path: `revisionesOffline/${registroId}`,
      data: { registroId, tipo: v.tipo, sitioId: v.sitioId, accion: b.accion, motivo, horaOriginalMs: v.tsMs, horaAjustadaMs, autorUid: actor.uid, autorNombre: actor.perfil.nombre, tsMs: ahora, ...(v.prueba === true ? { prueba: true } : {}) },
      mustNotExist: true, serverTimeField: "ts",
    },
    auditoria(actor, `offline.${b.accion}`, registroId, { tipo: v.tipo, motivo, horaAjustadaMs }, v),
  ];
  // Entrada/salida: el ajuste de hora pasa a la asistencia como un ajuste normal (con el mismo motivo y autor).
  let turnoId = null;
  if (b.accion === "ajustar" && (v.tipo === "entrada" || v.tipo === "salida")) {
    turnoId = String(v.refPath).replace(/^marcas\//, "").replace(/_(entrada|salida)$/, "");
    const turno = await getDocument(env, `turnos/${turnoId}`);
    if (!turno) throw new HttpError(404, "not_found");
    const [entrada, salida, ajustes] = await Promise.all([getDocument(env, `marcas/${turnoId}_entrada`), getDocument(env, `marcas/${turnoId}_salida`), runQuery(env, "ajustesAsistencia", [{ campo: "turnoId", op: "EQUAL", valor: turnoId }])]);
    const e = v.tipo === "entrada" ? horaAjustadaMs : horaEfectiva(entrada?.tsMs ?? null, ajustes, "entrada");
    const s = v.tipo === "salida" ? horaAjustadaMs : horaEfectiva(salida?.tsMs ?? null, ajustes, "salida");
    if (e != null && s != null && s <= e) throw bad("La hora ajustada deja la salida antes de la entrada.");
    escrituras.push({
      path: `ajustesAsistencia/${Date.now().toString(36)}-${randomId(5)}`,
      data: { turnoId, sitioId: turno.sitioId, guardiaUid: turno.guardiaUid, supervisorUid: turno.supervisorUid ?? null, tipo: v.tipo, horaMs: horaAjustadaMs, motivo: `Registro sin conexión: ${motivo}`, horaOriginalMs: v.tsMs, autorUid: actor.uid, autorNombre: actor.perfil.nombre, tsMs: ahora, ...(turno.prueba === true ? { prueba: true } : {}) },
      mustNotExist: true, serverTimeField: "ts",
    });
  }
  try { await commit(env, escrituras); } catch (e) { if (e.status === 409) throw new HttpError(409, "ya_revisado", "Este registro ya fue revisado."); throw e; }
  await commit(env, [{ path: `offlineVista/${registroId}`, data: { estadoRevision: b.accion === "aceptar" ? "aceptado" : "ajustado", revisionAccion: b.accion, revisionMotivo: motivo, revisionPorNombre: actor.perfil.nombre, revisionMs: ahora, horaAjustadaMs }, merge: true, mustExist: true, serverTimeField: "actualizadoEn" }]);
  if (turnoId) await recalcularTurno(env, turnoId, { ahora });
  return { status: 200, body: { ok: true, estado: b.accion === "aceptar" ? "aceptado" : "ajustado" } };
}
