// Botón propio de instalación de la PWA (mismo patrón que CerradaApp, sin librerías).
// - Android/escritorio (Chrome/Edge): captura beforeinstallprompt y ofrece "Instalar app".
// - iPhone/iPad (Safari no tiene ese evento): muestra instrucciones "Compartir → Agregar a pantalla de inicio".
// - Si la app ya corre instalada (display-mode: standalone) o se acaba de instalar, no muestra nada.
// Se carga ANTES que app.js para no perder el evento.
const mq = window.matchMedia("(display-mode: standalone)");
const CLAVE_IOS = "marpec-instalar-ios-oculto";
let diferido = null; // evento beforeinstallprompt guardado
let instalada = false;

const esStandalone = () => mq.matches || window.navigator.standalone === true;
const esIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

function ocultoIOS() {
  try { return Number(localStorage.getItem(CLAVE_IOS)) > Date.now(); } catch { return false; }
}
function ocultarIOS24h() {
  try { localStorage.setItem(CLAVE_IOS, String(Date.now() + 24 * 3600 * 1000)); } catch { /* sin almacenamiento */ }
}

function el(tag, clase, texto) {
  const n = document.createElement(tag);
  if (clase) n.className = clase;
  if (texto !== undefined) n.textContent = texto;
  return n;
}

function botonInstalar() {
  const b = el("button", "btn primario instalar-btn", "📲 Instalar app");
  b.type = "button";
  b.addEventListener("click", async () => {
    const e = diferido;
    if (!e) return;
    b.disabled = true;
    e.prompt();
    const r = await e.userChoice.catch(() => ({ outcome: "dismissed" }));
    diferido = null; // el evento solo se puede usar una vez
    if (r.outcome === "accepted") instalada = true;
    pintar();
  });
  return b;
}

function instruccionesIOS() {
  const caja = el("div", "instalar-ios");
  const texto = el("p", "");
  texto.append("Para instalar en tu iPhone: toca ", Object.assign(el("b", "", "Compartir"), {}), " ", el("span", "icono-compartir", "⬆︎"), " y luego ", el("b", "", "«Agregar a pantalla de inicio»"), ".");
  const x = el("button", "btn-icono", "✕");
  x.type = "button";
  x.setAttribute("aria-label", "Ocultar instrucciones");
  x.addEventListener("click", () => { ocultarIOS24h(); pintar(); });
  caja.append(texto, x);
  return caja;
}

function pintar() {
  const ocultar = esStandalone() || instalada;
  for (const c of document.querySelectorAll("[data-instalar]")) {
    c.replaceChildren();
    c.hidden = true;
    if (ocultar) continue;
    if (diferido) {
      c.append(botonInstalar());
      c.hidden = false;
    } else if (esIOS() && !ocultoIOS()) {
      c.append(instruccionesIOS());
      c.hidden = false;
    }
  }
}

window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault(); // evita el mini-aviso del navegador; usamos nuestro botón
  diferido = e;
  pintar();
});
window.addEventListener("appinstalled", () => { instalada = true; diferido = null; pintar(); });
mq.addEventListener?.("change", pintar);
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", pintar);
else pintar();
