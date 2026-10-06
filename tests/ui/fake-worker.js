// Intercepta fetch hacia el Worker y simula respuestas (solo para probar la interfaz).
import { generarTurnos, primerEmpalme } from "/worker/src/turnos.js";
import { store } from "./fake-firebase.js";

const real = window.fetch.bind(window);
window.__llamadas = [];
// Conexión simulada: con __setOffline(true) las llamadas al Worker fallan como una red caída y navigator.onLine = false.
window.__offline = new URLSearchParams(location.search).get("offline") === "1"; // ?offline=1: la app se abre sin conexión
window.__skew = 0; // diferencia simulada (servidor − celular) para probar la hora estimada
Object.defineProperty(navigator, "onLine", { get: () => !window.__offline, configurable: true });
window.__setOffline = (v) => { window.__offline = v; window.dispatchEvent(new Event(v ? "offline" : "online")); };
const ok = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "x-server-time": String(Date.now() + window.__skew) } });
const id = () => Math.random().toString(16).slice(2, 10);

window.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.includes("identitytoolkit.googleapis.com")) { window.__llamadas.push({ ruta: "sendOobCode" }); return ok({ email: "x" }); }
  if (!u.includes("workers.dev")) return real(url, init);
  const ruta = new URL(u).pathname;
  const body = init.body ? JSON.parse(init.body) : {};
  if (window.__offline) { window.__fallidas = (window.__fallidas || 0) + 1; throw new TypeError("Failed to fetch"); }
  window.__llamadas.push({ ruta, body });
  // Licencia de demostración simulada con ?lic=d5 (demo, quedan 5 días) · ?lic=d30 · ?lic=vencida; sin ?lic= es modo producción.
  const lic = new URLSearchParams(location.search).get("lic");
  const estadoLic = !lic ? { modo: "produccion", vencido: false } : lic === "vencida" ? { modo: "demo", vencido: true, diasRestantes: 0 } : { modo: "demo", vencido: false, diasRestantes: Number(lic.slice(1)), venceDia: "2026-11-04" };
  if (ruta === "/licencia/estado") return ok(estadoLic);
  if (estadoLic.vencido) return ok({ error: "demo_vencido", mensaje: "Periodo de demostración concluido. Para continuar usando MARPEC Guardias, contacta a Diagonal Catorce." }, 403);
  // Fase 6: rechazo simulado de un registro (para probar los «rechazados» de la cola)
  if (window.__rechazar && window.__rechazar.includes(ruta)) return ok({ error: "qr_invalido", mensaje: "El código QR no es válido para este puesto." }, 400);
  if (window.__duplicados && body.sync?.clientId) { window.__vistos = window.__vistos || new Set(); if (window.__vistos.has(body.sync.clientId)) return ok({ ok: true, duplicado: true }); window.__vistos.add(body.sync.clientId); }
  if (ruta === "/panico") { store.panicoVista = store.panicoVista || {}; const id = "p-" + Math.random().toString(16).slice(2, 8); store.panicoVista[id] = { panicoId: id, sitioId: "siteA", sitioNombre: "Plaza Norte", supervisorUid: "sup1", guardiaUid: "g-G001", guardiaNombre: "Gael Guardia", estado: "activa", tsMs: Date.now(), recibidoMs: Date.now(), lat: body.lat ?? null, lng: body.lng ?? null, precisionM: body.precisionM ?? null, sin_conexion: body.sync?.offline === true }; window.__tick?.(); return ok({ ok: true, id, avisados: 1 }, 201); }
  if (ruta === "/panico/atender") { const p = store.panicoVista?.[body.id]; if (!p) return ok({ error: "not_found" }, 404); if (p.estado === "atendida") return ok({ error: "ya_atendida", mensaje: "Ya la atendió alguien más." }, 409); Object.assign(p, { estado: "atendida", atendidaPorNombre: "Sara Supervisora", atendidaPorRol: "supervisor", atendidaMs: Date.now(), notaAtencion: body.nota || "" }); window.__tick?.(); return ok({ ok: true }); }
  if (ruta === "/offline/revisar") { const r = store.offlineVista?.[body.registroId]; if (r) Object.assign(r, { estadoRevision: body.accion === "aceptar" ? "aceptado" : "ajustado", revisionPorNombre: "Sara Supervisora", revisionMotivo: body.motivo || "", horaAjustadaMs: body.horaAjustadaMs || null }); return ok({ ok: true }); }
  if (ruta === "/push/clave") return ok({ publicKey: "BEl62iUYgUivxIkv69yViEuiBIa-Ib9-SkvMeAtA3LFgDzkrxZJjSgSnfckjBJuBkr3qBUYIHBQFLXYp5Nksh8U" });
  if (ruta === "/push/estado") return ok({ configurado: true, suscrito: false, prefs: null });
  if (ruta === "/push/prefs") return ok({ ok: true, prefs: body.prefs });
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
      rondines: [{ indice: 0, programadoMs: ahoraMs - 20 * 60e3, abreMs: ahoraMs - 35 * 60e3, cierraInicioMs: ahoraMs + 10 * 60e3, venceMs: ahoraMs + 25 * 60e3, estado: hechos === 3 ? "completo" : hechos ? "en_curso" : "pendiente", hechos, total: 3 }, { indice: 1, programadoMs: ahoraMs + 2 * 3600e3, abreMs: ahoraMs + 105 * 60e3, cierraInicioMs: ahoraMs + 135 * 60e3, venceMs: ahoraMs + 165 * 60e3, estado: "programado", hechos: 0, total: 3 }],
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
