// Reporte de asistencia por periodo (admin), exportable a CSV. Los cálculos vienen del Worker.
import { accion, campo, h, limpiar, poner, toast } from "../ui.js";
import { hora, hoy, sumarDias } from "../tz.js";
import { cargarSitios } from "./sitios.js";

// Neutraliza fórmulas de hoja de cálculo (=, +, -, @) y escapa comillas.
export const celda = (v) => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export function aCsv(filas) {
  const cab = ["Fecha", "Sitio", "Guardia", "Inicio", "Fin", "Estado", "Entrada", "Salida", "Retardo (min)", "Falta", "Motivo falta", "Extra (min)", "Estado extra", "Extra resuelto por", "Ajustes", "Relevo no llegó"];
  const lineas = [cab, ...filas.map((a) => [a.fecha, a.sitioNombre, a.guardiaNombre, hora(a.inicioMs), hora(a.finMs), a.estado,
    a.entradaMs ? hora(a.entradaMs) : "", a.salidaMs ? hora(a.salidaMs) : "", a.retardo ? a.retardoMin : 0, a.falta ? "Sí" : "No", a.motivoFalta || "",
    a.minutosExtra || 0, a.extraEstado || "", a.extraResueltoPor || "", a.ajustes || 0, a.relevoAlerta ? "Sí" : "No"])];
  return "﻿" + lineas.map((l) => l.map(celda).join(",")).join("\r\n");
}

export async function vistaReportes(raiz, ctx) {
  const { api } = ctx;
  limpiar(raiz);
  const sitios = await cargarSitios(ctx);
  const desde = h("input", { type: "date", value: sumarDias(hoy(), -6), required: true });
  const hasta = h("input", { type: "date", value: hoy(), required: true });
  const sitio = h("select", { value: "" }, h("option", { value: "" }, "Todos los sitios"), sitios.map((s) => h("option", { value: s.id }, s.nombre)));
  const salida = h("div", {});
  let ultimo = null;
  const exportar = h("button", { class: "btn secundario", type: "button", hidden: true, onclick: () => {
    if (!ultimo) return;
    const url = URL.createObjectURL(new Blob([aCsv(ultimo.filas)], { type: "text/csv;charset=utf-8" }));
    const a = h("a", { href: url, download: `asistencia_${ultimo.desde}_a_${ultimo.hasta}.csv` });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  } }, "⬇ Exportar CSV");
  const f = h("form", { class: "form tarjeta", novalidate: true },
    h("div", { class: "dos" }, campo("Desde", desde), campo("Hasta", hasta)), campo("Sitio", sitio),
    h("button", { class: "btn primario", type: "submit" }, "Generar reporte"), exportar);

  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    const q = new URLSearchParams({ desde: desde.value, hasta: hasta.value, ...(sitio.value ? { sitioId: sitio.value } : {}) });
    const r = await accion(f.querySelector("button[type=submit]"), () => api(`/reportes/asistencia?${q}`, { method: "GET" }));
    if (!r) return;
    ultimo = r;
    exportar.hidden = r.filas.length === 0;
    limpiar(salida);
    poner(salida,
      h("section", { class: "bloque" }, h("h3", {}, "Resumen por guardia"),
        r.resumen.length ? h("div", { class: "tabla-caja" }, h("table", { class: "tabla" },
          h("thead", {}, h("tr", {}, ["Guardia", "Turnos", "Cumplidos", "Retardos", "Faltas", `Faltas por retardos (${r.retardosPorFalta} = 1)`, "Faltas totales", "Extra (h)"].map((t) => h("th", {}, t)))),
          h("tbody", {}, r.resumen.map((g) => h("tr", {}, [g.guardiaNombre, g.turnos, g.cumplidos, g.retardos, g.faltas, g.faltasPorRetardos, g.faltasTotales, (g.minutosExtra / 60).toFixed(1)].map((v) => h("td", {}, v))))))) : h("p", { class: "vacio" }, "Sin turnos en el periodo.")),
      r.semanal.length ? h("section", { class: "bloque" }, h("h3", {}, "Horas extra por semana (límite legal configurable por año)"),
        h("div", { class: "tabla-caja" }, h("table", { class: "tabla" },
          h("thead", {}, h("tr", {}, ["Semana (lunes)", "Guardia", "Pendientes (min)", "Autorizadas (min)", "Rechazadas (min)", "Horas consideradas", "Límite (h)", ""].map((t) => h("th", {}, t)))),
          h("tbody", {}, r.semanal.map((s) => h("tr", { class: s.excedeLimite ? "fila-mal" : "" }, [s.semana, r.resumen.find((x) => x.guardiaUid === s.guardiaUid)?.guardiaNombre || s.guardiaUid, s.pendienteMin, s.autorizadoMin, s.rechazadoMin, s.horasConsideradas, s.limiteHoras ?? "—", s.excedeLimite ? "EXCEDE" : ""].map((v) => h("td", {}, v))))))),
        h("p", { class: "ayuda" }, "El pago de horas extra se calcula en una fase posterior.")) : null,
      h("section", { class: "bloque" }, h("h3", {}, `Detalle (${r.filas.length})`),
        r.filas.length ? h("div", { class: "tabla-caja" }, h("table", { class: "tabla" },
          h("thead", {}, h("tr", {}, ["Fecha", "Sitio", "Guardia", "Turno", "Estado", "Entrada", "Salida", "Retardo", "Extra"].map((t) => h("th", {}, t)))),
          h("tbody", {}, r.filas.map((a) => h("tr", {}, [a.fecha, a.sitioNombre, a.guardiaNombre, `${hora(a.inicioMs)}–${hora(a.finMs)}`, a.estado, a.entradaMs ? hora(a.entradaMs) : "—", a.salidaMs ? hora(a.salidaMs) : "—", a.retardo ? `${a.retardoMin} min` : "", a.minutosExtra ? `${a.minutosExtra} min (${a.extraEstado})` : ""].map((v) => h("td", {}, v))))))) : null));
    toast(`Reporte generado: ${r.filas.length} turno(s).`);
  });
  poner(raiz, h("div", { class: "barra" }, h("h2", {}, "Reportes de asistencia")), f, salida);
}
