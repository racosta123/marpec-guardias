// Recursos del diseño (se ejecuta con: node tools/build-diseno.mjs). Cero dependencias en tiempo de ejecución:
//  · fuente Inter (SIL OFL) copiada a fonts/ y servida desde el repositorio (sin Google Fonts);
//  · íconos Lucide (ISC) SOLO los que se usan, empaquetados como SVG locales en js/iconos.js (sin CDNs).
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

// Inter: solo el subconjunto latino (cubre el español: ñ, acentos, ¿ ¡, ·, –, …) en 4 pesos.
mkdirSync("fonts", { recursive: true });
for (const w of [400, 500, 600, 700]) copyFileSync(`node_modules/@fontsource/inter/files/inter-latin-${w}-normal.woff2`, `fonts/inter-${w}.woff2`);
copyFileSync("node_modules/@fontsource/inter/LICENSE", "fonts/LICENSE-Inter-OFL.txt");

// Íconos (nombre propio → archivo de Lucide). Agregar aquí los que se necesiten y volver a ejecutar.
const USADOS = {
  envivo: "radio", asistencia: "clipboard-check", rondines: "route", incidencias: "triangle-alert", visitantes: "users-round",
  bitacoras: "notebook-text", alertas: "bell", turnos: "calendar-days", sitios: "map-pin", personal: "users", reportes: "chart-column",
  empresa: "building-2", sinconexion: "wifi-off", auditoria: "scroll-text",
  escudo: "shield-check", entrada: "log-in", salida: "log-out", reloj: "clock", ubicacion: "map-pin", check: "check", derecha: "chevron-right",
  menu: "menu", cerrar: "x", panico: "siren", novedad: "file-pen-line", usuario: "circle-user-round", libro: "book-open-text",
  camara: "camera", qr: "qr-code", usuarios: "users", escudoalerta: "shield-alert", campana: "bell-ring", chevronabajo: "chevron-down",
  rondin: "shield-check", wifi: "wifi", cuadro: "layout-dashboard",
};
const salida = {};
for (const [nombre, archivo] of Object.entries(USADOS)) {
  const ruta = `node_modules/lucide-static/icons/${archivo}.svg`;
  if (!existsSync(ruta)) throw new Error(`Lucide no tiene el ícono «${archivo}» (${nombre})`);
  const svg = readFileSync(ruta, "utf8");
  const interior = /<svg[^>]*>([\s\S]*?)<\/svg>/.exec(svg)[1].replace(/\s+/g, " ").replace(/> </g, "><").trim(); // sin espacios entre etiquetas (si no, el SVG aporta texto en blanco al botón)
  salida[nombre] = interior;
}
copyFileSync("node_modules/lucide-static/LICENSE", "js/vendor/LICENSE-lucide-ISC.txt");
writeFileSync("js/iconos.js", `// GENERADO por tools/build-diseno.mjs — íconos Lucide (ISC, ver js/vendor/LICENSE-lucide-ISC.txt). Solo los que se usan.
const NS = "http://www.w3.org/2000/svg";
const ICONOS = ${JSON.stringify(salida, null, 1)};

// Devuelve un <svg> listo para insertar (decorativo: aria-hidden). Hereda el color del texto (currentColor).
export function icono(nombre, { tam = 20, clase = "" } = {}) {
  const s = document.createElementNS(NS, "svg");
  for (const [k, v] of Object.entries({ width: tam, height: tam, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round", "stroke-linejoin": "round", "aria-hidden": "true", focusable: "false", class: \`ico \${clase}\`.trim() })) s.setAttribute(k, v);
  s.innerHTML = ICONOS[nombre] || "";
  return s;
}
export const hayIcono = (nombre) => nombre in ICONOS;
`);
console.log(`Inter (4 pesos) y ${Object.keys(salida).length} íconos Lucide listos.`);
