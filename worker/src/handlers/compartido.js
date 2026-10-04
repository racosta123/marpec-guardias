// Operaciones compartidas entre handlers.
import { commit, runQuery } from "../google.js";

// Cambia el supervisor de un sitio en todos sus turnos (el campo está denormalizado para las reglas).
export async function reasignarSupervisor(env, sitioId, supervisorUid) {
  const turnos = await runQuery(env, "turnos", [{ campo: "sitioId", op: "EQUAL", valor: sitioId }]);
  for (let i = 0; i < turnos.length; i += 400)
    await commit(env, turnos.slice(i, i + 400).map((t) => ({ path: `turnos/${t.id}`, data: { supervisorUid }, merge: true })));
  await commit(env, [{ path: `sitios/${sitioId}`, data: { supervisorUid }, merge: true }]);
}

// Sitios que un guardia puede leer = sitios de sus turnos vigentes o futuros (no cancelados).
// Se guarda en su perfil y las reglas de Firestore lo usan para autorizar la lectura del sitio.
export async function recalcularSitiosAsignados(env, guardiaUid, { ahora = Date.now(), turnos } = {}) {
  const todos = turnos || (await runQuery(env, "turnos", [{ campo: "guardiaUid", op: "EQUAL", valor: guardiaUid }]));
  const sitios = [...new Set(todos.filter((t) => t.estado !== "cancelado" && t.finMs > ahora).map((t) => t.sitioId))].slice(0, 100);
  await commit(env, [{ path: `usuarios/${guardiaUid}`, data: { sitiosAsignados: sitios }, merge: true, mustExist: true }]);
  return sitios;
}
