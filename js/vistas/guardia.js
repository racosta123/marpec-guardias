// Inicio del guardia: estado de su turno, botón grande de entrada/salida, consignas y notas del relevo.
import { collection, doc, getDoc, getDocs, orderBy, query, where } from "../vendor/firebase.js";
import { h, limpiar, poner } from "../ui.js";
import { diaLargo, duracionH, hora } from "../tz.js";
import { abrirMarcado } from "./marcar.js";
import { abrirRondin } from "./rondin.js";
import { listar, metaGet, metaSet, ahoraEstimado } from "../cola.js";
import { rondinConRespaldo } from "../rondin-local.js";
import { abrirBitacora, abrirIncidencia, abrirNovedad, abrirVisitantes } from "./libro.js";
import { icono } from "../iconos.js";

const H = 3600e3;

let turnoActual = null; // turno vigente del guardia (lo usa el botón de pánico para ubicar el sitio)
export const turnoVigenteId = () => turnoActual;

const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
const CAMPOS_T = ["sitioId", "sitioNombre", "inicioMs", "finMs", "estado", "plantilla"];
const CAMPOS_A = ["estado", "entradaMs", "salidaMs", "retardo", "retardoMin", "falta", "minutosExtra", "extraEstado", "relevoAlerta", "relevoRequerido", "relevoLlegado", "cierreAutorizado", "ventanaEntradaDesdeMs"];
const CAMPOS_S = ["nombre", "direccion", "consignas", "lat", "lng", "radioM", "telefonoEmergencia"];
const conTiempo = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("tiempo agotado")), ms))]);

// 8 h 36 min / 45 min (solo se deriva de los horarios del turno y de la hora actual; no pide nada nuevo)
const dur = (ms) => { const m = Math.max(0, Math.round(ms / 60000)); return m >= 60 ? `${Math.floor(m / 60)} h${m % 60 ? ` ${m % 60} min` : ""}` : `${m} min`; };

// Turno vigente, siguientes turnos y sitio, leídos de Firestore (reglas: solo lo del propio guardia).
async function cargarEnLinea({ db, user }) {
  const ahora = Date.now();
  const snap = await getDocs(query(collection(db, "turnos"),
    where("guardiaUid", "==", user.uid), where("inicioMs", ">=", ahora - 48 * H), orderBy("inicioMs")));
  const candidatos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.estado === "programado");
  // Estado de asistencia de cada turno (lo calcula el Worker; puede no existir aún)
  const conEstado = [];
  for (const t of candidatos) {
    let a = null;
    try { const s = await getDoc(doc(db, "asistencias", t.id)); if (s.exists()) a = s.data(); } catch (e) { if (e.code !== "permission-denied") throw e; /* sin acceso: se omite; cualquier otro error (red) cae a la copia local */ }
    conEstado.push({ t: { id: t.id, ...pick(t, CAMPOS_T) }, a: a ? pick(a, CAMPOS_A) : null });
  }
  // Turno vigente: no cumplido y (aún no termina, o terminó pero sigue sin cerrar tras haber entrado)
  const vigente = conEstado.find(({ t, a }) => a?.estado !== "cumplido" && a?.estado !== "falta" && (t.finMs > ahora || (a?.entradaMs && !a?.salidaMs))) || null;
  const siguientes = conEstado.filter(({ t }) => t.inicioMs > ahora && t.id !== vigente?.t.id).slice(0, 6).map(({ t }) => ({ t }));
  let sitio = null;
  if (vigente) { try { const s = await getDoc(doc(db, "sitios", vigente.t.sitioId)); if (s.exists()) sitio = pick(s.data(), CAMPOS_S); } catch (e) { if (e.code !== "permission-denied") throw e; /* sin acceso: se omite; cualquier otro error (red) cae a la copia local */ } }
  return { vigente, siguientes, sitio };
}

// Acceso grande de color del libro del turno (el texto es el de siempre; el dato va debajo cuando existe).
function acceso(clase, ico, titulo, sub, onclick, extra = {}) {
  return h("button", { class: `libro-btn acceso ${clase}`, type: "button", onclick, ...extra },
    h("span", { class: "ico-caja" }, icono(ico, { tam: 24 })),
    h("span", { class: "a-txt" }, h("span", { class: "a-t" }, titulo), sub ? h("span", { class: "a-s" }, sub) : null),
    icono("derecha", { tam: 18, clase: "der" }));
}

