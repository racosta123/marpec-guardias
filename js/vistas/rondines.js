// Rondines (supervisor: sus sitios; admin: todos): alertas, cumplimiento por sitio y día, detalle con la
// hora de cada punto, fotos, ajustes con motivo y exportación a CSV (protegida contra fórmulas).
import { collection, getDocs, orderBy, query, where } from "../vendor/firebase.js";
import { accion, campo, h, limpiar, modal, poner, toast } from "../ui.js";
import { diaLargo, hora, hoy, localAMs, sumarDias } from "../tz.js";
import { cargarSitios } from "./sitios.js";
import { celda } from "./reportes.js";

const ESTADOS = {
  programado: ["Programado", "info"], pendiente: ["Por iniciar", "info"], en_curso: ["En curso", "info"], completo: ["Completo", "ok"],
  incompleto: ["INCOMPLETO", "mal"], no_iniciado: ["NO INICIADO", "mal"], justificado: ["Justificado", "info"], no_exigible: ["Sin guardia", "info"],
};

export const cumplimiento = (rs) => {
  const ex = rs.filter((r) => ["completo", "incompleto", "no_iniciado"].includes(r.estado));
  const ok = ex.filter((r) => r.estado === "completo").length;
  return { exigibles: ex.length, completos: ok, porcentaje: ex.length ? Math.round((ok / ex.length) * 1000) / 10 : null };
};

export function rondinesACsv(filas) {
  const cab = ["Fecha", "Sitio", "Guardia", "Programado", "Estado", "Iniciado", "Finalizado", "Puntos hechos", "Total", "Cumplimiento %", "Puntos faltantes", "Detalle por punto"];
  const lineas = [cab, ...filas.map((r) => [r.fecha, r.sitioNombre, r.guardiaNombre, hora(r.programadoMs), (ESTADOS[r.estado] || [r.estado])[0],
    r.iniciadoMs ? hora(r.iniciadoMs) : "", r.finalizadoMs ? hora(r.finalizadoMs) : "", r.hechos, r.total, r.porcentaje,
    (r.faltantes || []).map((f) => f.nombre).join("; "),
    (r.detalle || []).map((d) => `${d.nombre}: ${d.hecho ? hora(d.tsMs) + (d.origen === "ajuste" ? " (ajuste)" : "") : "faltó"}`).join(" | ")])];
  return "﻿" + lineas.map((l) => l.map(celda).join(",")).join("\r\n");
}

async function cargar(ctx, filtros, rango) {
  const { db, user } = ctx;
  const f = [...(user.rol === "admin" ? [] : [where("supervisorUid", "==", user.uid)]), ...filtros];
  const s = await getDocs(query(collection(db, "rondines"), ...f, ...(rango ? [where("programadoMs", ">=", rango[0]), where("programadoMs", "<", rango[1]), orderBy("programadoMs")] : [])));
  return s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.programadoMs - b.programadoMs);
}

