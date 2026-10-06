// Bitácora de auditoría (solo lectura, solo admin). Los registros son inmutables.
// Las entradas de prueba (prueba=true) se ocultan por defecto: la bitácora arranca limpia.
import { collection, getDocs, limit, orderBy, query } from "../vendor/firebase.js";
import { h, limpiar, poner } from "../ui.js";
import { fechaHora } from "../tz.js";

export async function vistaBitacora(raiz, { db }, { verPruebas = false } = {}) {
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando bitácora…"));
  // Se leen más de 100 para poder mostrar 100 reales aunque haya entradas de prueba mezcladas.
  const snap = await getDocs(query(collection(db, "auditoria"), orderBy("ts", "desc"), limit(400)));
  const todas = snap.docs.map((d) => d.data());
  const entradas = (verPruebas ? todas : todas.filter((e) => e.prueba !== true)).slice(0, 100);
  const nPrueba = todas.filter((e) => e.prueba === true).length;
  limpiar(raiz);
  poner(raiz,
    h("div", { class: "barra" }, h("h2", {}, "Bitácora")),
    h("p", { class: "ayuda" }, "Registro inmutable de altas, bajas y cambios. Últimos 100 movimientos (hora de Hermosillo)."),
    nPrueba ? h("label", { class: "ayuda" },
      h("input", { type: "checkbox", checked: verPruebas, onchange: (ev) => vistaBitacora(raiz, { db }, { verPruebas: ev.target.checked }) }),
      ` Mostrar entradas de prueba (${nPrueba})`) : null,
    !entradas.length ? h("p", { class: "vacio" }, "Sin movimientos todavía.") :
      h("ul", { class: "lista" }, entradas.map((e) =>
        h("li", { class: "item" }, h("div", { class: "item-info" },
          h("strong", {}, e.accion, e.prueba === true ? " (prueba)" : ""),
          h("span", { class: "sub" }, `${e.actorNombre || e.actorUid} (${e.actorRol}) · ${e.ts ? fechaHora(e.ts.toMillis()) : "—"}`),
          h("span", { class: "sub" }, `Objetivo: ${e.objetivo}`),
          e.detalle && e.detalle !== "{}" ? h("span", { class: "sub detalle" }, e.detalle) : null)))));
}