export async function vistaGuardia(raiz, ctx) {
  const { db, api, user } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando tu turno…"));
  const ahora = Date.now();
  // En línea: Firestore (y se guarda copia en el celular). Sin conexión: la última copia + lo capturado y aún no enviado.
  let datos, desdeCopia = false;
  try {
    if (navigator.onLine === false) throw new Error("sin conexión");
    datos = await conTiempo(cargarEnLinea(ctx), 12000);
    metaSet("ctxGuardia", { uid: user.uid, ...datos, guardadoMs: Date.now() });
    metaSet("contactoEmergencia", { telefono: datos.sitio?.telefonoEmergencia || "", sitioNombre: datos.vigente?.t.sitioNombre || "" });
  } catch (e) {
    const c = await metaGet("ctxGuardia");
    if (!c || c.uid !== user.uid) throw e;
    datos = c; desdeCopia = true;
  }
  const { vigente, siguientes, sitio } = datos;
  turnoActual = vigente?.t.id ?? null;
  // Registros capturados sin conexión que aún no llegan al servidor: se reflejan aquí como pendientes.
  const cola = (await listar()).filter((x) => x.uid === user.uid && x.estado === "pendiente" && vigente && x.turnoId === vigente.t.id);
  const pend = { entrada: cola.find((x) => x.tipo === "entrada"), salida: cola.find((x) => x.tipo === "salida") };

  limpiar(raiz);
  const perfil = (etiqueta, clase) => h("div", { class: "g-perfil" },
    h("span", { class: "g-avatar" }, icono("usuario", { tam: 30 })),
    h("div", { class: "g-quien" }, h("span", { class: "g-nombre" }, user.nombre || "Guardia"), h("span", { class: "g-rol" }, `Guardia${user.numero ? ` · No. ${user.numero}` : ""}`)),
    etiqueta ? h("span", { class: `g-estado ${clase || ""}`.trim() }, etiqueta) : null);
  const home = h("div", { class: "g-home" });
  poner(raiz, home);
  if (desdeCopia) poner(home, h("p", { class: "alerta" }, "Sin conexión: se muestra tu último turno guardado en este celular. Puedes marcar y reportar; todo se enviará solo al volver la señal."));
  if (!vigente) {
    poner(home, perfil(null), h("p", { class: "vacio" }, "No tienes turnos asignados por ahora."), listaSiguientes(siguientes));
    return;
  }

  const { t } = vigente;
  const a = { ...(vigente.a || {}) };
  if (pend.entrada && !a.entradaMs) Object.assign(a, { entradaMs: pend.entrada.horaEstimadaMs, falta: false, entradaPendiente: true });
  if (pend.salida && !a.salidaMs) Object.assign(a, { salidaMs: pend.salida.horaEstimadaMs, salidaPendiente: true });
  const recargar = (marca) => { void marca; return vistaGuardia(raiz, ctx); };

  const entradaMs = a?.entradaMs ?? null;
  const salidaMs = a?.salidaMs ?? null;
  const ventanaDesde = a?.ventanaEntradaDesdeMs ?? t.inicioMs - 30 * 60000;
  let etiqueta, clase, accion = null, ayuda = null;
  if (salidaMs) { etiqueta = a.salidaPendiente ? "Turno cerrado (salida pendiente de enviar)" : "Turno cerrado"; clase = a.salidaPendiente ? "info" : "ok"; }
  else if (entradaMs) {
    const pendiente = a?.relevoAlerta;
    etiqueta = pendiente ? "Salida pendiente de relevo" : ahora > t.finMs ? "Salida pendiente" : a.entradaPendiente ? "En turno (entrada pendiente de enviar)" : "En turno";
    clase = pendiente ? "mal" : "ok";
    accion = "salida";
    if (a?.relevoRequerido && !a?.relevoLlegado && !a?.cierreAutorizado)
      ayuda = "Tu relevo aún no marca entrada. No podrás cerrar tu turno hasta que llegue, o hasta que tu supervisor lo autorice.";
  } else if (ahora >= ventanaDesde) { etiqueta = a?.falta ? "Entrada tardía (falta)" : "Sin marcar"; clase = a?.falta ? "mal" : "info"; accion = "entrada"; }
  else { etiqueta = "Próximo turno"; clase = "info"; ayuda = `Podrás marcar tu entrada desde las ${hora(ventanaDesde)}.`; }

  const boton = accion ? h("button", { class: `btn primario grande g-accion ${accion === "salida" ? "salida" : ""}`, type: "button",
    onclick: () => abrirMarcado({ tipo: accion, turno: t, sitio, api, alTerminar: recargar }) },
  icono(accion === "entrada" ? "entrada" : "salida", { tam: 36 }),
  h("span", { class: "g-accion-txt" },
    h("span", { class: "g-accion-t" }, accion === "entrada" ? "MARCAR ENTRADA" : "MARCAR SALIDA"),
    entradaMs ? h("span", { class: "g-accion-s" }, `Entrada ${hora(entradaMs)} `, icono("check", { tam: 16 })) : null)) : null;

  // Avance del turno y tiempo restante: solo se calculan con el horario del turno y la hora actual.
  const total = t.finMs - t.inicioMs;
  let avance = null;
  if (!salidaMs && total > 0) {
    if (ahora < t.inicioMs) avance = h("div", { class: "g-avance" }, h("div", { class: "g-avance-fila" }, h("span", {}, "El turno inicia en"), h("b", {}, dur(t.inicioMs - ahora))));
    else {
      const pct = Math.min(100, Math.max(0, Math.round(((ahora - t.inicioMs) / total) * 100)));
      const relleno = h("span", {});
      relleno.style.width = `${pct}%`; // por CSSOM: la política de seguridad no permite el atributo style
      avance = h("div", { class: "g-avance" },
        h("div", { class: "g-avance-fila" }, h("span", {}, "Avance del turno"), h("b", {}, `${pct}%`)),
        h("div", { class: "g-barra", role: "progressbar", "aria-valuemin": 0, "aria-valuemax": 100, "aria-valuenow": pct, "aria-label": "Avance del turno" }, relleno),
        h("div", { class: "g-avance-fila" }, h("span", { class: "g-etiqueta" }, icono("reloj", { tam: 16 }), "Tiempo restante"), h("b", {}, ahora < t.finMs ? dur(t.finMs - ahora) : "Turno terminado")));
    }
  }

  const consignas = sitio?.consignas;
  poner(home,
    perfil(etiqueta, clase),
    h("section", { class: "g-turno turno-grande" },
      h("div", { class: "g-turno-fila" },
        h("div", { class: "g-turno-col" },
          h("span", { class: "g-etiqueta" }, icono("reloj", { tam: 16 }), "Turno actual"),
          h("p", { class: "g-valor hora-grande" }, `${hora(t.inicioMs)} – ${hora(t.finMs)}`),
          h("span", { class: "g-sitio-sub" }, `${diaLargo(t.inicioMs)} (${duracionH(t.inicioMs, t.finMs)})`)),
        h("div", { class: "g-turno-col" },
          h("span", { class: "g-etiqueta" }, icono("ubicacion", { tam: 16 }), "Sitio"),
          h("p", { class: "g-sitio" }, t.sitioNombre, sitio?.direccion ? h("span", { class: "g-sitio-sub" }, sitio.direccion) : null))),
      avance,
      entradaMs ? h("p", { class: "g-extra" }, `Entrada: ${hora(entradaMs)}${a?.retardo ? ` · retardo de ${a.retardoMin} min` : ""}${salidaMs ? ` · Salida: ${hora(salidaMs)}` : ""}`) : null,
      a?.minutosExtra > 0 ? h("p", { class: "g-extra" }, `Tiempo extra: ${a.minutosExtra} min (${a.extraEstado === "autorizado" ? "autorizado" : a.extraEstado === "rechazado" ? "rechazado" : "pendiente de autorización"})`) : null,
      ayuda ? h("p", { class: "ayuda-relevo" }, ayuda) : null,
      h("div", { class: "consignas-caja" }, h("h4", {}, "Consignas del puesto"), h("p", {}, consignas || "Sin consignas registradas."))),
    boton,
    h("div", { id: "libro-card" }),
    h("div", { id: "rondines-card" }),
    h("div", { id: "notas-relevo" }),
    listaSiguientes(siguientes),
    h("p", { class: "ayuda" }, "Horario de Hermosillo (UTC-7, sin horario de verano). Para marcar se usa tu ubicación solo en ese momento."));

  // Libro del turno: novedades, incidencias, visitantes y bitácora (solo con entrada marcada y turno abierto)
  let accesos = null;
  if (entradaMs && !salidaMs) {
    const dest = raiz.querySelector("#libro-card");
    const ctxLibro = { turno: t, api, alTerminar: recargar };
    const tileVis = acceso("a-visitantes", "visitantes", "Visitantes", null, () => abrirVisitantes(ctxLibro));
    accesos = h("div", { class: "g-accesos" },
      acceso("a-incidencia", "incidencias", "Reportar incidencia", null, () => abrirIncidencia(ctxLibro)),
      tileVis,
      acceso("a-bitacora", "libro", "Bitácora", null, () => abrirBitacora({ turno: t, api })),
      acceso("a-novedad", "novedad", "Novedad", "Anotar algo del turno", () => abrirNovedad(ctxLibro)));
    poner(dest, h("section", { class: "g-libro" }, h("h4", { class: "g-titulo" }, "Libro del turno"), accesos));
    api(`/visitantes/dentro?turnoId=${encodeURIComponent(t.id)}`, { method: "GET" }).then((v) => {
      const sub = h("span", { class: "a-s" }, v.dentro.length ? `${v.dentro.length} dentro ahora` : "Ninguno dentro");
      tileVis.querySelector(".a-txt").append(sub);
    }).catch(() => {});
    api(`/bitacora/anterior?turnoId=${encodeURIComponent(t.id)}`, { method: "GET" }).then((a) => {
      if (!a.hay || !a.bitacora.visitantesDentro?.length) return;
      poner(dest, h("p", { class: "alerta" }, `Del turno anterior siguen dentro: ${a.bitacora.visitantesDentro.map((x) => x.nombre).join(", ")}.`));
    }).catch(() => {});
  }

  // Rondines (solo con entrada marcada y turno abierto)
  if (entradaMs && !salidaMs) {
    try {
      const { r, sinRed } = await rondinConRespaldo(api, t.id, { listar, metaGet, metaSet, ahoraEstimado });
      const dest = raiz.querySelector("#rondines-card");
      if (r.hay && dest) {
        const ESTADO = { completo: ["✔ Completo", "ok"], incompleto: ["Incompleto", "mal"], no_iniciado: ["No iniciado", "mal"], en_curso: ["En curso", "info"], pendiente: ["Por iniciar", "info"], programado: ["Programado", "info"], justificado: ["Justificado", "info"], no_exigible: ["—", "info"] };
        const a = r.actual;
        poner(dest, h("section", { class: "tarjeta" }, h("h4", { class: "titulo-seccion" }, sinRed ? "Rondines (sin conexión)" : "Rondines"),
          a ? [h("p", {}, h("b", {}, `Rondín de las ${hora(a.programadoMs)}`), ` · ${a.hechos} de ${a.total} puntos · plazo ${hora(a.venceMs)}`),
            h("progress", { class: "progreso", max: a.total, value: a.hechos, "aria-label": "Progreso del rondín" }),
            h("button", { class: "btn primario grande", type: "button", onclick: () => abrirRondin({ turno: t, api, alTerminar: recargar }) }, a.hechos > 0 ? "CONTINUAR RONDÍN" : "INICIAR RONDÍN")]
            : h("p", { class: "sub" }, r.proximoMs ? `No hay un rondín en este momento. Próximo: ${hora(r.proximoMs)}.` : "No hay más rondines programados en tu turno."),
          h("div", { class: "chips-rondin" }, r.rondines.map((x) => { const [txt, c] = ESTADO[x.estado] || [x.estado, "info"]; return h("span", { class: `etq ${c}` }, `${hora(x.programadoMs)} · ${txt}`); }))));
        // Acceso grande de «Rondín» (mismo flujo que el botón de la tarjeta): próximo rondín o avance de puntos
        if (accesos) {
          const sub = a ? `En curso · ${a.hechos}/${a.total} puntos` : r.proximoMs ? `Próximo: ${hora(r.proximoMs)}` : "Sin más rondines";
          accesos.prepend(h("button", { class: "acceso a-rondin", type: "button", onclick: () => (a ? abrirRondin({ turno: t, api, alTerminar: recargar }) : dest.scrollIntoView?.({ block: "center" })) },
            h("span", { class: "ico-caja" }, icono("rondin", { tam: 24 })),
            h("span", { class: "a-txt" }, h("span", { class: "a-t" }, "Rondín"), h("span", { class: "a-s" }, sub)),
            icono("derecha", { tam: 18, clase: "der" })));
        }
      }
    } catch { /* sin conexión o sin programa */ }
  }

  // Notas de entrega de quien me releva (si las hay)
  if (!salidaMs) {
    try {
      const n = await api(`/relevo/notas?turnoId=${encodeURIComponent(t.id)}`, { method: "GET" });
      const dest = raiz.querySelector("#notas-relevo");
      if (n.hay && dest) {
        poner(dest, h("section", { class: "tarjeta notas-relevo" },
          h("h4", {}, `Notas de entrega de ${n.de}`),
          n.cerrado ? null : h("p", { class: "sub" }, "Tu relevo aún no cierra su turno; estas notas se completarán al cerrar."),
          h("p", { class: "notas-texto" }, n.notas || "Sin notas.")));
      }
    } catch { /* sin conexión o sin notas */ }
  }
}

function listaSiguientes(items) {
  if (!items.length) return null;
  return h("section", { class: "bloque" }, h("h3", {}, "Siguientes turnos"),
    h("ul", { class: "lista" }, items.map(({ t }) => h("li", { class: "item" }, h("div", { class: "item-info" },
      h("strong", {}, diaLargo(t.inicioMs)), h("span", { class: "sub" }, `${hora(t.inicioMs)} – ${hora(t.finMs)} · ${t.sitioNombre}`))))));
}
