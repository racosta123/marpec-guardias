// Configuración de empresa (solo admin): reglas de asistencia y límites de horas extra por año.
import { doc, getDoc } from "../vendor/firebase.js";
import { accion, campo, h, limpiar, poner } from "../ui.js";

const DEFECTO = {
  toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3, ventanaEntradaMin: 30, toleranciaRelevoMin: 30,
  limitesExtraPorAnio: [{ anio: 2026, horasSemana: 9 }, { anio: 2027, horasSemana: 12 }],
};

export async function vistaEmpresa(raiz, { db, api }) {
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando…"));
  const snap = await getDoc(doc(db, "configuracion", "empresa"));
  const c = { ...DEFECTO, ...(snap.exists() ? snap.data() : {}) };

  const num = (valor, min, max) => h("input", { type: "number", min, max, step: 1, value: valor, required: true });
  const tol = num(c.toleranciaRetardoMin, 0, 120);
  const lim = num(c.limiteFaltaMin, 1, 480);
  const ret = num(c.retardosPorFalta, 1, 20);
  const ven = num(c.ventanaEntradaMin, 0, 240);
  const rel = num(c.toleranciaRelevoMin, 0, 240);

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
    campo("Retardos que equivalen a 1 falta", ret),
    h("h3", {}, "Relevo"),
    campo("Tolerancia de relevo (minutos)", rel, "Si el relevo no marca entrada al fin del turno + esta tolerancia, se alerta al supervisor y corre el tiempo extra del saliente."),
    h("h3", {}, "Límite legal de horas extra dobles por semana"),
    h("p", { class: "ayuda" }, "Configurable por año (hoy 9 h; la reforma de 2027 lo cambia a 12 h). Para un año sin valor propio se usa el del año anterior más reciente."),
    filasLim,
    h("button", { class: "btn chico secundario", type: "button", onclick: () => agregarFila() }, "+ Agregar año"),
    h("p", { class: "ayuda" }, "Zona horaria fija: America/Hermosillo (UTC-7, sin horario de verano). El pago de horas extra se calcula en una fase posterior."),
    h("button", { class: "btn primario", type: "submit" }, "Guardar configuración"));
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    await accion(f.querySelector("button[type=submit]"), () => api("/admin/config", { body: {
      toleranciaRetardoMin: Number(tol.value), limiteFaltaMin: Number(lim.value), retardosPorFalta: Number(ret.value),
      ventanaEntradaMin: Number(ven.value), toleranciaRelevoMin: Number(rel.value),
      limitesExtraPorAnio: [...filasLim.children].map((x) => x._valores()).filter((x) => x.anio || x.horasSemana),
    } }), "Configuración guardada.");
  });
  limpiar(raiz);
  poner(raiz, h("div", { class: "barra" }, h("h2", {}, "Configuración de empresa")), f);
}
