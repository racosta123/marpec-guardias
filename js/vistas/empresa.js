// Configuración de empresa (solo admin). En esta fase solo se guarda; la usa la Fase 3 (asistencia).
import { doc, getDoc } from "../vendor/firebase.js";
import { accion, campo, h, limpiar, poner } from "../ui.js";

export async function vistaEmpresa(raiz, { db, api }) {
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando…"));
  const snap = await getDoc(doc(db, "configuracion", "empresa"));
  const c = snap.exists() ? snap.data() : { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3 };

  const tol = h("input", { type: "number", min: 0, max: 120, step: 1, value: c.toleranciaRetardoMin, required: true });
  const lim = h("input", { type: "number", min: 1, max: 480, step: 1, value: c.limiteFaltaMin, required: true });
  const ret = h("input", { type: "number", min: 1, max: 20, step: 1, value: c.retardosPorFalta, required: true });
  const f = h("form", { class: "form tarjeta", novalidate: true },
    campo("Tolerancia de retardo (minutos)", tol, "Hasta cuántos minutos después de la hora de entrada no cuenta como retardo."),
    campo("Límite de falta (minutos)", lim, "Pasado este tiempo sin registrar entrada, el turno cuenta como falta. Debe ser mayor que la tolerancia."),
    campo("Retardos que equivalen a 1 falta", ret),
    h("p", { class: "ayuda" }, "Zona horaria fija: America/Hermosillo (UTC-7, sin horario de verano). Estos valores solo se guardan por ahora; se aplicarán en la fase de asistencia."),
    h("button", { class: "btn primario", type: "submit" }, "Guardar configuración"));
  f.addEventListener("submit", async (e) => {
    e.preventDefault();
    await accion(f.querySelector("button"), () => api("/admin/config", { body: {
      toleranciaRetardoMin: Number(tol.value), limiteFaltaMin: Number(lim.value), retardosPorFalta: Number(ret.value) } }), "Configuración guardada.");
  });
  limpiar(raiz);
  poner(raiz, h("div", { class: "barra" }, h("h2", {}, "Configuración de empresa")), f);
}
