// Componentes de la guía de estilo (docs/guia-estilo-marpec.html): encabezado de página, indicadores con fondo suave,
// tarjeta de filtros, tabla con tira de color, avatar con iniciales, etiquetas y estado vacío compacto.
// Solo apariencia: no consultan datos ni llaman al Worker. Todo se construye con DOM y textContent (sin innerHTML).
import { h } from "./ui.js";
import { icono } from "./iconos.js";

export const iniciales = (nombre) => {
  const p = String(nombre || "").trim().split(/\s+/).filter(Boolean);
  return ((p[0]?.[0] || "?") + (p.length > 1 ? p[p.length - 1][0] : "")).toUpperCase();
};
export const avatar = (nombre) => h("span", { class: "av", "aria-hidden": "true" }, iniciales(nombre));

// Encabezado: título (H2 de la sección), subtítulo y acciones a la derecha.
export const cabeceraPagina = (titulo, subtitulo, acciones) =>
  h("div", { class: "pag-cab" }, h("div", {}, h("h2", {}, titulo), subtitulo ? h("p", { class: "pag-sub" }, subtitulo) : null), acciones ? h("div", { class: "barra-acc" }, acciones) : null);

// Indicador (KPI): fondo suave del color del estado, ícono en chip de 44 px y número grande. color: azul | verde | ambar | rojo | neutro
// `corto`: texto breve que reemplaza al título en celular (p. ej. «En el periodo»).
export const indicador = (color, nombreIcono, valor, titulo, corto) =>
  h("div", { class: `ind ${color}`, role: "group", "aria-label": `${titulo}: ${valor}` },
    h("span", { class: "chip" }, icono(nombreIcono, { tam: 24 })),
    h("div", {}, h("span", { class: "n" }, String(valor)), h("span", { class: "t" }, corto ? [h("span", { class: "t-l" }, titulo), h("span", { class: "t-c" }, corto)] : titulo)));
export const indicadores = (...items) => h("div", { class: "ind-grid" }, items);

// Tarjeta de filtros: cada control con su etiqueta visible (nunca solo placeholder).
export const tarjetaFiltros = (clase, ...contenido) => h("div", { class: `fcard ${clase || ""}`.trim() }, contenido);

// Etiqueta de estado/gravedad: clase de color (ok | mal | info | prueba) + variante opcional (relleno para gravedad).
export const etiqueta = (texto, color, variante = "") => h("span", { class: `etq ${color} ${variante}`.trim() }, texto);

// Estado vacío o de carga, compacto: una línea de título y una de ayuda.
export const vacioCompacto = (titulo, ayuda, nombreIcono = "check") =>
  h("div", { class: "vacio-c", role: "status" }, h("span", { class: "chip" }, icono(nombreIcono, { tam: 22 })), h("div", {}, h("strong", {}, titulo), ayuda ? h("span", {}, ayuda) : null));

// Tabla (lista con rejilla en escritorio; tarjetas en celular). cols = [{ t: "Encabezado", cls }]. filas = nodos <li> de `fila()`.
export function tabla(clase, cols, filas) {
  return h("ul", { class: `tabla-g ${clase}`, role: "list" },
    h("li", { class: "cab-t", "aria-hidden": "true" }, cols.map((c) => h("span", { class: c.cls || "" }, c.t))),
    filas);
}
// Fila: tira = color de la tira; celdas = [{ et: "Etiqueta móvil", cls, nodos }]; detalle = nodo opcional a todo el ancho.
export function fila({ tira = "neutro", celdas, detalle, extra = "" }) {
  return h("li", { class: `fila ${extra}`.trim(), "data-tira": tira },
    celdas.map((c) => h("div", { class: `cel ${c.cls || ""}`.trim(), "data-et": c.et || null }, c.nodos)),
    detalle ? h("div", { class: "det-f" }, detalle) : null);
}
