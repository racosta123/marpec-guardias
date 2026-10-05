// Inicio del guardia: estado de su turno, botón grande de entrada/salida, consignas y notas del relevo.
import { collection, doc, getDoc, getDocs, orderBy, query, where } from "../vendor/firebase.js";
import { h, limpiar, poner } from "../ui.js";
import { diaLargo, duracionH, hora } from "../tz.js";
import { abrirMarcado } from "./marcar.js";
import { abrirRondin } from "./rondin.js";
import { listar, metaGet, metaSet, ahoraEstimado } from "../cola.js";
import { rondinConRespaldo } from "../rondin-local.js";
import { abrirBitacora, abrirIncidencia, abrirNovedad, abrirVisitantes } from "./libro.js";

const H = 3600e3;

let turnoActual = null; // turno vigente del guardia (lo usa el botón de pánico para ubicar el sitio)
export const turnoVigenteId = () => turnoActual;

const pick = (o, ks) => Object.fromEntries(ks.filter((k) => o && o[k] !== undefined).map((k) => [k, o[k]]));
const CAMPOS_T = ["sitioId", "sitioNombre", "inicioMs", "finMs", "estado", "plantilla"];
const CAMPOS_A = ["estado", "entradaMs", "salidaMs", "retardo", "retardoMin", "falta", "minutosExtra", "extraEstado", "relevoAlerta", "relevoRequerido", "relevoLlegado", "cierreAutorizado", "ventanaEntradaDesdeMs"];
const CAMPOS_S = ["nombre", "direccion", "consignas", "lat", "lng", "radioM", "telefonoEmergencia"];
const conTiempo = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error("tiempo agotado")), ms))]);

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
  if (desdeCopia) poner(raiz, h("p", { class: "alerta" }, "Sin conexión: se muestra tu último turno guardado en este celular. Puedes marcar y reportar; todo se enviará solo al volver la señal."));
  if (!vigente) {
    poner(raiz, h("p", { class: "vacio" }, "No tienes turnos asignados por ahora."), listaSiguientes(siguientes));
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

  const boton = accion ? h("button", { class: `btn primario grande ${accion === "salida" ? "salida" : ""}`, type: "button",
    onclick: () => abrirMarcado({ tipo: accion, turno: t, sitio, api, alTerminar: recargar }) },
  accion === "entrada" ? "MARCAR ENTRADA" : "MARCAR SALIDA") : null;

  const consignas = sitio?.consignas;
  poner(raiz,
    h("section", { class: "tarjeta turno-grande" },
      h("span", { class: `etq ${clase}` }, etiqueta),
      h("h3", {}, diaLargo(t.inicioMs)),
      h("p", { class: "hora-grande" }, `${hora(t.inicioMs)} – ${hora(t.finMs)}`, h("small", {}, ` (${duracionH(t.inicioMs, t.finMs)})`)),
      h("p", {}, h("b", {}, "Sitio: "), t.sitioNombre),
      sitio?.direccion ? h("p", { class: "sub" }, sitio.direccion) : null,
      entradaMs ? h("p", { class: "sub" }, `Entrada: ${hora(entradaMs)}${a?.retardo ? ` · retardo de ${a.retardoMin} min` : ""}${salidaMs ? ` · Salida: ${hora(salidaMs)}` : ""}`) : null,
      a?.minutosExtra > 0 ? h("p", { class: "sub" }, `Tiempo extra: ${a.minutosExtra} min (${a.extraEstado === "autorizado" ? "autorizado" : a.extraEstado === "rechazado" ? "rechazado" : "pendiente de autorización"})`) : null,
      ayuda ? h("p", { class: "ayuda-relevo" }, ayuda) : null,
      boton,
      h("div", { class: "consignas-caja" }, h("h4", {}, "Consignas del puesto"), h("p", {}, consignas || "Sin consignas registradas."))),
    h("div", { id: "libro-card" }),
    h("div", { id: "rondines-card" }),
    h("div", { id: "notas-relevo" }),
    listaSiguientes(siguientes),
    h("p", { class: "ayuda" }, "Horario de Hermosillo (UTC-7, sin horario de verano). Para marcar se usa tu ubicación solo en ese momento."));

  // Libro del turno: novedades, incidencias, visitantes y bitácora (solo con entrada marcada y turno abierto)
  if (entradaMs && !salidaMs) {
    const dest = raiz.querySelector("#libro-card");
    const ctxLibro = { turno: t, api, alTerminar: recargar };
    const btnVis = h("button", { class: "btn secundario libro-btn", type: "button", onclick: () => abrirVisitantes(ctxLibro) }, "🚶 Visitantes");
    poner(dest, h("section", { class: "tarjeta" }, h("h4", { class: "titulo-seccion" }, "Libro del turno"),
      h("div", { class: "libro-botones" },
        h("button", { class: "btn primario libro-btn", type: "button", onclick: () => abrirNovedad(ctxLibro) }, "📝 Novedad"),
        h("button", { class: "btn peligro libro-btn", type: "button", onclick: () => abrirIncidencia(ctxLibro) }, "⚠️ Incidencia"),
        btnVis,
        h("button", { class: "btn secundario libro-btn", type: "button", onclick: () => abrirBitacora({ turno: t, api }) }, "📖 Bitácora"))));
    api(`/visitantes/dentro?turnoId=${encodeURIComponent(t.id)}`, { method: "GET" }).then((v) => { if (v.dentro.length) btnVis.textContent = `🚶 Visitantes (${v.dentro.length} dentro)`; }).catch(() => {});
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
