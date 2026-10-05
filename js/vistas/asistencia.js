// Asistencia del día por sitio (supervisor: sus sitios; admin: todos): retardos, faltas, extras por
// autorizar, alertas de relevo, ajustes con motivo y selfies de cada marca.
import { collection, getDocs, orderBy, query, where } from "../vendor/firebase.js";
import { accion, campo, h, limpiar, modal, poner, toast } from "../ui.js";
import { diaLargo, fechaHora, hora, hoy, localAMs, sumarDias } from "../tz.js";
import { cargarSitios } from "./sitios.js";

const ESTADOS = {
  programado: ["Programado", "info"], por_marcar: ["Por marcar", "info"], falta: ["FALTA", "mal"], en_turno: ["En turno", "ok"],
  salida_pendiente: ["Salida pendiente", "info"], relevo_no_llego: ["RELEVO NO LLEGÓ", "mal"], cumplido: ["Cumplido", "ok"],
};
const EXTRA = { pendiente: "pendiente de autorizar", autorizado: "autorizado", rechazado: "rechazado" };

async function cargarDia(ctx, fecha) {
  const { db, user } = ctx;
  const col = collection(db, "asistencias");
  const rol = user.rol === "admin" ? [] : [where("supervisorUid", "==", user.uid)];
  const d0 = localAMs(fecha), d1 = localAMs(sumarDias(fecha, 1));
  const s = await getDocs(query(col, ...rol, where("inicioMs", ">=", d0), where("inicioMs", "<", d1), orderBy("inicioMs")));
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}
async function cargarPorEstado(ctx, campoFiltro, valor) {
  const { db, user } = ctx;
  const filtros = [where(campoFiltro, "==", valor)];
  if (user.rol !== "admin") filtros.push(where("supervisorUid", "==", user.uid));
  const s = await getDocs(query(collection(db, "asistencias"), ...filtros));
  return s.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.inicioMs - b.inicioMs);
}

