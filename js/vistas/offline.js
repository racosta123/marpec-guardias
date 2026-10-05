// Registros capturados SIN CONEXIÓN (supervisor: sus sitios; admin: todos): el supervisor los acepta o los ajusta con motivo.
// Muestra las tres horas que guarda el servidor: la ESTIMADA (la que cuenta), la del dispositivo y la de recepción.
import { collection, getDocs, limit, orderBy, query, where } from "../vendor/firebase.js";
import { accion, campo, h, limpiar, modal, poner, toast } from "../ui.js";
import { fechaHora, fechaLocal, hora, localAMs } from "../tz.js";

const ETIQUETA = { entrada: "🟢 Entrada", salida: "🔴 Salida", rondin: "🔁 Rondín", incidencia: "⚠️ Incidencia", novedad: "📝 Novedad", visitante_entrada: "🚶 Entrada de visitante", visitante_salida: "↩️ Salida de visitante", panico: "🆘 Pánico" };
const ESTADO = { pendiente: ["Por revisar", "info"], aceptado: ["Aceptado", "ok"], ajustado: ["Ajustado", "prueba"] };

export async function vistaOffline(raiz, ctx) {
  const { db, api, user } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando registros sin conexión…"));
  const col = collection(db, "offlineVista");
  const q = user.rol === "admin" ? query(col, orderBy("tsMs", "desc"), limit(100)) : query(col, where("supervisorUid", "==", user.uid), orderBy("tsMs", "desc"), limit(100));
  const filas = (await getDocs(q)).docs.map((d) => ({ id: d.id, ...d.data() }));
  const pend = filas.filter((x) => x.estadoRevision === "pendiente");
  const resto = filas.filter((x) => x.estadoRevision !== "pendiente");
  const recargar = () => vistaOffline(raiz, ctx);

  const fila = (x) => {
    const [txt, cls] = ESTADO[x.estadoRevision] || [x.estadoRevision, "info"];
    return h("li", { class: "item" },
      h("div", { class: "item-info" },
        h("strong", {}, `${ETIQUETA[x.tipo] || x.tipo} · ${x.guardiaNombre}`),
        h("span", { class: "sub" }, `${x.sitioNombre} · hora estimada ${fechaHora(x.tsMs)}`),
        h("span", { class: "sub" }, `Reloj del celular ${hora(x.horaDispositivoMs)} · recibido ${fechaHora(x.recibidoMs)} (${Math.max(0, Math.round((x.recibidoMs - x.tsMs) / 60000))} min después)`),
        x.estadoRevision !== "pendiente" ? h("span", { class: "sub" }, `${txt} por ${x.revisionPorNombre}${x.revisionMotivo ? `: ${x.revisionMotivo}` : ""}${x.horaAjustadaMs ? ` · hora ajustada ${fechaHora(x.horaAjustadaMs)}` : ""}`) : null),
      h("div", { class: "item-acc" },
        h("span", { class: `etq ${cls}` }, txt), x.prueba ? h("span", { class: "etq prueba" }, "PRUEBA") : null,
        x.estadoRevision === "pendiente" ? [
          h("button", { class: "btn chico primario", type: "button", onclick: () => revisar(x, "aceptar") }, "Aceptar"),
          h("button", { class: "btn chico secundario", type: "button", onclick: () => revisar(x, "ajustar") }, "Ajustar")] : null));
  };

  function revisar(x, acc) {
    const motivo = h("textarea", { rows: 3, maxlength: 300, required: acc === "ajustar", placeholder: acc === "ajustar" ? "Motivo del ajuste (obligatorio)" : "Nota (opcional)" });
    const fecha = h("input", { type: "date", value: fechaLocal(x.tsMs), required: true });
    const hh = h("input", { type: "time", value: hora(x.tsMs), required: true });
    const f = h("form", { class: "form", novalidate: true },
      h("p", {}, `${ETIQUETA[x.tipo] || x.tipo} de ${x.guardiaNombre}. Hora estimada: ${fechaHora(x.tsMs)}.`),
      acc === "ajustar" ? [campo("Fecha (Hermosillo)", fecha), campo("Hora real", hh),
        h("p", { class: "ayuda" }, x.tipo === "entrada" || x.tipo === "salida" ? "La hora ajustada pasa a la asistencia como un ajuste normal (con tu nombre y el motivo); la marca original no se modifica." : "El registro original no se modifica: el ajuste queda anotado con tu nombre, la hora y el motivo.")] : null,
      campo(acc === "ajustar" ? "Motivo" : "Nota", motivo),
      h("button", { class: "btn primario", type: "submit" }, acc === "ajustar" ? "Guardar ajuste" : "Aceptar registro"));
    const m = modal(acc === "ajustar" ? "Ajustar registro sin conexión" : "Aceptar registro sin conexión", f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (acc === "ajustar" && motivo.value.trim().length < 5) return toast("Escribe el motivo del ajuste (mínimo 5 caracteres).", "error");
      const body = { registroId: x.id, accion: acc, motivo: motivo.value, ...(acc === "ajustar" ? { horaAjustadaMs: localAMs(fecha.value, hh.value) } : {}) };
      const r = await accion(f.querySelector("button[type=submit]"), () => api("/offline/revisar", { body }), acc === "ajustar" ? "Ajuste guardado." : "Registro aceptado.");
      if (r) { m.cerrar(); recargar(); }
    });
  }

  limpiar(raiz);
  poner(raiz,
    h("div", { class: "barra" }, h("h2", {}, "Registros sin conexión"), h("div", { class: "barra-acc" }, h("button", { class: "btn chico secundario", type: "button", onclick: recargar }, "↻ Actualizar"))),
    h("p", { class: "ayuda" }, "El guardia los capturó sin internet y llegaron después. El servidor ya los validó (QR, ubicación, turno, fotos) con la hora estimada del celular; tú decides si los aceptas o ajustas la hora con un motivo."),
    h("section", { class: "bloque" }, h("h3", {}, `Por revisar (${pend.length})`), pend.length ? h("ul", { class: "lista" }, pend.map(fila)) : h("p", { class: "vacio" }, "No hay registros por revisar.")),
    resto.length ? h("section", { class: "bloque" }, h("h3", {}, "Revisados"), h("ul", { class: "lista" }, resto.map(fila))) : null);
}
