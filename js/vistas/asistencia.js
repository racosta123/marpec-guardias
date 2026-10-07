// Asistencia del día por sitio (supervisor: sus sitios; admin: todos): retardos, faltas, extras por
// autorizar, alertas de relevo, ajustes con motivo y selfies de cada marca.
import { collection, getDocs, orderBy, query, where } from "../vendor/firebase.js";
import { accion, campo, h, limpiar, modal, poner, toast } from "../ui.js";
import { diaLargo, fechaHora, hora, hoy, localAMs, sumarDias } from "../tz.js";
import { cargarSitios } from "./sitios.js";
import { avatar, cabeceraPagina, etiqueta, fila as tfila, indicador, indicadores, tabla, tarjetaFiltros, vacioCompacto } from "../tabla.js";

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
  poner(raiz, vacioCompacto("Cargando asistencia…", "", "reloj"));
  const fecha = estado.fecha || hoy();
  const sitios = await cargarSitios(ctx);
  const sitioId = estado.sitioId || "";
  // Refresca resultados (alertas de relevo, extras en curso) antes de leer
  await api("/asistencia/recalcular", { body: { desde: sumarDias(fecha, -1), hasta: fecha } }).catch(() => {});
  const [dia, relevos, extras] = await Promise.all([cargarDia(ctx, fecha), cargarPorEstado(ctx, "relevoAlerta", true), cargarPorEstado(ctx, "extraEstado", "pendiente")]);
  const recargar = (e = {}) => vistaAsistencia(raiz, ctx, { fecha, sitioId, ...e });
  const filtrar = (x) => !sitioId || x.sitioId === sitioId;

  // Tira de color: rojo = falta o relevo que no llegó; ámbar = retardo; verde = en turno/cumplido; azul = pendiente.
  const fila = (a) => {
    const [txt, clase] = ESTADOS[a.estado] || [a.estado, "info"];
    const critica = a.estado === "falta" || a.estado === "relevo_no_llego";
    const detalles = [
      a.entradaDistanciaM != null ? `Entrada a ${Math.round(a.entradaDistanciaM)} m del sitio (±${Math.round(a.entradaPrecisionM)} m)` : null,
      a.cierreAutorizadoPor ? `Cierre sin relevo autorizado por ${a.cierreAutorizadoPor}: ${a.cierreMotivo}` : null,
      a.extraResueltoPor ? `Extra ${a.extraEstado} por ${a.extraResueltoPor}: ${a.extraMotivo}` : null,
      a.notasEntrega ? `Notas de entrega: ${a.notasEntrega}` : null,
    ].filter(Boolean);
    return tfila({
      tira: critica ? "mal" : a.retardo ? "ambar" : clase === "mal" ? "mal" : clase === "ok" ? "ok" : "info",
      extra: critica ? "alerta-borde" : "",
      celdas: [
        { et: "Guardia", cls: "c-nombre", nodos: [avatar(a.guardiaNombre), h("div", {}, h("strong", {}, a.guardiaNombre || "Guardia"), h("span", { class: "sub" }, `${hora(a.inicioMs)}–${hora(a.finMs)}`))] },
        { et: "Entrada", cls: "c-hora", nodos: a.entradaMs ? hora(a.entradaMs) : "—" },
        { et: "Salida", cls: "c-hora", nodos: a.salidaMs ? hora(a.salidaMs) : "—" },
        { et: "Estado", cls: "c-estado", nodos: [etiqueta(txt, clase),
          a.retardo ? etiqueta(`Retardo ${a.retardoMin} min`, "prueba") : null,
          a.minutosExtra > 0 ? etiqueta(`Extra ${a.minutosExtra} min · ${EXTRA[a.extraEstado] || ""}${a.extraEnCurso ? " (en curso)" : ""}`, "info") : null,
          a.ajustes ? etiqueta(`${a.ajustes} ajuste(s)`, "prueba") : null,
          a.prueba ? etiqueta("PRUEBA", "prueba") : null] },
        { cls: "c-acc", nodos: [
          a.fotoEntrada ? h("button", { class: "btn chico secundario", type: "button", onclick: () => verSelfie(a, "entrada") }, "Selfie entrada") : null,
          a.fotoSalida ? h("button", { class: "btn chico secundario", type: "button", onclick: () => verSelfie(a, "salida") }, "Selfie salida") : null,
          h("button", { class: "btn chico secundario", type: "button", onclick: () => formAjuste(a) }, "Ajuste")] },
      ],
      detalle: detalles.length ? detalles.map((d) => h("span", { class: "sub" }, d)) : null,
    });
  };

  const porSitio = new Map();
  for (const a of dia.filter(filtrar)) porSitio.set(a.sitioNombre, [...(porSitio.get(a.sitioNombre) || []), a]);
  const faltas = dia.filter(filtrar).filter((a) => a.falta).length;
  const retardos = dia.filter(filtrar).filter((a) => a.retardo).length;

  const delDia = dia.filter(filtrar);
  const enTurno = delDia.filter((a) => a.estado === "en_turno").length;
  const COLS = [{ t: "Guardia" }, { t: "Entrada" }, { t: "Salida" }, { t: "Estado" }, { t: "" }];
  limpiar(raiz);
  poner(raiz,
    cabeceraPagina("Asistencia", `${diaLargo(localAMs(fecha, "12:00"))}: ${delDia.length} turno(s) con guardia · ${retardos} retardo(s) · ${faltas} falta(s)`,
      h("button", { class: "btn chico secundario", type: "button", onclick: () => recargar() }, "↻ Actualizar")),
    indicadores(indicador("azul", "turnos", delDia.length, "Turnos con guardia"), indicador("verde", "envivo", enTurno, "En turno ahora"),
      indicador("ambar", "reloj", retardos, "Retardos"), indicador("rojo", "incidencias", faltas, "Faltas")),
    tarjetaFiltros("filtros-asistencia",
      campo("Día", h("input", { type: "date", value: fecha, "aria-label": "Día", onchange: (e) => e.target.value && recargar({ fecha: e.target.value }) })),
      campo("Sitio", h("select", { value: sitioId, "aria-label": "Sitio", onchange: (e) => recargar({ sitioId: e.target.value }) },
        h("option", { value: "" }, "Todos los sitios"), sitios.map((s) => h("option", { value: s.id }, s.nombre)))),
      h("button", { class: "btn chico secundario", type: "button", onclick: () => recargar({ fecha: hoy(), sitioId: "" }) }, "Limpiar")),
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
    porSitio.size ? [...porSitio.entries()].map(([sitio, filas]) => h("section", { class: "tcard2" },
      h("header", {}, h("h3", {}, sitio), h("span", { class: "cuenta" }, `${filas.length} turno(s)`)), tabla("tabla-asistencia", COLS, filas.map(fila))))
      : vacioCompacto("No hay turnos con guardia asignado este día.", "Cambia el día o el sitio para ver otros turnos.", "turnos"),
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
