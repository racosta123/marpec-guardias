// Utilidades de interfaz. SIEMPRE se construye con DOM y textContent (nunca innerHTML): sin XSS.
export function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  let valor;
  for (const [k, v] of Object.entries(props || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "value") valor = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, "");
    else el.setAttribute(k, String(v));
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  if (valor !== undefined) el.value = valor; // después de crear las <option>
  return el;
}

export const limpiar = (el) => el.replaceChildren();
// append que ignora null/false (el append nativo escribiría el texto "null").
export const poner = (el, ...kids) => el.append(...kids.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));

export function toast(mensaje, tipo = "ok") {
  const cont = document.getElementById("toasts");
  const t = h("div", { class: `toast ${tipo}`, role: tipo === "error" ? "alert" : "status" }, mensaje);
  cont.append(t);
  setTimeout(() => t.remove(), tipo === "error" ? 7000 : 3500);
}

// Modal accesible. `contenido` es un nodo; devuelve { cerrar, caja }.
// opciones: { clase } (clase extra de la caja), { alCerrar } (se llama una vez al cerrar, por cualquier vía),
// { escCapturado } (Esc cierra SOLO este modal aunque haya otro debajo: ventanas anidadas).
export function modal(titulo, contenido, { clase = "", alCerrar = null, escCapturado = false } = {}) {
  const previo = document.activeElement;
  const fondo = h("div", { class: "modal-fondo" });
  const caja = h("div", { class: `modal${clase ? " " + clase : ""}`, role: "dialog", "aria-modal": "true", "aria-label": titulo },
    h("div", { class: "modal-cab" },
      h("h2", {}, titulo),
      h("button", { class: "btn-icono", type: "button", "aria-label": "Cerrar", onclick: () => cerrar() }, "✕")),
    contenido);
  fondo.append(caja);
  const tecla = (e) => { if (e.key === "Escape") { if (escCapturado) e.stopPropagation(); cerrar(); } };
  let cerrado = false;
  function cerrar() {
    if (cerrado) return;
    cerrado = true;
    document.removeEventListener("keydown", tecla, escCapturado);
    fondo.remove();
    previo?.focus?.();
    alCerrar?.();
  }
  fondo.addEventListener("mousedown", (e) => { if (e.target === fondo) cerrar(); });
  document.addEventListener("keydown", tecla, escCapturado);
  document.body.append(fondo);
  (caja.querySelector("input,select,textarea,button.primario") || caja).focus();
  return { cerrar, caja };
}

export function confirmar(titulo, mensaje, etiqueta = "Confirmar", peligro = false) {
  return new Promise((resolve) => {
    const m = modal(titulo, h("div", { class: "modal-cuerpo" },
      h("p", {}, mensaje),
      h("div", { class: "acciones" },
        h("button", { class: "btn secundario", type: "button", onclick: () => { m.cerrar(); resolve(false); } }, "Cancelar"),
        h("button", { class: `btn ${peligro ? "peligro" : "primario"}`, type: "button", onclick: () => { m.cerrar(); resolve(true); } }, etiqueta))));
  });
}

// Campo de formulario con etiqueta.
export function campo(etiqueta, control, ayuda) {
  return h("label", { class: "campo" }, h("span", { class: "campo-et" }, etiqueta), control, ayuda ? h("small", { class: "ayuda" }, ayuda) : null);
}

// Ejecuta una acción del Worker mostrando errores y bloqueando el botón.
export async function accion(boton, fn, okMsg) {
  if (boton) boton.disabled = true;
  try {
    const r = await fn();
    if (okMsg) toast(okMsg);
    return r;
  } catch (e) {
    toast(e.message || "No fue posible completar la acción.", "error");
    return undefined;
  } finally {
    if (boton) boton.disabled = false;
  }
}
