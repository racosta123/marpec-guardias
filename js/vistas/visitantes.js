// Visitantes (supervisor: sus sitios; admin: todos): quién está dentro ahora, historial por día,
// foto del vehículo/placa (privada) y exportación CSV. No existen datos de identificaciones.
import { collection, getDocs, orderBy, query, where } from "../vendor/firebase.js";
import { h, limpiar, modal, poner, toast } from "../ui.js";
import { diaLargo, hora, hoy, localAMs, sumarDias } from "../tz.js";
import { cargarSitios } from "./sitios.js";
import { celda } from "./reportes.js";

const MOTIVO = { visita: "Visita", proveedor: "Proveedor", paqueteria: "Paquetería", servicio: "Servicio", otro: "Otro" };

export function visitantesACsv(filas) {
  const cab = ["Fecha", "Sitio", "Visitante", "Visita a", "Motivo", "Empresa", "Placas", "Entrada", "Salida", "Registró (guardia)", "Foto"];
  const lineas = [cab, ...filas.map((v) => [new Date(v.entradaMs - 7 * 3600e3).toISOString().slice(0, 10), v.sitioNombre, v.nombre, v.visitaA, MOTIVO[v.motivo] || v.motivo, v.empresa || "", v.placas || "", hora(v.entradaMs), v.salidaMs ? hora(v.salidaMs) : "DENTRO", v.guardiaNombre || "", v.fotoKey ? "Sí" : "No"])];
  return "﻿" + lineas.map((l) => l.map(celda).join(",")).join("\r\n");
}

export async function vistaVisitantes(raiz, ctx, f = {}) {
  const { db, api, user } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando visitantes…"));
  const fecha = f.fecha || hoy(), sitioId = f.sitioId || "";
  const sitios = await cargarSitios(ctx);
  const col = collection(db, "visitantesVista");
  const rol = user.rol === "admin" ? [] : [where("supervisorUid", "==", user.uid)];
  const [dentroS, diaS] = await Promise.all([
    getDocs(query(col, ...rol, where("dentro", "==", true))),
    getDocs(query(col, ...rol, where("entradaMs", ">=", localAMs(fecha)), where("entradaMs", "<", localAMs(sumarDias(fecha, 1))), orderBy("entradaMs"))),
  ]);
  const mapa = (s) => s.docs.map((d) => ({ id: d.id, ...d.data() }));
  const filtro = (v) => !sitioId || v.sitioId === sitioId;
  const dentro = mapa(dentroS).filter(filtro).sort((a, b) => a.entradaMs - b.entradaMs);
  const dia = mapa(diaS).filter(filtro);
  const recargar = (e = {}) => vistaVisitantes(raiz, ctx, { fecha, sitioId, ...e });

  const fila = (v) => h("li", { class: "item" }, h("div", { class: "item-info" },
    h("strong", {}, v.nombre), h("span", { class: "sub" }, `${v.sitioNombre} · visita a ${v.visitaA} · ${MOTIVO[v.motivo] || v.motivo}${v.empresa ? " · " + v.empresa : ""}${v.placas ? " · placas " + v.placas : ""}`),
    h("span", { class: "sub" }, `Entrada ${hora(v.entradaMs)} · ${v.salidaMs ? `salida ${hora(v.salidaMs)}` : "DENTRO"} · registró ${v.guardiaNombre || "—"}`)),
  h("div", { class: "item-acc" }, v.fotoKey ? h("button", { class: "btn chico secundario", type: "button", onclick: () => verFoto(v) }, "Foto vehículo/placa") : null,
    v.dentro ? h("span", { class: "etq ok" }, "Dentro") : null, v.prueba ? h("span", { class: "etq prueba" }, "PRUEBA") : null));

  limpiar(raiz);
  poner(raiz,
    h("div", { class: "barra" }, h("h2", {}, "Visitantes"), h("div", { class: "barra-acc" },
      h("button", { class: "btn chico secundario", type: "button", onclick: () => recargar() }, "↻ Actualizar"),
      h("button", { class: "btn chico secundario", type: "button", onclick: () => window.open("aviso-visitantes.html", "_blank", "noopener") }, "🖨 Cartel de aviso"),
      h("button", { class: "btn chico secundario", type: "button", onclick: () => { if (!dia.length) return toast("No hay visitantes ese día.", "error"); const url = URL.createObjectURL(new Blob([visitantesACsv(dia)], { type: "text/csv;charset=utf-8" })); const a = h("a", { href: url, download: `visitantes_${fecha}.csv` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); } }, "⬇ CSV del día"))),
    h("div", { class: "filtros dos" },
      h("input", { type: "date", value: fecha, "aria-label": "Día", onchange: (e) => e.target.value && recargar({ fecha: e.target.value }) }),
      h("select", { value: sitioId, "aria-label": "Sitio", onchange: (e) => recargar({ sitioId: e.target.value }) }, h("option", { value: "" }, "Todos los sitios"), sitios.map((s) => h("option", { value: s.id }, s.nombre)))),
    h("section", { class: "bloque" }, h("h3", {}, `Dentro ahora (${dentro.length})`), dentro.length ? h("ul", { class: "lista" }, dentro.map(fila)) : h("p", { class: "vacio" }, "Nadie dentro en este momento.")),
    h("section", { class: "bloque" }, h("h3", {}, `Historial · ${diaLargo(localAMs(fecha, "12:00"))} (${dia.length})`), dia.length ? h("ul", { class: "lista" }, dia.map(fila)) : h("p", { class: "vacio" }, "Sin visitantes ese día.")),
    h("p", { class: "ayuda" }, "Los registros y fotos de visitantes se borran automáticamente al vencer la retención configurada. No se piden ni guardan identificaciones."));

  async function verFoto(v) {
    const cont = h("div", { class: "selfie-caja" }, h("p", { class: "vacio" }, "Cargando foto…"));
    modal(`Vehículo/placa · ${v.nombre}`, cont);
    try {
      const blob = await api.blob(`/visitantes/foto?id=${encodeURIComponent(v.visitanteId || v.id)}`);
      limpiar(cont);
      poner(cont, h("img", { class: "selfie sin-espejo", src: URL.createObjectURL(blob), alt: "Foto del vehículo o la placa" }));
    } catch (e) { limpiar(cont); poner(cont, h("p", { class: "error" }, e.message)); }
  }
}
