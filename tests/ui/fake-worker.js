// Intercepta fetch hacia el Worker y simula respuestas (solo para probar la interfaz).
import { generarTurnos, primerEmpalme } from "/worker/src/turnos.js";
import { store } from "./fake-firebase.js";

const real = window.fetch.bind(window);
window.__llamadas = [];
const ok = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const id = () => Math.random().toString(16).slice(2, 10);

window.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes("identitytoolkit.googleapis.com")) { window.__llamadas.push({ ruta: "sendOobCode" }); return ok({ email: "x" }); }
  if (!u.includes("workers.dev")) return real(url, init);
  const ruta = new URL(u).pathname;
  const body = init.body ? JSON.parse(init.body) : {};
  window.__llamadas.push({ ruta, body });
  if (ruta === "/sitios/qr") {
    const sid = new URL(u).searchParams.get("id");
    return ok({ payload: `MPC1.${sid}.1.AAAAAAAAAAAAAAAAAAAAAA`, version: 1, sitio: { id: sid, nombre: store.sitios[sid]?.nombre || "Sitio", direccion: store.sitios[sid]?.direccion || "" } });
  }
  if (ruta === "/marcas/entrada" || ruta === "/marcas/salida") return ok({ ok: true, retardo: false, retardoMin: 0, estado: "en_turno" }, 201);
  if (ruta === "/asistencia/recalcular") return ok({ ok: true, turnos: 0 });
  if (ruta === "/relevo/notas") return ok({ hay: true, de: "Gema Guardia", cerrado: true, notas: "Portón 2 con falla. Llaves en caseta.", turnoId: "t0" });
  if (ruta === "/selfies") return ok({ error: "simulado" }, 404);
  if (["/ajustes", "/extras/resolver", "/relevo/autorizar-cierre"].includes(ruta)) return ok({ ok: true, extraEstado: "autorizado" }, 201);
  if (ruta === "/reportes/asistencia") {
    const filas = Object.entries(store.asistencias).map(([id, a]) => ({ id, ...a }));
    return ok({ desde: "x", hasta: "y", filas, resumen: [{ guardiaUid: "g-G001", guardiaNombre: "Gael Guardia", turnos: 2, cumplidos: 1, retardos: 1, faltas: 0, minutosExtra: 95, faltasPorRetardos: 0, faltasTotales: 0 }],
      semanal: [{ guardiaUid: "g-G001", semana: "2026-09-28", pendienteMin: 595, autorizadoMin: 0, rechazadoMin: 0, horasConsideradas: 9.92, limiteHoras: 9, excedeLimite: true }], retardosPorFalta: 3 });
  }
  if (ruta === "/admin/usuarios") {
    const uid = body.rol === "guardia" ? `g-${body.numeroEmpleado.toUpperCase()}` : `s-${id()}`;
    if (store.usuarios[uid]) return ok({ error: "exists" }, 409);
    store.usuarios[uid] = { nombre: body.nombre, rol: body.rol, activo: true, numeroEmpleado: body.numeroEmpleado?.toUpperCase(), email: body.email, sitiosAsignados: [] };
    return ok({ ok: true, uid }, 201);
  }
  if (ruta === "/admin/usuarios/baja") { store.usuarios[body.uid].activo = false; return ok({ ok: true }); }
  if (ruta === "/admin/usuarios/reactivar") { store.usuarios[body.uid].activo = true; return ok({ ok: true }); }
  if (ruta === "/admin/usuarios/actualizar") { Object.assign(store.usuarios[body.uid], { ...(body.nombre && { nombre: body.nombre }), ...(body.email && { email: body.email }) }); return ok({ ok: true }); }
  if (ruta.startsWith("/admin/usuarios/")) return ok({ ok: true });
  if (ruta === "/admin/sitios") { const sid = id(); store.sitios[sid] = { ...body, qrVersion: 1, activo: true }; return ok({ ok: true, id: sid }, 201); }
  if (ruta === "/admin/sitios/actualizar") { const { id: sid, ...r } = body; Object.assign(store.sitios[sid], r); return ok({ ok: true }); }
  if (ruta === "/admin/sitios/regenerar-qr") { store.sitios[body.id].qrVersion++; return ok({ ok: true, version: store.sitios[body.id].qrVersion }); }
  if (ruta === "/admin/config") { store.configuracion.empresa = { ...body }; return ok({ ok: true }); }
  if (ruta === "/turnos/asignar-lote") {
    let nuevos;
    try { nuevos = generarTurnos(body); } catch (e) { return ok({ error: "bad_request", mensaje: e.detail }, 400); }
    if (body.guardiaUid) {
      const ex = Object.values(store.turnos).filter((x) => x.guardiaUid === body.guardiaUid && x.estado !== "cancelado");
      if (primerEmpalme(nuevos, ex)) return ok({ error: "empalme", mensaje: "Empalme de turnos con otro turno del guardia (simulado)." }, 409);
    }
    const s = store.sitios[body.sitioId];
    for (const n of nuevos) store.turnos[`n${id()}`] = { sitioId: body.sitioId, sitioNombre: s.nombre, supervisorUid: s.supervisorUid, guardiaUid: body.guardiaUid || null, ...n, plantilla: body.plantilla, estado: "programado" };
    return ok({ ok: true, creados: nuevos.length }, 201);
  }
  if (ruta === "/turnos/asignar") { store.turnos[body.turnoId].guardiaUid = body.guardiaUid; return ok({ ok: true }); }
  if (ruta === "/turnos/cancelar") { store.turnos[body.turnoId].estado = "cancelado"; return ok({ ok: true }); }
  return ok({ error: "not_found" }, 404);
};