export async function vistaAsistencia(raiz, ctx, estado = {}) {
  const { api } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando asistencia…"));
  const fecha = estado.fecha || hoy();
  const sitios = await cargarSitios(ctx);
  const sitioId = estado.sitioId || "";
  // Refresca resultados (alertas de relevo, extras en curso) antes de leer
  await api("/asistencia/recalcular", { body: { desde: sumarDias(fecha, -1), hasta: fecha } }).catch(() => {});
  const [dia, relevos, extras] = await Promise.all([cargarDia(ctx, fecha), cargarPorEstado(ctx, "relevoAlerta", true), cargarPorEstado(ctx, "extraEstado", "pendiente")]);
  const recargar = (e = {}) => vistaAsistencia(raiz, ctx, { fecha, sitioId, ...e });
  const filtrar = (x) => !sitioId || x.sitioId === sitioId;

  const fila = (a) => {
    const [txt, clase] = ESTADOS[a.estado] || [a.estado, "info"];
    return h("li", { class: `item asis ${a.estado === "falta" || a.estado === "relevo_no_llego" ? "alerta-borde" : ""}` },
      h("div", { class: "item-info" },
        h("strong", {}, a.guardiaNombre || "Guardia"),
        h("span", { class: "sub" }, `${hora(a.inicioMs)}–${hora(a.finMs)} · ${a.sitioNombre}`),
        h("span", {}, h("span", { class: `etq ${clase}` }, txt),
          a.retardo ? h("span", { class: "etq prueba" }, `Retardo ${a.retardoMin} min`) : null,
          a.minutosExtra > 0 ? h("span", { class: "etq info" }, `Extra ${a.minutosExtra} min · ${EXTRA[a.extraEstado] || ""}${a.extraEnCurso ? " (en curso)" : ""}`) : null,
          a.ajustes ? h("span", { class: "etq prueba" }, `${a.ajustes} ajuste(s)`) : null,
          a.prueba ? h("span", { class: "etq prueba" }, "PRUEBA") : null),
        h("span", { class: "sub" }, `Entrada: ${a.entradaMs ? hora(a.entradaMs) : "—"} · Salida: ${a.salidaMs ? hora(a.salidaMs) : "—"}`
          + (a.entradaDistanciaM != null ? ` · a ${Math.round(a.entradaDistanciaM)} m (±${Math.round(a.entradaPrecisionM)} m)` : "")),
        a.cierreAutorizadoPor ? h("span", { class: "sub" }, `Cierre sin relevo autorizado por ${a.cierreAutorizadoPor}: ${a.cierreMotivo}`) : null,
        a.extraResueltoPor ? h("span", { class: "sub" }, `Extra ${a.extraEstado} por ${a.extraResueltoPor}: ${a.extraMotivo}`) : null,
        a.notasEntrega ? h("span", { class: "sub" }, `Notas de entrega: ${a.notasEntrega}`) : null),
      h("div", { class: "item-acc" },
        a.fotoEntrada ? h("button", { class: "btn chico secundario", type: "button", onclick: () => verSelfie(a, "entrada") }, "Selfie entrada") : null,
        a.fotoSalida ? h("button", { class: "btn chico secundario", type: "button", onclick: () => verSelfie(a, "salida") }, "Selfie salida") : null,
        h("button", { class: "btn chico secundario", type: "button", onclick: () => formAjuste(a) }, "Ajuste")));
  };

  const porSitio = new Map();
  for (const a of dia.filter(filtrar)) porSitio.set(a.sitioNombre, [...(porSitio.get(a.sitioNombre) || []), a]);
  const faltas = dia.filter(filtrar).filter((a) => a.falta).length;
  const retardos = dia.filter(filtrar).filter((a) => a.retardo).length;

  limpiar(raiz);
  poner(raiz,
    h("div", { class: "barra" }, h("h2", {}, "Asistencia"),
      h("div", { class: "barra-acc" }, h("button", { class: "btn chico secundario", type: "button", onclick: () => recargar() }, "↻ Actualizar"))),
    h("div", { class: "filtros dos" },
      h("input", { type: "date", value: fecha, "aria-label": "Día", onchange: (e) => e.target.value && recargar({ fecha: e.target.value }) }),
      h("select", { value: sitioId, "aria-label": "Sitio", onchange: (e) => recargar({ sitioId: e.target.value }) },
        h("option", { value: "" }, "Todos los sitios"), sitios.map((s) => h("option", { value: s.id }, s.nombre)))),
    relevos.filter(filtrar).length ? h("section", { class: "alerta-caja" }, h("h3", {}, "⚠ Relevo no llegó"),
      h("ul", { class: "lista" }, relevos.filter(filtrar).map((a) => h("li", { class: "item alerta-borde" },
        h("div", { class: "item-info" }, h("strong", {}, `${a.sitioNombre}: ${a.guardiaNombre} sigue en el puesto`),
          h("span", { class: "sub" }, `Turno ${hora(a.inicioMs)}–${hora(a.finMs)} · tiempo extra corriendo: ${a.minutosExtra} min`)),
        h("div", { class: "item-acc" }, h("button", { class: "btn chico peligro", type: "button", onclick: () => formCierre(a) }, "Autorizar cierre sin relevo")))))) : null,
    extras.filter(filtrar).length ? h("section", { class: "bloque" }, h("h3", {}, `Horas extra por autorizar (${extras.filter(filtrar).length})`),
      h("ul", { class: "lista" }, extras.filter(filtrar).map((a) => h("li", { class: "item" },
        h("div", { class: "item-info" }, h("strong", {}, `${a.guardiaNombre} · ${a.minutosExtra} min`),
          h("span", { class: "sub" }, `${diaLargo(a.inicioMs)} · ${a.sitioNombre}${a.extraEnCurso ? " · aún en el puesto" : ""}`)),
        h("div", { class: "item-acc" },
          h("button", { class: "btn chico primario", type: "button", disabled: a.extraEnCurso, onclick: () => formExtra(a, "autorizado") }, "Autorizar"),
          h("button", { class: "btn chico peligro", type: "button", disabled: a.extraEnCurso, onclick: () => formExtra(a, "rechazado") }, "Rechazar")))))) : null,
    h("p", { class: "resumen-dia" }, `${diaLargo(localAMs(fecha, "12:00"))}: ${dia.filter(filtrar).length} turno(s) con guardia · ${retardos} retardo(s) · ${faltas} falta(s)`),
    porSitio.size ? [...porSitio.entries()].map(([sitio, filas]) => h("section", { class: "bloque" }, h("h3", {}, sitio), h("ul", { class: "lista" }, filas.map(fila))))
      : h("p", { class: "vacio" }, "No hay turnos con guardia asignado este día."),
    h("p", { class: "ayuda" }, "Las marcas nunca se editan: una corrección es un ajuste con motivo y tu nombre. Horario de Hermosillo."));

  // ---------- selfies ----------
  async function verSelfie(a, tipo) {
    const cont = h("div", { class: "selfie-caja" }, h("p", { class: "vacio" }, "Cargando foto…"));
    modal(`Selfie de ${tipo} · ${a.guardiaNombre}`, cont);
    try {
      const blob = await api.blob(`/selfies?marca=${encodeURIComponent(`${a.id}_${tipo}`)}`);
      const url = URL.createObjectURL(blob);
      limpiar(cont);
      poner(cont, h("img", { class: "selfie", src: url, alt: `Selfie de ${tipo}` }),
        h("p", { class: "sub" }, `${a.guardiaNombre} · ${tipo === "entrada" ? hora(a.entradaOriginalMs ?? a.entradaMs) : hora(a.salidaOriginalMs ?? a.salidaMs)} (hora del servidor)`));
    } catch (e) { limpiar(cont); poner(cont, h("p", { class: "error" }, e.message)); }
  }

  // ---------- ajuste ----------
  function formAjuste(a) {
    const tipo = h("select", { value: a.entradaMs ? "salida" : "entrada" }, h("option", { value: "entrada" }, "Entrada"), h("option", { value: "salida" }, "Salida"));
    const f0 = a.fecha;
    const fecha = h("input", { type: "date", value: f0, required: true });
    const hr = h("input", { type: "time", value: "07:00", required: true });
    const motivo = h("textarea", { rows: 3, maxlength: 300, required: true, placeholder: "Por qué se corrige (obligatorio)" });
    const f = h("form", { class: "form", novalidate: true },
      h("p", {}, `${a.guardiaNombre} · ${a.sitioNombre} · ${hora(a.inicioMs)}–${hora(a.finMs)}`),
      campo("Qué se corrige", tipo), h("div", { class: "dos" }, campo("Fecha", fecha), campo("Hora (Hermosillo)", hr)),
      campo("Motivo", motivo, "Queda registrado con tu nombre. La marca original no se modifica."),
      h("button", { class: "btn primario", type: "submit" }, "Registrar ajuste"));
    const m = modal("Ajuste de asistencia", f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await accion(f.querySelector("button"), () => api("/ajustes", { body: { turnoId: a.id, tipo: tipo.value, fecha: fecha.value, hora: hr.value, motivo: motivo.value } }), "Ajuste registrado.");
      if (r) { m.cerrar(); recargar(); }
    });
  }

  // ---------- decisiones ----------
  function pedirMotivo(titulo, resumen, etiquetaBoton, peligro, enviar) {
    const motivo = h("textarea", { rows: 3, maxlength: 300, required: true, placeholder: "Motivo (obligatorio)" });
    const f = h("form", { class: "form", novalidate: true }, h("p", {}, resumen), campo("Motivo", motivo, "Queda registrado con tu nombre."),
      h("button", { class: `btn ${peligro ? "peligro" : "primario"}`, type: "submit" }, etiquetaBoton));
    const m = modal(titulo, f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const r = await accion(f.querySelector("button"), () => enviar(motivo.value), "Registrado.");
      if (r) { m.cerrar(); recargar(); }
    });
  }
  const formCierre = (a) => pedirMotivo("Autorizar cierre sin relevo", `${a.guardiaNombre} podrá cerrar su turno aunque su relevo no haya llegado.`, "Autorizar cierre", true,
    (motivo) => api("/relevo/autorizar-cierre", { body: { turnoId: a.id, motivo } }));
  const formExtra = (a, decision) => pedirMotivo(decision === "autorizado" ? "Autorizar horas extra" : "Rechazar horas extra", `${a.guardiaNombre}: ${a.minutosExtra} min extra el ${diaLargo(a.inicioMs)}.`,
    decision === "autorizado" ? "Autorizar" : "Rechazar", decision !== "autorizado", (motivo) => api("/extras/resolver", { body: { turnoId: a.id, decision, motivo } }));
  void toast; void fechaHora;
}
