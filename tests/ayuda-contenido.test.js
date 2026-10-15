// Contenido fijo del módulo Ayuda (sin red ni DOM): cada rol ve solo sus preguntas y la búsqueda es local.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CATEGORIAS, PREGUNTAS, buscar, preguntasDe } from "../js/ayuda-contenido.js";

const SECCIONES = {
  admin: ["vivo", "asistencia", "rondines", "incidencias", "visitantes", "bitacoras", "offline", "alertas", "turnos", "sitios", "personal", "reportes", "empresa", "bitacora", "ayuda"],
  supervisor: ["vivo", "asistencia", "rondines", "incidencias", "visitantes", "bitacoras", "offline", "alertas", "turnos", "sitios", "ayuda"],
};

test("cada rol ve solo sus preguntas; el supervisor no ve las exclusivas del administrador", () => {
  const g = preguntasDe("guardia"), s = preguntasDe("supervisor"), a = preguntasDe("admin");
  assert.ok(g.length >= 8 && g.every((p) => p.para === "guardia"));
  assert.ok(a.every((p) => p.para === "oficina"));
  assert.ok(s.every((p) => p.para === "oficina" && !p.soloAdmin));
  assert.ok(a.some((p) => p.soloAdmin) && a.length > s.length);
  assert.ok(!s.some((p) => /alta un guardia|alta un supervisor|desbloqueo|saco un reporte/i.test(p.q)));
});

test("están todas las preguntas mínimas pedidas", () => {
  const oficina = ["alta un guardia", "asigno el turno", "creo un sitio y su QR", "alta un supervisor", "desbloqueo el PIN", "baja o reactivo", "autorizo horas extra", "reviso una incidencia", "puntos de rondín", "«Sin conexión»", "saco un reporte", "activo las notificaciones"];
  const guardia = ["marco mi entrada", "marco mi salida", "reporto una incidencia", "registro un visitante", "hago un rondín", "no tengo internet", "botón de pánico", "no me deja marcar"];
  const problemas = ["perímetro", "QR", "PIN", "cerrar", "notificaciones"];
  for (const x of oficina) assert.ok(preguntasDe("admin").some((p) => p.q.includes(x)), x);
  for (const x of guardia) assert.ok(preguntasDe("guardia").some((p) => p.q.includes(x)), x);
  for (const rol of ["admin", "guardia"]) for (const x of problemas.filter((y) => rol === "admin" || y !== "notificaciones"))
    assert.ok(preguntasDe(rol).some((p) => p.cat === "Problemas comunes" && p.q.includes(x)), `${rol}: ${x}`);
});

test("cada pregunta tiene categoría válida, pasos cortos y un destino que existe para su rol", () => {
  const ids = new Set();
  for (const p of PREGUNTAS) {
    assert.ok(!ids.has(p.id), `id repetido ${p.id}`); ids.add(p.id);
    assert.ok(CATEGORIAS[p.para].includes(p.cat), `${p.id}: categoría`);
    assert.ok(p.pasos.length >= 2 && p.pasos.length <= 6 && p.pasos.every((x) => x.length <= 240), `${p.id}: pasos`);
    if (p.para === "guardia") assert.equal(p.ir, "inicio");
    else {
      assert.ok(SECCIONES.admin.includes(p.ir), `${p.id}: destino`);
      // «PIN bloqueado» la ven ambos, pero solo el admin tiene Personal: al supervisor no se le muestra el botón (vistas/ayuda.js irBoton).
      if (!p.soloAdmin && p.id !== "p-pin") assert.ok(SECCIONES.supervisor.includes(p.ir), `${p.id}: el supervisor no tiene «${p.ir}»`);
    }
  }
});

test("búsqueda local sin acentos ni mayúsculas; todas las palabras deben aparecer", () => {
  const a = preguntasDe("admin");
  assert.ok(buscar(a, "pin").some((p) => p.id === "desbloquear-pin"));
  assert.ok(buscar(a, "RONDIN").some((p) => p.id === "puntos-rondin"), "sin acento encuentra «rondín»");
  assert.deepEqual(buscar(a, ""), a);
  assert.equal(buscar(a, "zzzz inexistente").length, 0);
  assert.ok(buscar(a, "turno plantilla").every((p) => /plantilla/i.test(p.pasos.join(" "))));
});
