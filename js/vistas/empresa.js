// Configuración de empresa (solo admin): reglas de asistencia y límites de horas extra por año.
import { doc, getDoc } from "../vendor/firebase.js";
import { accion, campo, h, limpiar, poner } from "../ui.js";

const TIPOS_DEFECTO = [["acceso_no_autorizado", "Acceso no autorizado"], ["robo", "Robo"], ["danio", "Daño"], ["falla_electrica", "Falla eléctrica"], ["falla_equipo", "Falla de equipo"], ["persona_sospechosa", "Persona sospechosa"], ["otro", "Otro"]].map(([id, nombre]) => ({ id, nombre, activo: true }));

const DEFECTO = {
  retencionVisitantesDias: 90, offlineMaxHoras: 12,
  toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3, ventanaEntradaMin: 30, toleranciaRelevoMin: 30,
  limitesExtraPorAnio: [{ anio: 2026, horasSemana: 9 }, { anio: 2027, horasSemana: 12 }],
};

export async function vistaEmpresa(raiz, { db, api }) {
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando…"));
  const snap = await getDoc(doc(db, "configuracion", "empresa"));
  const c = { ...DEFECTO, ...(snap.exists() ? snap.data() : {}) };
  const catSnap = await getDoc(doc(db, "configuracion", "catalogos"));
  const tipos = catSnap.exists() && Array.isArray(catSnap.data().tiposIncidencia) && catSnap.data().tiposIncidencia.length ? catSnap.data().tiposIncidencia : TIPOS_DEFECTO;

  const num = (valor, min, max) => h("input", { type: "number", min, max, step: 1, value: valor, required: true });
  const tol = num(c.toleranciaRetardoMin, 0, 120);
  const lim = num(c.limiteFaltaMin, 1, 480);
  const retd = num(c.retardosPorFalta, 1, 20);
  const ven = num(c.ventanaEntradaMin, 0, 240);
  const rel = num(c.toleranciaRelevoMin, 0, 240);
  const ret = h("input", { type: "number", min: 7, max: 1825, step: 1, value: c.retencionVisitantesDias, required: true });
  const offH = h("input", { type: "number", min: 1, max: 72, step: 1, value: c.offlineMaxHoras, required: true });

  const filasLim = h("div", { class: "limites" });
  const agregarFila = (anio = "", horas = "") => {
    const a = h("input", { type: "number", min: 2020, max: 2100, step: 1, value: anio, "aria-label": "Año", placeholder: "Año" });
    const hs = h("input", { type: "number", min: 1, max: 60, step: 1, value: horas, "aria-label": "Horas por semana", placeholder: "Horas/semana" });
    const fila = h("div", { class: "dos limite-fila" }, a, hs, h("button", { class: "btn-icono", type: "button", "aria-label": "Quitar", onclick: () => fila.remove() }, "✕"));
    fila._valores = () => ({ anio: Number(a.value), horasSemana: Number(hs.value) });
    filasLim.append(fila);
  };
  (c.limitesExtraPorAnio || []).forEach((x) => agregarFila(x.anio, x.horasSemana));

  const f = h("form", { class: "form tarjeta", novalidate: true },
    h("h3", {}, "Entrada y retardos"),
    campo("Ventana de entrada (minutos antes del inicio)", ven, "El guardia puede marcar entrada desde esta cantidad de minutos antes de su turno."),
    campo("Tolerancia de retardo (minutos)", tol, "Hasta cuántos minutos después de la hora de entrada no cuenta como retardo."),
    campo("Límite de falta (minutos)", lim, "Si la entrada pasa de este tiempo (o no se marca), el turno cuenta como falta. Debe ser mayor que la tolerancia."),
    campo("Retardos que equivalen a 1 falta", retd),
    h("h3", {}, "Relevo"),
    campo("Tolerancia de relevo (minutos)", rel, "Si el relevo no marca entrada al fin del turno + esta tolerancia, se alerta al supervisor y corre el tiempo extra del saliente."),
    h("h3", {}, "Registros sin conexión"),
    campo("Antigüedad máxima aceptada (horas)", offH, "Un registro que el celular guardó sin internet y llega con más antigüedad que esto se rechaza (por defecto 12). El supervisor revisa los que sí llegan."),
    h("h3", {}, "Visitantes"),
    campo("Retención de registros y fotos de visitantes (días)", ret, "Pasado este tiempo se borran automáticamente (por defecto 90; de 7 a 1825). No se guardan identificaciones."),
    h("h3", {}, "Límite legal de horas extra dobles por semana"),
    h("p", { class: "ayuda" }, "Configurable por año (hoy 9 h; la reforma de 2027 lo cambia a 12 h). Para un año sin valor propio se usa el del año anterior más reciente."),
    filasLim,
    h("button", { class: "btn chico secundario", type: "button", onclick: () => agregarFila() }, "+ Agregar año"),
    h("p", { class: "ayuda" }, "Zona horaria fija: America/Hermosillo (UTC-7, sin horario de verano). El pago de horas extra se calcula en una fase posterior."),
    h("button", { class: "btn primario", type: "submit" }, "Guardar configuración"));
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    await accion(f.querySelector("button[type=submit]"), () => api("/admin/config", { body: {
      toleranciaRetardoMin: Number(tol.value), limiteFaltaMin: Number(lim.value), retardosPorFalta: Number(retd.value), retencionVisitantesDias: Number(ret.value), offlineMaxHoras: Number(offH.value),
      ventanaEntradaMin: Number(ven.value), toleranciaRelevoMin: Number(rel.value),
      limitesExtraPorAnio: [...filasLim.children].map((x) => x._valores()).filter((x) => x.anio || x.horasSemana),
    } }), "Configuración guardada.");
  });
  // Catálogo de tipos de incidencia (se agregan, renombran o desactivan; nunca se eliminan)
  const filasTipos = h("div", { class: "limites" });
  const filaTipo = (t) => {
    const nombre = h("input", { type: "text", maxlength: 60, value: t.nombre, "aria-label": "Nombre del tipo", required: true });
    const activo = h("input", { type: "checkbox", checked: t.activo !== false, "aria-label": "Activo" });
    const fila = h("div", { class: "tipo-fila" }, nombre, h("label", { class: "check" }, activo, " Activo"));
    fila._valor = () => ({ ...(t.id ? { id: t.id } : {}), nombre: nombre.value, activo: activo.checked });
    filasTipos.append(fila);
  };
  tipos.forEach(filaTipo);
  const fTipos = h("form", { class: "form tarjeta", novalidate: true },
    h("h3", {}, "Tipos de incidencia"),
    h("p", { class: "ayuda" }, "Catálogo que ve el guardia al reportar. Los tipos no se eliminan (los reportes históricos los usan): desactívalos."),
    filasTipos, h("button", { class: "btn chico secundario", type: "button", onclick: () => filaTipo({ nombre: "", activo: true }) }, "+ Agregar tipo"),
    h("button", { class: "btn primario", type: "submit" }, "Guardar tipos de incidencia"));
  fTipos.addEventListener("submit", async (e) => {
    e.preventDefault();
    await accion(fTipos.querySelector("button[type=submit]"), () => api("/admin/catalogo-incidencias", { body: { tipos: [...filasTipos.children].map((x) => x._valor()) } }), "Catálogo guardado.");
  });
  limpiar(raiz);
  poner(raiz, h("div", { class: "barra" }, h("h2", {}, "Configuración de empresa")), f, fTipos);
}
