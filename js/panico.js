// Botón de pánico del guardia: visible en TODAS sus pantallas. Se activa manteniéndolo presionado 3 segundos (con
// indicador de progreso) para evitar toques accidentales. Envía la hora del servidor (o, sin conexión, se guarda y se
// envía al volver la señal) y la ubicación si hay GPS. Sin conexión muestra además los botones para llamar al
// supervisor del sitio (teléfono de emergencia) y al 911.
import { pedirUbicacion } from "./camara.js";
import { enviarRegistro } from "./envio.js";
import { metaGet } from "./cola.js";
import { h, limpiar, poner } from "./ui.js";
import { hora } from "./tz.js";

export const MANTENER_MS = 3000;
let raizBoton = null;
let limpiarEventos = [];

export function montarPanico(contenedor, { getTurnoId = () => null } = {}) {
  desmontarPanico();
  const anillo = h("span", { class: "panico-anillo", "aria-hidden": "true" });
  const boton = h("button", { id: "btn-panico", class: "btn-panico", type: "button", "aria-label": "Botón de pánico: mantén presionado 3 segundos" },
    anillo, h("span", { class: "panico-sos" }, "SOS"), h("span", { class: "panico-txt" }, "Mantén 3 s"));
  contenedor.append(boton);
  raizBoton = boton;

  let inicio = null, raf = null, bloqueado = false;
  const progreso = (p) => { boton.style.setProperty("--p", String(p)); boton.classList.toggle("sostenido", p > 0); };
  const cancelar = () => { if (inicio === null) return; inicio = null; cancelAnimationFrame(raf); progreso(0); };
  const paso = () => {
    if (inicio === null) return;
    const t = performance.now() - inicio;
    progreso(Math.min(1, t / MANTENER_MS));
    if (t >= MANTENER_MS) { const mantenido = Math.round(t); cancelar(); disparar(mantenido); return; }
    raf = requestAnimationFrame(paso);
  };
  const empezar = (e) => {
    if (bloqueado || inicio !== null) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    e.preventDefault();
    inicio = performance.now();
    raf = requestAnimationFrame(paso);
  };
  boton.addEventListener("pointerdown", empezar);
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) boton.addEventListener(ev, cancelar);
  boton.addEventListener("contextmenu", (e) => e.preventDefault());
  // Teclado: mantener Espacio o Enter 3 segundos
  boton.addEventListener("keydown", (e) => { if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); empezar({ pointerType: "teclado", preventDefault() {} }); } });
  boton.addEventListener("keyup", (e) => { if (e.key === " " || e.key === "Enter") cancelar(); });
  boton.addEventListener("blur", cancelar);
  boton.addEventListener("click", (e) => e.preventDefault());

  async function disparar(mantenidoMs) {
    bloqueado = true;
    boton.classList.add("enviando");
    if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
    const panel = abrirPanel();
    try {
      let gps = null;
      if (navigator.onLine !== false) gps = await pedirUbicacion({ timeout: 3500 }).catch(() => null);
      else gps = await pedirUbicacion({ timeout: 3500 }).catch(() => null); // el GPS funciona sin internet
      const turnoId = getTurnoId();
      const r = await enviarRegistro({
        ruta: "/panico", tipo: "panico", resumen: "Alerta de pánico", turnoId,
        body: { mantenidoMs, ...(turnoId ? { turnoId } : {}), ...(gps ? { lat: gps.lat, lng: gps.lng, precisionM: gps.precisionM } : {}) },
      });
      panel.resultado(r.encolado ? { ok: false, encolado: true, gps: Boolean(gps) } : { ok: true, gps: Boolean(gps), repetida: r.data.repetida, sinSupervisor: r.data.sinSupervisor });
    } catch (e) {
      panel.resultado({ ok: false, error: e.status ? e.message : "No se pudo enviar la alerta.", gps: false });
    } finally {
      setTimeout(() => { bloqueado = false; boton.classList.remove("enviando"); }, 5000);
    }
  }
  limpiarEventos.push(() => cancelar());
}

export function desmontarPanico() {
  for (const f of limpiarEventos) f();
  limpiarEventos = [];
  if (raizBoton) { raizBoton.remove(); raizBoton = null; }
  document.getElementById("panico-panel")?.remove();
}

// Pantalla que aparece al disparar: estado del envío y llamadas de emergencia (siempre disponibles).
function abrirPanel() {
  document.getElementById("panico-panel")?.remove();
  const estado = h("p", { class: "panico-estado", role: "status", "aria-live": "assertive" }, "Enviando alerta…");
  const llamadas = h("div", { class: "panico-llamadas" });
  const cerrar = h("button", { class: "btn secundario", type: "button", onclick: () => panel.remove() }, "Cerrar");
  const panel = h("div", { id: "panico-panel", class: "panico-panel", role: "alertdialog", "aria-modal": "true", "aria-label": "Alerta de pánico" },
    h("div", { class: "panico-caja" }, h("h2", {}, "🆘 Alerta de pánico"), estado, llamadas, cerrar));
  document.body.append(panel);
  const pintarLlamadas = async () => {
    const c = await metaGet("contactoEmergencia");
    limpiar(llamadas);
    poner(llamadas,
      c?.telefono ? h("a", { class: "btn primario grande", href: `tel:${c.telefono.replace(/[^0-9+]/g, "")}` }, `📞 Llamar al supervisor (${c.telefono})`) : h("p", { class: "ayuda" }, "Tu sitio aún no tiene teléfono de emergencia registrado."),
      h("a", { class: "btn peligro grande", href: "tel:911" }, "📞 Llamar al 911"));
  };
  pintarLlamadas();
  return {
    resultado(r) {
      const ahora = hora(Date.now());
      if (r.ok) {
        estado.className = "panico-estado ok";
        estado.textContent = r.repetida ? `Tu alerta ya estaba activa y tu supervisor ya fue avisado. (${ahora})` : `✔ Alerta enviada a las ${ahora}. Tu supervisor y la administración ya fueron avisados${r.gps ? " con tu ubicación" : " (sin ubicación: el GPS no respondió)"}.${r.sinSupervisor ? " Este sitio no tiene supervisor asignado: la recibió la administración." : ""}`;
      } else if (r.encolado) {
        estado.className = "panico-estado mal";
        estado.textContent = `SIN CONEXIÓN: la alerta quedó guardada en tu celular y se enviará AUTOMÁTICAMENTE en cuanto haya señal. Si es una emergencia, llama ahora.`;
      } else {
        estado.className = "panico-estado mal";
        estado.textContent = `${r.error} Si es una emergencia, llama ahora.`;
      }
    },
  };
}
