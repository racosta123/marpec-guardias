// Inicio del guardia: estado de su turno, botón grande de entrada/salida, consignas y notas del relevo.
import { collection, doc, getDoc, getDocs, orderBy, query, where } from "../vendor/firebase.js";
import { h, limpiar, poner } from "../ui.js";
import { diaLargo, duracionH, hora } from "../tz.js";
import { abrirMarcado } from "./marcar.js";

const H = 3600e3;

export async function vistaGuardia(raiz, ctx) {
  const { db, api, user } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando tu turno…"));
  const ahora = Date.now();
  const snap = await getDocs(query(collection(db, "turnos"),
    where("guardiaUid", "==", user.uid), where("inicioMs", ">=", ahora - 48 * H), orderBy("inicioMs")));
  const candidatos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.estado === "programado");

  // Estado de asistencia de cada turno (lo calcula el Worker; puede no existir aún)
  const conEstado = [];
  for (const t of candidatos) {
    let a = null;
    try { const s = await getDoc(doc(db, "asistencias", t.id)); if (s.exists()) a = s.data(); } catch { /* sin acceso */ }
    conEstado.push({ t, a });
  }
  // Turno vigente: no cumplido y (aún no termina, o terminó pero sigue sin cerrar tras haber entrado)
  const vigente = conEstado.find(({ t, a }) => a?.estado !== "cumplido" && a?.estado !== "falta" && (t.finMs > ahora || (a?.entradaMs && !a?.salidaMs)));
  const siguientes = conEstado.filter(({ t }) => t.inicioMs > ahora && t.id !== vigente?.t.id).slice(0, 6);

  limpiar(raiz);
  if (!navigator.onLine) poner(raiz, h("p", { class: "alerta" }, "Sin conexión: para marcar necesitas internet."));
  if (!vigente) {
    poner(raiz, h("p", { class: "vacio" }, "No tienes turnos asignados por ahora."), listaSiguientes(siguientes));
    return;
  }

  const { t, a } = vigente;
  let sitio = null;
  try { const s = await getDoc(doc(db, "sitios", t.sitioId)); if (s.exists()) sitio = s.data(); } catch { /* sin acceso */ }
  const recargar = () => vistaGuardia(raiz, ctx);

  const entradaMs = a?.entradaMs ?? null;
  const salidaMs = a?.salidaMs ?? null;
  const ventanaDesde = a?.ventanaEntradaDesdeMs ?? t.inicioMs - 30 * 60000;
  let etiqueta, clase, accion = null, ayuda = null;
  if (salidaMs) { etiqueta = "Turno cerrado"; clase = "ok"; }
  else if (entradaMs) {
    const pendiente = a?.relevoAlerta;
    etiqueta = pendiente ? "Salida pendiente de relevo" : ahora > t.finMs ? "Salida pendiente" : "En turno";
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
    h("div", { id: "notas-relevo" }),
    listaSiguientes(siguientes),
    h("p", { class: "ayuda" }, "Horario de Hermosillo (UTC-7, sin horario de verano). Para marcar se usa tu ubicación solo en ese momento."));

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
