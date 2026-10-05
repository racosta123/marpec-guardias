// Incidencias (supervisor: sus sitios; admin: todos): alerta de gravedad alta, filtros, seguimiento
// (comentarios y cambios de estado como registros nuevos), fotos privadas y exportación CSV.
import { collection, getDocs, query, where } from "../vendor/firebase.js";
import { accion, campo, h, limpiar, modal, poner, toast } from "../ui.js";
import { fechaHora, hoy, localAMs, sumarDias } from "../tz.js";
import { cargarSitios } from "./sitios.js";
import { celda } from "./reportes.js";

const ESTADOS = { abierta: ["Abierta", "mal"], en_atencion: ["En atención", "info"], cerrada: ["Cerrada", "ok"] };
const GRAV = { baja: ["Baja", "info"], media: ["Media", "prueba"], alta: ["ALTA", "mal"] };

export function incidenciasACsv(filas) {
  const cab = ["Fecha y hora", "Sitio", "Tipo", "Gravedad", "Estado", "Guardia", "Descripción", "Fotos", "Seguimiento"];
  const lineas = [cab, ...filas.map((i) => [fechaHora(i.creadoMs), i.sitioNombre, i.tipoNombre, (GRAV[i.gravedad] || [i.gravedad])[0], (ESTADOS[i.estado] || [i.estado])[0], i.guardiaNombre, i.descripcion, i.nFotos,
    (i.seguimientos || []).map((s) => `${fechaHora(s.tsMs)} ${s.autorNombre}: ${s.tipo === "estado" ? `[${s.estadoNuevo}] ` : ""}${s.texto || ""}`).join(" | ")])];
  return "﻿" + lineas.map((l) => l.map(celda).join(",")).join("\r\n");
}

async function cargar(ctx, filtros) {
  const { db, user } = ctx;
  const f = [...(user.rol === "admin" ? [] : [where("supervisorUid", "==", user.uid)]), ...filtros];
  const s = await getDocs(query(collection(db, "incidenciasResumen"), ...f));
  return s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => b.creadoMs - a.creadoMs);
}

