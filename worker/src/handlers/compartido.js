// Operaciones compartidas entre handlers.
import { commit, getDocument, runQuery } from "../google.js";

// Cambia el supervisor de un sitio en todos sus turnos (el campo está denormalizado para las reglas).
export async function reasignarSupervisor(env, sitioId, supervisorUid) {
  const turnos = await runQuery(env, "turnos", [{ campo: "sitioId", op: "EQUAL", valor: sitioId }]);
  for (let i = 0; i < turnos.length; i += 400)
    await commit(env, turnos.slice(i, i + 400).map((t) => ({ path: `turnos/${t.id}`, data: { supervisorUid }, merge: true })));
  await commit(env, [{ path: `sitios/${sitioId}`, data: { supervisorUid }, merge: true }]);
  // Fase 4: puntos y programa de rondín (denormalizan el supervisor para las reglas)
  const puntos = await runQuery(env, "puntos", [{ campo: "sitioId", op: "EQUAL", valor: sitioId }]);
  for (let i = 0; i < puntos.length; i += 400)
    await commit(env, puntos.slice(i, i + 400).map((p) => ({ path: `puntos/${p.id}`, data: { supervisorUid }, merge: true })));
  if (await getDocument(env, `programasRondin/${sitioId}`)) await commit(env, [{ path: `programasRondin/${sitioId}`, data: { supervisorUid }, merge: true }]);
  // Fase 6: lo PENDIENTE pasa al supervisor nuevo (alertas de pánico activas y registros sin conexión por revisar);
  // lo ya resuelto queda con quien lo atendió.
  const pendientes = [
    ...(await runQuery(env, "panicoVista", [{ campo: "sitioId", op: "EQUAL", valor: sitioId }, { campo: "estado", op: "EQUAL", valor: "activa" }])).map((p) => `panicoVista/${p.id}`),
    ...(await runQuery(env, "offlineVista", [{ campo: "sitioId", op: "EQUAL", valor: sitioId }, { campo: "estadoRevision", op: "EQUAL", valor: "pendiente" }])).map((p) => `offlineVista/${p.id}`),
  ];
  for (let i = 0; i < pendientes.length; i += 400)
    await commit(env, pendientes.slice(i, i + 400).map((path) => ({ path, data: { supervisorUid }, merge: true, mustExist: true })));
}

// Sitios que un guardia puede leer = sitios de sus turnos vigentes o futuros (no cancelados).
// Se guarda en su perfil y las reglas de Firestore lo usan para autorizar la lectura del sitio.
export async function recalcularSitiosAsignados(env, guardiaUid, { ahora = Date.now(), turnos } = {}) {
  const todos = turnos || (await runQuery(env, "turnos", [{ campo: "guardiaUid", op: "EQUAL", valor: guardiaUid }]));
  const sitios = [...new Set(todos.filter((t) => t.estado !== "cancelado" && t.finMs > ahora).map((t) => t.sitioId))].slice(0, 100);
  await commit(env, [{ path: `usuarios/${guardiaUid}`, data: { sitiosAsignados: sitios }, merge: true, mustExist: true }]);
  return sitios;
}
