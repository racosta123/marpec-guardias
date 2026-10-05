// Bitácoras por turno (supervisor: sus sitios; admin: todos): libro de novedades consolidado en orden
// cronológico (entrada, novedades, rondines, incidencias, visitantes, salida y notas de relevo) + CSV.
import { collection, getDocs, orderBy, query, where } from "../vendor/firebase.js";
import { accion, h, limpiar, modal, poner, toast } from "../ui.js";
import { diaLargo, fechaHora, hora, hoy, localAMs, sumarDias } from "../tz.js";
import { cargarSitios } from "./sitios.js";
import { celda } from "./reportes.js";
import { lineaDeTiempo } from "./libro.js";

const TIPO = { entrada: "Entrada", novedad: "Novedad", rondin: "Rondín", incidencia: "Incidencia", visitante_entrada: "Entra visitante", visitante_salida: "Sale visitante", salida: "Salida" };

export function bitacoraACsv(b) {
  const lineas = [["Fecha y hora", "Tipo", "Título", "Detalle", "Sitio", "Guardia"], ...b.items.map((x) => [fechaHora(x.tsMs), TIPO[x.tipo] || x.tipo, x.titulo, x.detalle || "", b.sitioNombre, b.guardiaNombre])];
  return "﻿" + lineas.map((l) => l.map(celda).join(",")).join("\r\n");
}

export async function vistaBitacoras(raiz, ctx, f = {}) {
  const { db, api, user } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando bitácoras…"));
  const fecha = f.fecha || hoy(), sitioId = f.sitioId || "";
  const sitios = await cargarSitios(ctx);
  const rol = user.rol === "admin" ? [] : [where("supervisorUid", "==", user.uid)];
  const s = await getDocs(query(collection(db, "asistencias"), ...rol, where("inicioMs", ">=", localAMs(fecha)), where("inicioMs", "<", localAMs(sumarDias(fecha, 1))), orderBy("inicioMs")));
  const turnos = s.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => !sitioId || t.sitioId === sitioId);
  const recargar = (e = {}) => vistaBitacoras(raiz, ctx, { fecha, sitioId, ...e });

  limpiar(raiz);
  poner(raiz,
    h("div", { class: "barra" }, h("h2", {}, "Bitácoras por turno"), h("div", { class: "barra-acc" }, h("button", { class: "btn chico secundario", type: "button", onclick: () => recargar() }, "↻ Actualizar"))),
    h("div", { class: "filtros dos" },
      h("input", { type: "date", value: fecha, "aria-label": "Día", onchange: (e) => e.target.value && recargar({ fecha: e.target.value }) }),
      h("select", { value: sitioId, "aria-label": "Sitio", onchange: (e) => recargar({ sitioId: e.target.value }) }, h("option", { value: "" }, "Todos los sitios"), sitios.map((x) => h("option", { value: x.id }, x.nombre)))),
    h("p", { class: "resumen-dia" }, `${diaLargo(localAMs(fecha, "12:00"))}: ${turnos.length} turno(s)`),
    turnos.length ? h("ul", { class: "lista" }, turnos.map((t) => h("li", { class: "item" }, h("div", { class: "item-info" },
      h("strong", {}, `${t.guardiaNombre} · ${t.sitioNombre}`), h("span", { class: "sub" }, `${hora(t.inicioMs)}–${hora(t.finMs)} · ${t.estado}${t.entradaMs ? ` · entrada ${hora(t.entradaMs)}` : ""}${t.salidaMs ? ` · salida ${hora(t.salidaMs)}` : ""}`)),
    h("div", { class: "item-acc" }, h("button", { class: "btn chico primario", type: "button", onclick: () => abrir(t) }, "Ver bitácora"))))) : h("p", { class: "vacio" }, "No hay turnos con guardia ese día."));

  async function abrir(t) {
    const cont = h("div", {}, h("p", { class: "vacio" }, "Cargando…"));
    modal(`Bitácora · ${t.guardiaNombre}`, cont);
    try {
      const b = await api(`/bitacora/turno?turnoId=${encodeURIComponent(t.id)}`, { method: "GET" });
      limpiar(cont);
      poner(cont, lineaDeTiempo(b), b.notasEntrega ? h("p", { class: "ayuda" }, `Notas de relevo: ${b.notasEntrega}`) : null,
        h("button", { class: "btn secundario", type: "button", onclick: (e) => { const url = URL.createObjectURL(new Blob([bitacoraACsv(b)], { type: "text/csv;charset=utf-8" })); const a = h("a", { href: url, download: `bitacora_${t.fecha}_${t.id}.csv` }); document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); toast("CSV exportado."); void e; } }, "⬇ Exportar CSV"));
    } catch (e) { limpiar(cont); poner(cont, h("p", { class: "error" }, e.message)); }
  }
  void accion;
}
