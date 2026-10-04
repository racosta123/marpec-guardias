// Página imprimible del QR de un puesto. Requiere sesión de admin o del supervisor del sitio.
import {
  initializeApp, initializeAuth, indexedDBLocalPersistence, browserLocalPersistence, onAuthStateChanged,
} from "./vendor/firebase.js";
import { qrMatriz } from "./vendor/qr.js";
import { config } from "./config.js";
import { crearApi } from "./api.js";

const $ = (id) => document.getElementById(id);
const auth = initializeAuth(initializeApp(config.firebase), { persistence: [indexedDBLocalPersistence, browserLocalPersistence] });
const api = crearApi(auth);
const NS = "http://www.w3.org/2000/svg";

// Dibuja la matriz como SVG (rectángulos) con zona de silencio de 4 módulos. Sin innerHTML.
function dibujar(texto) {
  const { n, oscuro } = qrMatriz(texto);
  const q = 4;
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${n + 2 * q} ${n + 2 * q}`);
  svg.setAttribute("shape-rendering", "crispEdges");
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", "Código QR del puesto");
  const fondo = document.createElementNS(NS, "rect");
  for (const [k, v] of Object.entries({ width: n + 2 * q, height: n + 2 * q, fill: "#ffffff" })) fondo.setAttribute(k, v);
  svg.append(fondo);
  const trazo = document.createElementNS(NS, "path");
  let d = "";
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (oscuro[r][c]) d += `M${c + q} ${r + q}h1v1h-1z`;
  trazo.setAttribute("d", d);
  trazo.setAttribute("fill", "#000000");
  svg.append(trazo);
  return svg;
}

const mostrarError = (m) => { $("qr-estado").textContent = m; };

onAuthStateChanged(auth, async (user) => {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return mostrarError("Falta el identificador del sitio.");
  if (!user) return mostrarError("Inicia sesión en la aplicación como administrador o supervisor y vuelve a abrir esta página.");
  try {
    const r = await api(`/sitios/qr?id=${encodeURIComponent(id)}`, { method: "GET" });
    $("qr-estado").hidden = true;
    $("qr-sitio").textContent = r.sitio.nombre;
    $("qr-sitio").hidden = false;
    if (r.sitio.direccion) { $("qr-dir").textContent = r.sitio.direccion; $("qr-dir").hidden = false; }
    $("qr-contenedor").replaceChildren(dibujar(r.payload));
    $("qr-contenedor").hidden = false;
    $("qr-pie").textContent = `Código de puesto v${r.version} · Escanear solo con la app MARPEC Guardias`;
    $("qr-pie").hidden = false;
    $("qr-imprimir").hidden = false;
    $("qr-imprimir").addEventListener("click", () => window.print());
    document.title = `QR · ${r.sitio.nombre}`;
  } catch (e) {
    mostrarError(e.status === 403 || e.status === 404 ? "No tienes acceso a este sitio o no existe." : e.message);
  }
});