function descargar(nombre, texto) {
  const url = URL.createObjectURL(new Blob([texto], { type: "text/csv;charset=utf-8" }));
  const a = h("a", { href: url, download: nombre });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export async function vistaRondines(raiz, ctx, estado = {}) {
  const { api } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando rondines…"));
  const fecha = estado.fecha || hoy();
  const sitioId = estado.sitioId || "";
  const sitios = await cargarSitios(ctx);
  await api("/rondines/recalcular", { body: { desde: sumarDias(fecha, -1), hasta: fecha } }).catch(() => {});
  const rango = [localAMs(fecha), localAMs(sumarDias(fecha, 1))];
  const [dia, noIniciados, incompletos] = await Promise.all([cargar(ctx, [], rango), cargar(ctx, [where("estado", "==", "no_iniciado")]), cargar(ctx, [where("estado", "==", "incompleto")])]);
  const recargar = (e = {}) => vistaRondines(raiz, ctx, { fecha, sitioId, ...e });
  const filtrar = (r) => !sitioId || r.sitioId === sitioId;
  const delDia = dia.filter(filtrar);

  const porSitio = new Map();
  for (const r of delDia) porSitio.set(r.sitioNombre, [...(porSitio.get(r.sitioNombre) || []), r]);
  const alertas = [...noIniciados, ...incompletos].filter(filtrar).sort((a, b) => b.programadoMs - a.programadoMs).slice(0, 30);

  const tarjeta = (r) => {
    const [txt, clase] = ESTADOS[r.estado] || [r.estado, "info"];
    return h("li", { class: `item asis ${["incompleto", "no_iniciado"].includes(r.estado) ? "alerta-borde" : ""}` },
      h("div", { class: "item-info" },
        h("strong", {}, `${hora(r.programadoMs)} · ${r.guardiaNombre || "Guardia"}`),
        h("span", {}, h("span", { class: `etq ${clase}` }, txt), r.total ? h("span", { class: "etq info" }, `${r.hechos}/${r.total} · ${r.porcentaje}%`) : null, r.prueba ? h("span", { class: "etq prueba" }, "PRUEBA") : null),
        r.saltados?.length ? h("span", { class: "sub" }, `Punto(s) saltado(s): ${r.saltados.join(", ")}`) : null,
        r.justificadoPor ? h("span", { class: "sub" }, `Justificado por ${r.justificadoPor}: ${r.justificadoMotivo}`) : null,
        h("ul", { class: "puntos-detalle" }, (r.detalle || []).map((d) => h("li", { class: d.hecho ? "hecho" : "falta" },
          h("span", {}, `${d.hecho ? "✔" : "✖"} ${d.nombre}`),
          h("span", { class: "sub" }, d.hecho ? ` ${hora(d.tsMs)}${d.origen === "ajuste" ? ` · ajuste de ${d.ajustePor}: ${d.ajusteMotivo}` : ""}${d.distanciaM != null ? ` · a ${Math.round(d.distanciaM)} m` : ""}${d.nota ? ` · «${d.nota}»` : ""}` : " no registrado"),
          d.hecho && d.foto ? h("button", { class: "btn chico secundario", type: "button", onclick: () => verFoto(r, d) }, "Foto") : null,
          !d.hecho && !["justificado", "programado", "pendiente"].includes(r.estado) ? h("button", { class: "btn chico secundario", type: "button", onclick: () => formAjuste(r, "marcar_punto", d) }, "Marcar realizado") : null)))),
      h("div", { class: "item-acc" },
        ["incompleto", "no_iniciado"].includes(r.estado) ? h("button", { class: "btn chico secundario", type: "button", onclick: () => formAjuste(r, "justificar_rondin") }, "Justificar rondín") : null));
  };

  const desde = h("input", { type: "date", value: sumarDias(fecha, -6), "aria-label": "Desde" });
  const hasta = h("input", { type: "date", value: fecha, "aria-label": "Hasta" });
  const exportar = h("button", { class: "btn chico secundario", type: "button", onclick: async (e) => {
    const q = new URLSearchParams({ desde: desde.value, hasta: hasta.value, ...(sitioId ? { sitioId } : {}) });
    const r = await accion(e.currentTarget, () => api(`/reportes/rondines?${q}`, { method: "GET" }));
    if (!r) return;
    if (!r.filas.length) return toast("No hay rondines en ese periodo.", "error");
    descargar(`rondines_${r.desde}_a_${r.hasta}.csv`, rondinesACsv(r.filas));
    toast(`CSV exportado: ${r.filas.length} rondín(es). Cumplimiento ${r.total.porcentaje ?? "—"}%.`);
  } }, "⬇ Exportar CSV");

  limpiar(raiz);
  poner(raiz,
    h("div", { class: "barra" }, h("h2", {}, "Rondines"), h("div", { class: "barra-acc" }, h("button", { class: "btn chico secundario", type: "button", onclick: () => recargar() }, "↻ Actualizar"))),
    h("div", { class: "filtros dos" },
      h("input", { type: "date", value: fecha, "aria-label": "Día", onchange: (e) => e.target.value && recargar({ fecha: e.target.value }) }),
      h("select", { value: sitioId, "aria-label": "Sitio", onchange: (e) => recargar({ sitioId: e.target.value }) }, h("option", { value: "" }, "Todos los sitios"), sitios.map((s) => h("option", { value: s.id }, s.nombre)))),
    alertas.length ? h("section", { class: "alerta-caja" }, h("h3", {}, `⚠ Alertas de rondines (${alertas.length})`),
      h("ul", { class: "lista" }, alertas.map((r) => h("li", { class: "item alerta-borde" }, h("div", { class: "item-info" },
        h("strong", {}, `${r.sitioNombre} · ${diaLargo(r.programadoMs)} ${hora(r.programadoMs)}`),
        h("span", { class: "sub" }, r.estado === "no_iniciado" ? `Rondín no iniciado (${r.guardiaNombre})` : `Incompleto (${r.guardiaNombre}): ${r.hechos}/${r.total}. Punto(s) saltado(s): ${(r.saltados || []).join(", ") || "—"}`)))))) : null,
    h("section", { class: "bloque" }, h("h3", {}, "Cumplimiento del día"),
      porSitio.size ? h("div", { class: "cumpl" }, [...porSitio.entries()].map(([nombre, rs]) => { const c = cumplimiento(rs); return h("div", { class: "cumpl-item" }, h("strong", {}, nombre),
        h("span", { class: `cumpl-pct ${c.porcentaje === null ? "" : c.porcentaje >= 90 ? "ok" : c.porcentaje >= 60 ? "medio" : "mal"}` }, c.porcentaje === null ? "—" : `${c.porcentaje}%`), h("span", { class: "sub" }, `${c.completos} de ${c.exigibles} rondines exigibles completos`)); }))
        : h("p", { class: "vacio" }, "No hay rondines programados este día.")),
    [...porSitio.entries()].map(([nombre, rs]) => h("section", { class: "bloque" }, h("h3", {}, `${nombre} · ${diaLargo(localAMs(fecha, "12:00"))}`), h("ul", { class: "lista" }, rs.map(tarjeta)))),
    h("section", { class: "tarjeta" }, h("h3", {}, "Exportar periodo"), h("div", { class: "dos" }, campo("Desde", desde), campo("Hasta", hasta)), exportar,
      h("p", { class: "ayuda" }, "El CSV neutraliza fórmulas de hoja de cálculo. Respeta el filtro de sitio. Horario de Hermosillo.")));

  async function verFoto(r, d) {
    const cont = h("div", { class: "selfie-caja" }, h("p", { class: "vacio" }, "Cargando foto…"));
    modal(`Foto · ${d.nombre}`, cont);
    try {
      const blob = await api.blob(`/rondines/foto?escaneo=${encodeURIComponent(`${r.rondinId}_${d.puntoId}`)}`);
      limpiar(cont);
      poner(cont, h("img", { class: "selfie sin-espejo", src: URL.createObjectURL(blob), alt: `Foto de ${d.nombre}` }), h("p", { class: "sub" }, `${r.guardiaNombre} · ${hora(d.tsMs)} (hora del servidor)`));
    } catch (e) { limpiar(cont); poner(cont, h("p", { class: "error" }, e.message)); }
  }

  function formAjuste(r, tipo, d) {
    const motivo = h("textarea", { rows: 3, maxlength: 300, required: true, placeholder: "Motivo (obligatorio)" });
    const f = h("form", { class: "form", novalidate: true },
      h("p", {}, tipo === "marcar_punto" ? `Marcar «${d.nombre}» como realizado en el rondín de las ${hora(r.programadoMs)} (${r.guardiaNombre}).` : `Justificar el rondín de las ${hora(r.programadoMs)} (${r.guardiaNombre}); dejará de contar contra el cumplimiento.`),
      campo("Motivo", motivo, "Queda registrado con tu nombre. El registro original no se modifica."), h("button", { class: "btn primario", type: "submit" }, "Registrar ajuste"));
    const m = modal("Ajuste de rondín", f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const ok = await accion(f.querySelector("button"), () => api("/rondines/ajuste", { body: { rondinId: r.rondinId, tipo, ...(d ? { puntoId: d.puntoId } : {}), motivo: motivo.value } }), "Ajuste registrado.");
      if (ok) { m.cerrar(); recargar(); }
    });
  }
}
