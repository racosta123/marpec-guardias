// Inicio del guardia: su próximo turno, su sitio y las consignas.
import { collection, doc, getDoc, getDocs, orderBy, query, where } from "../vendor/firebase.js";
import { h, limpiar, poner } from "../ui.js";
import { diaLargo, duracionH, hora } from "../tz.js";

export async function vistaGuardia(raiz, { db, user }) {
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando tu turno…"));
  const ahora = Date.now();
  // Turnos que empezaron hace menos de 30 h o empiezan después (cubre los de 24 h en curso).
  const snap = await getDocs(query(collection(db, "turnos"),
    where("guardiaUid", "==", user.uid), where("inicioMs", ">=", ahora - 30 * 3600e3), orderBy("inicioMs")));
  const turnos = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.estado === "programado" && t.finMs > ahora);
  limpiar(raiz);
  if (!turnos.length) {
    poner(raiz, h("p", { class: "vacio" }, "No tienes turnos asignados por ahora."));
    return;
  }
  const [prox, ...resto] = turnos;
  let consignas = null, sitio = null;
  try { const s = await getDoc(doc(db, "sitios", prox.sitioId)); if (s.exists()) sitio = s.data(); } catch { /* sin acceso */ }
  consignas = sitio?.consignas;
  const enCurso = prox.inicioMs <= ahora;

  poner(raiz, 
    h("section", { class: "tarjeta turno-grande" },
      h("span", { class: `etq ${enCurso ? "ok" : "info"}` }, enCurso ? "Turno en curso" : "Próximo turno"),
      h("h3", {}, diaLargo(prox.inicioMs)),
      h("p", { class: "hora-grande" }, `${hora(prox.inicioMs)} – ${hora(prox.finMs)}`, h("small", {}, ` (${duracionH(prox.inicioMs, prox.finMs)})`)),
      h("p", {}, h("b", {}, "Sitio: "), prox.sitioNombre),
      sitio?.direccion ? h("p", { class: "sub" }, sitio.direccion) : null,
      h("div", { class: "consignas-caja" }, h("h4", {}, "Consignas del puesto"),
        h("p", {}, consignas ? consignas : "Sin consignas registradas."))),
    resto.length ? h("section", { class: "bloque" }, h("h3", {}, "Siguientes turnos"),
      h("ul", { class: "lista" }, resto.slice(0, 6).map((t) => h("li", { class: "item" }, h("div", { class: "item-info" },
        h("strong", {}, diaLargo(t.inicioMs)), h("span", { class: "sub" }, `${hora(t.inicioMs)} – ${hora(t.finMs)} · ${t.sitioNombre}`)))))) : null,
    h("p", { class: "ayuda" }, "Horario de Hermosillo (UTC-7, sin horario de verano)."));
}
