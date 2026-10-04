// Bitácora de auditoría (solo lectura, solo admin). Los registros son inmutables.
import { collection, getDocs, limit, orderBy, query } from "../vendor/firebase.js";
import { h, limpiar, poner } from "../ui.js";
import { fechaHora } from "../tz.js";

export async function vistaBitacora(raiz, { db }) {
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando bitácora…"));
  const snap = await getDocs(query(collection(db, "auditoria"), orderBy("ts", "desc"), limit(100)));
  limpiar(raiz);
  poner(raiz, 
    h("div", { class: "barra" }, h("h2", {}, "Bitácora")),
    h("p", { class: "ayuda" }, "Registro inmutable de altas, bajas y cambios. Últimos 100 movimientos (hora de Hermosillo)."),
    snap.empty ? h("p", { class: "vacio" }, "Sin movimientos todavía.") :
      h("ul", { class: "lista" }, snap.docs.map((d) => {
        const e = d.data();
        return h("li", { class: "item" }, h("div", { class: "item-info" },
          h("strong", {}, e.accion),
          h("span", { class: "sub" }, `${e.actorNombre || e.actorUid} (${e.actorRol}) · ${e.ts ? fechaHora(e.ts.toMillis()) : "—"}`),
          h("span", { class: "sub" }, `Objetivo: ${e.objetivo}`),
          e.detalle && e.detalle !== "{}" ? h("span", { class: "sub detalle" }, e.detalle) : null));
      })));
}
