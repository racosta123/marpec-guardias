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
  // ---- Fase 5 simulada ----
  if (ruta === "/catalogo/incidencias") return ok({ tipos: [["acceso_no_autorizado", "Acceso no autorizado"], ["robo", "Robo"], ["danio", "Daño"], ["falla_electrica", "Falla eléctrica"], ["falla_equipo", "Falla de equipo"], ["persona_sospechosa", "Persona sospechosa"], ["otro", "Otro"]].map(([id, nombre]) => ({ id, nombre, activo: true })), gravedades: ["baja", "media", "alta"] });
  if (ruta === "/incidencias") return ok({ ok: true, id: "inc-nueva", gravedad: body.gravedad, nFotos: (body.fotos || []).length }, 201);
  if (ruta === "/novedades") return ok({ ok: true, id: "nov-1", tsMs: Date.now() }, 201);
  if (ruta === "/visitantes/dentro") return ok({ sitioId: "siteA", dentro: [{ id: "v1", nombre: "Luis Pérez", visitaA: "Casa 12", motivo: "visita", empresa: "", placas: "ABC-123", entradaMs: Date.now() - 3600e3, guardiaNombre: "Gael Guardia" }] });
  if (ruta === "/visitantes/entrada" || ruta === "/visitantes/salida") return ok({ ok: true, id: "v-nuevo" }, 201);
  if (ruta === "/incidencias/seguimiento") return ok({ ok: true, estado: body.estadoNuevo || "abierta" }, 201);
  if (ruta === "/incidencias/foto" || ruta === "/visitantes/foto") return ok({ error: "simulado" }, 404);
  if (ruta === "/admin/catalogo-incidencias") return ok({ ok: true, tipos: body.tipos });
  if (ruta === "/bitacora/turno") return ok({ turnoId: "t5", sitioNombre: "Plaza Norte", guardiaNombre: "Gael Guardia", inicioMs: Date.now() - 3600e3, finMs: Date.now() + 3 * 3600e3, cerrado: false, notasEntrega: null,
    items: [{ tsMs: Date.now() - 3000e3, tipo: "entrada", titulo: "Entrada al turno", detalle: "" }, { tsMs: Date.now() - 2400e3, tipo: "novedad", titulo: "Novedad", detalle: "Se cambió la bombilla del pasillo." }, { tsMs: Date.now() - 1800e3, tipo: "visitante_entrada", titulo: "Entra visitante: Luis Pérez", detalle: "Visita a Casa 12 · visita" }, { tsMs: Date.now() - 1200e3, tipo: "incidencia", titulo: "Incidencia (alta): Robo", detalle: "Candado forzado", gravedad: "alta" }], visitantesDentro: [{ id: "v1", nombre: "Luis Pérez", entradaMs: Date.now() - 1800e3 }] });
  if (ruta === "/bitacora/anterior") return ok({ hay: true, bitacora: { sitioNombre: "Plaza Norte", guardiaNombre: "Gema Guardia", inicioMs: Date.now() - 13 * 3600e3, finMs: Date.now() - 1 * 3600e3, items: [{ tsMs: Date.now() - 5 * 3600e3, tipo: "novedad", titulo: "Novedad", detalle: "Portón 2 con falla." }, { tsMs: Date.now() - 3600e3, tipo: "salida", titulo: "Salida del turno", detalle: "Notas de entrega: llaves en caseta." }], visitantesDentro: [{ id: "v9", nombre: "Pedro Sigue Dentro", entradaMs: Date.now() - 4 * 3600e3 }] } });
  // ---- Fase 4 simulada ----
  if (ruta === "/rondines/recalcular") return ok({ ok: true, rondines: 0 });
  if (ruta === "/rondines/proximo") {
    const ordenada = true;
    const pts = [["p1", "Portón", 1, true], ["p2", "Bodega", 2, false], ["p3", "Azotea", 3, false]].map(([puntoId, nombre, orden, requiereGps]) => ({ puntoId, nombre, orden, descripcion: "", requiereGps, hecho: Boolean(window.__hechos?.[puntoId]), tsMs: window.__hechos?.[puntoId] || null }));
    const hechos = pts.filter((x) => x.hecho).length;
    const sig = ordenada ? pts.find((x) => !x.hecho)?.puntoId || null : null;
    const ahoraMs = Date.now();
    return ok({ hay: true, modo: "ordenada", proximoMs: ahoraMs + 2 * 3600e3,
      rondines: [{ indice: 0, programadoMs: ahoraMs - 20 * 60e3, estado: hechos === 3 ? "completo" : hechos ? "en_curso" : "pendiente", hechos, total: 3 }, { indice: 1, programadoMs: ahoraMs + 2 * 3600e3, estado: "programado", hechos: 0, total: 3 }],
      actual: hechos === 3 ? null : { indice: 0, programadoMs: ahoraMs - 20 * 60e3, venceMs: ahoraMs + 25 * 60e3, estado: hechos ? "en_curso" : "pendiente", hechos, total: 3, porcentaje: Math.round(hechos / 3 * 100), modo: "ordenada", siguientePuntoId: sig, puntos: pts } });
  }
  if (ruta === "/rondines/escanear") {
    const pid = body.qr.split(".")[1];
    window.__hechos = window.__hechos || {};
    window.__hechos[pid] = Date.now();
    const n = Object.keys(window.__hechos).length;
    const nombres = { p1: "Portón", p2: "Bodega", p3: "Azotea" };
    const sig = ["p1", "p2", "p3"].find((x) => !window.__hechos[x]);
    return ok({ ok: true, tsMs: Date.now(), punto: nombres[pid], hechos: n, total: 3, estado: n === 3 ? "completo" : "en_curso", completo: n === 3, siguiente: sig ? nombres[sig] : null }, 201);
  }
  if (ruta === "/rondines/ajuste") return ok({ ok: true, estado: "completo" }, 201);
  if (ruta === "/rondines/foto") return ok({ error: "simulado" }, 404);
  if (ruta === "/rondines/programa") return ok({ ok: true });
  if (ruta === "/admin/puntos" || ruta === "/admin/puntos/actualizar" || ruta === "/admin/puntos/regenerar-qr") return ok({ ok: true, id: "pNuevo", version: 2 }, 201);
  if (ruta === "/puntos/qr-sitio") return ok({ sitio: { id: "siteA", nombre: "Plaza Norte" }, puntos: [{ id: "p1", nombre: "Portón", descripcion: "Entrada principal", orden: 1, version: 1, payload: "MPC2.p1.1.AAAAAAAAAAAAAAAAAAAAAA" }, { id: "p2", nombre: "Bodega", descripcion: "", orden: 2, version: 1, payload: "MPC2.p2.1.BBBBBBBBBBBBBBBBBBBBBB" }] });
  if (ruta === "/reportes/rondines") return ok({ desde: "x", hasta: "y", filas: Object.entries(store.rondines).map(([id, r]) => ({ id, ...r })), porSitioDia: [], total: { exigibles: 3, completos: 1, porcentaje: 33.3 } });
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