function descargar(nombre, texto) {
  const url = URL.createObjectURL(new Blob([texto], { type: "text/csv;charset=utf-8" }));
  const a = h("a", { href: url, download: nombre });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function vistaIncidencias(raiz, ctx, f = {}) {
  const { api } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando incidencias…"));
  const filtros = { sitioId: "", estado: "", gravedad: "", desde: sumarDias(hoy(), -30), hasta: hoy(), ...f };
  const sitios = await cargarSitios(ctx);
  const [todas, altas] = await Promise.all([cargar(ctx, [where("creadoMs", ">=", localAMs(filtros.desde)), where("creadoMs", "<", localAMs(sumarDias(filtros.hasta, 1)))]), cargar(ctx, [where("gravedad", "==", "alta")])]);
  const recargar = (e = {}) => vistaIncidencias(raiz, ctx, { ...filtros, ...e });
  const lista = todas.filter((i) => (!filtros.sitioId || i.sitioId === filtros.sitioId) && (!filtros.estado || i.estado === filtros.estado) && (!filtros.gravedad || i.gravedad === filtros.gravedad));
  const criticas = altas.filter((i) => i.estado !== "cerrada" && (!filtros.sitioId || i.sitioId === filtros.sitioId));

  const tarjeta = (i) => {
    const [et, ce] = ESTADOS[i.estado] || [i.estado, "info"], [gt, gc] = GRAV[i.gravedad] || [i.gravedad, "info"];
    return h("li", { class: `item asis ${i.alta && i.estado !== "cerrada" ? "alerta-borde" : ""}` },
      h("div", { class: "item-info" },
        h("strong", {}, `${i.tipoNombre} · ${i.sitioNombre}`),
        h("span", {}, h("span", { class: `etq ${gc}` }, gt), h("span", { class: `etq ${ce}` }, et), i.prueba ? h("span", { class: "etq prueba" }, "PRUEBA") : null),
        h("span", { class: "sub" }, `${fechaHora(i.creadoMs)} · reportó ${i.guardiaNombre}${i.distanciaM != null ? ` · a ${Math.round(i.distanciaM)} m del sitio` : ""}`),
        h("p", { class: "consignas" }, i.descripcion),
        i.nFotos ? h("div", { class: "item-acc" }, Array.from({ length: i.nFotos }, (_, n) => h("button", { class: "btn chico secundario", type: "button", onclick: () => verFoto(i, n) }, `Foto ${n + 1}`))) : null,
        i.seguimientos?.length ? h("ol", { class: "seguimiento" }, i.seguimientos.map((s) => h("li", {}, h("b", {}, s.autorNombre), ` · ${fechaHora(s.tsMs)}`, s.tipo === "estado" ? h("span", { class: "etq info" }, `→ ${(ESTADOS[s.estadoNuevo] || [s.estadoNuevo])[0]}`) : null, s.texto ? h("p", {}, s.texto) : null))) : null),
      h("div", { class: "item-acc" },
        h("button", { class: "btn chico secundario", type: "button", onclick: () => form(i, "comentario") }, "Comentar"),
        i.estado === "abierta" ? h("button", { class: "btn chico primario", type: "button", onclick: () => form(i, "estado", "en_atencion") }, "En atención") : null,
        i.estado !== "cerrada" ? h("button", { class: "btn chico peligro", type: "button", onclick: () => form(i, "estado", "cerrada") }, "Cerrar") : null));
  };

  limpiar(raiz);
  poner(raiz,
    h("div", { class: "barra" }, h("h2", {}, "Incidencias"), h("div", { class: "barra-acc" },
      h("button", { class: "btn chico secundario", type: "button", onclick: () => recargar() }, "↻ Actualizar"),
      h("button", { class: "btn chico secundario", type: "button", onclick: () => { if (!lista.length) return toast("No hay incidencias con esos filtros.", "error"); descargar(`incidencias_${filtros.desde}_a_${filtros.hasta}.csv`, incidenciasACsv([...lista].reverse())); } }, "⬇ CSV"))),
    criticas.length ? h("section", { class: "alerta-caja" }, h("h3", {}, `🚨 Incidencias de gravedad ALTA sin cerrar (${criticas.length})`),
      h("ul", { class: "lista" }, criticas.map((i) => h("li", { class: "item alerta-borde" }, h("div", { class: "item-info" }, h("strong", {}, `${i.tipoNombre} · ${i.sitioNombre}`), h("span", { class: "sub" }, `${fechaHora(i.creadoMs)} · ${i.guardiaNombre} · ${(ESTADOS[i.estado] || [i.estado])[0]}`), h("p", { class: "consignas" }, i.descripcion)))))) : null,
    h("div", { class: "filtros filtros-incidencias" },
      h("select", { value: filtros.sitioId, "aria-label": "Sitio", onchange: (e) => recargar({ sitioId: e.target.value }) }, h("option", { value: "" }, "Todos los sitios"), sitios.map((s) => h("option", { value: s.id }, s.nombre))),
      h("select", { value: filtros.estado, "aria-label": "Estado", onchange: (e) => recargar({ estado: e.target.value }) }, h("option", { value: "" }, "Todos los estados"), Object.entries(ESTADOS).map(([v, [t]]) => h("option", { value: v }, t))),
      h("select", { value: filtros.gravedad, "aria-label": "Gravedad", onchange: (e) => recargar({ gravedad: e.target.value }) }, h("option", { value: "" }, "Toda gravedad"), Object.entries(GRAV).map(([v, [t]]) => h("option", { value: v }, t))),
      h("div", { class: "dos" }, h("input", { type: "date", value: filtros.desde, "aria-label": "Desde", onchange: (e) => e.target.value && recargar({ desde: e.target.value }) }), h("input", { type: "date", value: filtros.hasta, "aria-label": "Hasta", onchange: (e) => e.target.value && recargar({ hasta: e.target.value }) }))),
    lista.length ? h("ul", { class: "lista" }, lista.map(tarjeta)) : h("p", { class: "vacio" }, "No hay incidencias con esos filtros."),
    h("p", { class: "ayuda" }, "Las incidencias no se editan: el seguimiento se agrega como registros nuevos con tu nombre y la hora. Horario de Hermosillo."));

  async function verFoto(i, n) {
    const cont = h("div", { class: "selfie-caja" }, h("p", { class: "vacio" }, "Cargando foto…"));
    modal(`Foto ${n + 1} · ${i.tipoNombre}`, cont);
    try {
      const blob = await api.blob(`/incidencias/foto?incidencia=${encodeURIComponent(i.incidenciaId || i.id)}&n=${n}`);
      limpiar(cont);
      poner(cont, h("img", { class: "selfie sin-espejo", src: URL.createObjectURL(blob), alt: `Foto ${n + 1}` }));
    } catch (e) { limpiar(cont); poner(cont, h("p", { class: "error" }, e.message)); }
  }

  function form(i, tipo, estadoNuevo) {
    const texto = h("textarea", { rows: 3, maxlength: 500, required: tipo === "comentario", placeholder: tipo === "comentario" ? "Comentario (obligatorio)" : "Nota del cambio (opcional)" });
    const f = h("form", { class: "form", novalidate: true },
      h("p", {}, tipo === "comentario" ? `Comentar la incidencia «${i.tipoNombre}».` : `Pasar la incidencia a «${(ESTADOS[estadoNuevo] || [estadoNuevo])[0]}».`),
      campo(tipo === "comentario" ? "Comentario" : "Nota", texto, "Queda como registro nuevo con tu nombre y la hora."),
      h("button", { class: `btn ${estadoNuevo === "cerrada" ? "peligro" : "primario"}`, type: "submit" }, tipo === "comentario" ? "Agregar comentario" : "Cambiar estado"));
    const m = modal(tipo === "comentario" ? "Comentario" : "Cambio de estado", f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await accion(f.querySelector("button"), () => api("/incidencias/seguimiento", { body: { incidenciaId: i.incidenciaId || i.id, tipo, texto: texto.value, ...(estadoNuevo ? { estadoNuevo } : {}) } }), "Seguimiento registrado.");
      if (r) { m.cerrar(); recargar(); }
    });
  }
}
