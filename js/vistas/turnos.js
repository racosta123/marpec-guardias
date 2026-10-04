// Turnos: vista semanal por sitio, plantillas, asignación y puestos sin cubrir (admin y supervisor del sitio).
import { collection, getDocs, orderBy, query, where } from "../vendor/firebase.js";
import { accion, campo, confirmar, h, limpiar, modal, toast, poner } from "../ui.js";
import { diaLargo, duracionH, hora, hoy, localAMs, lunesDe, sumarDias } from "../tz.js";
import { cargarSitios } from "./sitios.js";

const PLANTILLAS = [
  ["diurno", "Diurno 07:00–19:00"],
  ["nocturno", "Nocturno 19:00–07:00"],
  ["12x24", "12x24 (12 h trabaja, 24 h descansa)"],
  ["24x24", "24x24 (24 h trabaja, 24 h descansa)"],
  ["personalizada", "Personalizada (hora inicio/fin)"],
];

async function cargarGuardias(db) {
  const snap = await getDocs(query(collection(db, "usuarios"), where("rol", "==", "guardia")));
  return snap.docs.map((d) => ({ uid: d.id, ...d.data() })).filter((g) => g.activo).sort((a, b) => a.nombre.localeCompare(b.nombre, "es"));
}

async function cargarTurnos({ db, user }, desdeMs, hastaMs) {
  const col = collection(db, "turnos");
  const filtroRol = user.rol === "admin" ? [] : [where("supervisorUid", "==", user.uid)];
  const snap = await getDocs(query(col, ...filtroRol, where("inicioMs", ">=", desdeMs), where("inicioMs", "<", hastaMs), orderBy("inicioMs")));
  return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((t) => t.estado !== "cancelado");
}

export async function vistaTurnos(raiz, ctx, estado = {}) {
  const { db, api, user } = ctx;
  limpiar(raiz);
  poner(raiz, h("p", { class: "vacio" }, "Cargando turnos…"));
  const [sitios, guardias] = await Promise.all([cargarSitios(ctx), cargarGuardias(db)]);
  const activos = sitios.filter((s) => s.activo !== false);
  if (!activos.length) {
    limpiar(raiz);
    poner(raiz, h("div", { class: "barra" }, h("h2", {}, "Turnos")), h("p", { class: "vacio" }, user.rol === "admin" ? "Primero crea un sitio." : "No tienes sitios asignados."));
    return;
  }
  const sitioId = estado.sitioId && activos.some((s) => s.id === estado.sitioId) ? estado.sitioId : activos[0].id;
  const lunes = estado.lunes || lunesDe(hoy());
  const recargar = (extra = {}) => vistaTurnos(raiz, ctx, { sitioId, lunes, ...extra });
  const sitio = activos.find((s) => s.id === sitioId);
  const nombreGuardia = (uid) => guardias.find((g) => g.uid === uid)?.nombre || "Guardia";

  const ini = localAMs(lunes);
  const fin = localAMs(sumarDias(lunes, 7));
  const todos = await cargarTurnos(ctx, ini, fin);
  const turnos = todos.filter((t) => t.sitioId === sitioId);
  const sinCubrir = turnos.filter((t) => !t.guardiaUid).length;

  const dias = Array.from({ length: 7 }, (_, i) => sumarDias(lunes, i));
  const chip = (t) => h("button", {
    type: "button", class: `turno ${t.guardiaUid ? "cubierto" : "vacante"}`, onclick: () => detalle(t),
    "aria-label": `${hora(t.inicioMs)} a ${hora(t.finMs)}, ${t.guardiaUid ? nombreGuardia(t.guardiaUid) : "sin cubrir"}`,
  }, h("span", { class: "turno-hora" }, `${hora(t.inicioMs)}–${hora(t.finMs)}`),
    h("span", { class: "turno-quien" }, t.guardiaUid ? nombreGuardia(t.guardiaUid) : "SIN CUBRIR"));

  const semana = h("div", { class: "semana" }, dias.map((dia) => {
    const delDia = turnos.filter((t) => t.inicioMs >= localAMs(dia) && t.inicioMs < localAMs(sumarDias(dia, 1)));
    return h("section", { class: `dia ${dia === hoy() ? "hoy" : ""}` },
      h("h4", {}, diaLargo(localAMs(dia, "12:00"))),
      delDia.length ? delDia.map(chip) : h("p", { class: "libre" }, "Sin turnos"));
  }));

  const selSitio = h("select", { "aria-label": "Sitio", value: sitioId, onchange: (e) => recargar({ sitioId: e.target.value }) },
    activos.map((s) => h("option", { value: s.id }, s.nombre)));

  limpiar(raiz);
  poner(raiz, 
    h("div", { class: "barra" }, h("h2", {}, "Turnos"),
      h("div", { class: "barra-acc" }, h("button", { class: "btn chico primario", type: "button", onclick: formLote }, "+ Agregar turnos"))),
    h("div", { class: "filtros" }, selSitio,
      h("div", { class: "nav-semana" },
        h("button", { class: "btn chico secundario", type: "button", "aria-label": "Semana anterior", onclick: () => recargar({ lunes: sumarDias(lunes, -7) }) }, "◀"),
        h("span", {}, `Semana del ${diaLargo(localAMs(lunes, "12:00"))}`),
        h("button", { class: "btn chico secundario", type: "button", "aria-label": "Semana siguiente", onclick: () => recargar({ lunes: sumarDias(lunes, 7) }) }, "▶"),
        h("button", { class: "btn chico secundario", type: "button", onclick: () => recargar({ lunes: lunesDe(hoy()) }) }, "Hoy"))),
    sinCubrir ? h("p", { class: "alerta" }, `⚠ ${sinCubrir} ${sinCubrir === 1 ? "puesto sin cubrir" : "puestos sin cubrir"} esta semana en «${sitio.nombre}».`) : null,
    semana,
    h("p", { class: "ayuda" }, "Horario de Hermosillo (UTC-7, sin horario de verano). Toca un turno para asignar guardia o cancelarlo."));

  // ---- detalle de un turno ----
  function detalle(t) {
    const pasado = t.inicioMs <= Date.now();
    const sel = h("select", { value: t.guardiaUid || "" },
      h("option", { value: "" }, "— Sin cubrir —"), guardias.map((g) => h("option", { value: g.uid }, g.nombre)));
    const cont = h("div", { class: "form" },
      h("p", {}, h("b", {}, sitio.nombre), ` · ${diaLargo(t.inicioMs)} · ${hora(t.inicioMs)}–${hora(t.finMs)} (${duracionH(t.inicioMs, t.finMs)})`),
      campo("Guardia asignado", sel),
      pasado ? h("p", { class: "ayuda" }, "Este turno ya inició o terminó y no se puede modificar.") : null,
      h("div", { class: "acciones" },
        h("button", { class: "btn peligro", type: "button", disabled: pasado, onclick: async () => {
          if (!(await confirmar("Cancelar turno", "El turno se cancelará y el guardia dejará de verlo.", "Cancelar turno", true))) return;
          const r = await accion(null, () => api("/turnos/cancelar", { body: { turnoId: t.id } }), "Turno cancelado.");
          if (r) { m.cerrar(); recargar(); }
        } }, "Cancelar turno"),
        h("button", { class: "btn primario", type: "button", disabled: pasado, onclick: async (e) => {
          const r = await accion(e.currentTarget, () => api("/turnos/asignar", { body: { turnoId: t.id, guardiaUid: sel.value || null } }), "Turno actualizado.");
          if (r) { m.cerrar(); recargar(); }
        } }, "Guardar")));
    const m = modal("Turno", cont);
  }

  // ---- alta de turnos por plantilla ----
  function formLote() {
    const plantilla = h("select", { value: "diurno" }, PLANTILLAS.map(([v, e]) => h("option", { value: v }, e)));
    const desde = h("input", { type: "date", value: hoy() < lunes ? lunes : hoy(), required: true });
    const hasta = h("input", { type: "date", value: sumarDias(hoy() < lunes ? lunes : hoy(), 6), required: true });
    const hi = h("input", { type: "time", value: "07:00" });
    const hf = h("input", { type: "time", value: "19:00" });
    const guardia = h("select", { value: "" }, h("option", { value: "" }, "— Sin cubrir (vacante) —"), guardias.map((g) => h("option", { value: g.uid }, g.nombre)));
    const horas = h("div", { class: "dos" }, campo("Hora de inicio", hi), campo("Hora de fin", hf));
    const ajusta = () => {
      const p = plantilla.value;
      horas.hidden = !(p === "personalizada" || p === "12x24" || p === "24x24");
      hf.closest("label").hidden = p !== "personalizada";
    };
    plantilla.addEventListener("change", ajusta);
    const f = h("form", { class: "form", novalidate: true },
      h("p", {}, "Sitio: ", h("b", {}, sitio.nombre)),
      campo("Plantilla", plantilla), horas,
      h("div", { class: "dos" }, campo("Desde", desde), campo("Hasta", hasta)),
      campo("Guardia", guardia, "Si no eliges guardia se crean puestos sin cubrir (en rojo)."),
      h("p", { class: "ayuda" }, "Se rechaza todo el lote si el guardia ya tiene un turno que se empalme, en este u otro sitio."),
      h("button", { class: "btn primario", type: "submit" }, "Crear turnos"));
    ajusta();
    const m = modal("Agregar turnos", f);
    f.addEventListener("submit", async (e) => {
      e.preventDefault();
      const body = { sitioId, plantilla: plantilla.value, desde: desde.value, hasta: hasta.value, guardiaUid: guardia.value || null };
      if (!horas.hidden) body.horaInicio = hi.value;
      if (plantilla.value === "personalizada") body.horaFin = hf.value;
      const r = await accion(f.querySelector("button[type=submit]"), () => api("/turnos/asignar-lote", { body }), null);
      if (r) { toast(`${r.creados} ${r.creados === 1 ? "turno creado" : "turnos creados"}.`); m.cerrar(); recargar({ lunes: lunesDe(desde.value) }); }
    });
  }
}
