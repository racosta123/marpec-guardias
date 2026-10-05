// Lógica pura del panel en vivo y del rondín local (sin red ni DOM).
import { test } from "node:test";
import assert from "node:assert/strict";
import { contar, estadoPuestos, eventosRecientes } from "../js/vivo-estado.js";
import { rondinLocal } from "../js/rondin-local.js";

const H = 3600e3, MIN = 60e3;
const T0 = 1_800_000_000_000;
const sitios = [{ id: "A", nombre: "Plaza Norte" }, { id: "B", nombre: "Bodega Sur" }, { id: "C", nombre: "Casa Club" }, { id: "D", nombre: "Depósito" }, { id: "E", nombre: "Estación" }];
const turno = (id, sitioId, ini, fin, extra = {}) => ({ id, sitioId, inicioMs: ini, finMs: fin, estado: "programado", guardiaUid: "g", ...extra });
const est = (r, id) => r.find((p) => p.sitioId === id);

test("estados: cubierto, en rondín, descubierto, sin turno, alerta y pánico (con prioridad)", () => {
  const ahora = T0;
  const turnos = [turno("tA", "A", ahora - 2 * H, ahora + 10 * H), turno("tB", "B", ahora - 1 * H, ahora + 11 * H), turno("tC", "C", ahora - 30 * MIN, ahora + 11 * H), turno("tE", "E", ahora - 2 * H, ahora + 10 * H), turno("tD", "D", ahora + 5 * H, ahora + 15 * H)];
  const asistencias = [
    { turnoId: "tA", sitioId: "A", guardiaNombre: "Gael", entradaMs: ahora - 110 * MIN, salidaMs: null },
    { turnoId: "tB", sitioId: "B", guardiaNombre: "Gema", entradaMs: ahora - 50 * MIN, salidaMs: null },
    { turnoId: "tC", sitioId: "C", guardiaNombre: "Gus", entradaMs: null, salidaMs: null },
    { turnoId: "tE", sitioId: "E", guardiaNombre: "Eva", entradaMs: ahora - 2 * H, salidaMs: null, relevoAlerta: false },
  ];
  const rondines = [{ turnoId: "tB", sitioId: "B", estado: "en_curso", venceMs: ahora + 20 * MIN }];
  const r = estadoPuestos({ sitios, turnos, asistencias, rondines, ahora });
  assert.equal(est(r, "A").estado, "cubierto");
  assert.equal(est(r, "B").estado, "en_rondin");
  assert.equal(est(r, "C").estado, "descubierto", "turno vigente y el guardia no ha marcado entrada");
  assert.equal(est(r, "D").estado, "sin_turno", "su turno empieza más tarde");
  assert.equal(est(r, "A").guardia, "Gael");
  assert.deepEqual(contar(r), { total: 5, cubiertos: 3, descubiertos: 1, enAlerta: 0, enRondin: 1, panicos: 0 });
  // alertas
  const r2 = estadoPuestos({ sitios, turnos, asistencias: [...asistencias.slice(0, 3), { turnoId: "tE", sitioId: "E", guardiaNombre: "Eva", entradaMs: ahora - 2 * H, relevoAlerta: true, finMs: ahora - 10 * MIN }], rondines, ahora,
    incidencias: [{ sitioId: "A", gravedad: "alta", estado: "abierta", creadoMs: ahora - H, tipoNombre: "Robo" }, { sitioId: "B", gravedad: "alta", estado: "cerrada", creadoMs: ahora - H }, { sitioId: "C", gravedad: "media", estado: "abierta", creadoMs: ahora - H }],
    panicos: [{ sitioId: "B", estado: "activa", guardiaNombre: "Gema", tsMs: ahora - MIN }, { sitioId: "C", estado: "atendida", tsMs: ahora - H }] });
  assert.equal(est(r2, "A").estado, "alerta", "incidencia alta abierta");
  assert.equal(est(r2, "B").estado, "panico", "el pánico manda sobre el rondín; la alta CERRADA no cuenta");
  assert.equal(est(r2, "C").estado, "descubierto", "media y pánico atendido no son alertas");
  assert.equal(est(r2, "E").estado, "alerta", "relevo que no llegó");
  assert.deepEqual(r2.map((p) => p.sitioId).slice(0, 3), ["B", "E", "A"], "ordenados: pánico, luego alertas (por nombre)");
  assert.equal(contar(r2).panicos, 1);
  assert.equal(est(r2, "B").alertas[0].tipo, "panico");
});

test("estados: turno que terminó pero el guardia sigue sin cerrar sigue cubierto; cancelado y sitio inactivo no cuentan; rondín no iniciado reciente alerta", () => {
  const ahora = T0;
  const base = { sitios: [{ id: "A", nombre: "A" }, { id: "B", nombre: "B", activo: false }, { id: "C", nombre: "C" }], ahora };
  const r = estadoPuestos({ ...base,
    turnos: [turno("t1", "A", ahora - 13 * H, ahora - 1 * H), turno("t3", "C", ahora - 2 * H, ahora + 2 * H, { estado: "cancelado" })],
    asistencias: [{ turnoId: "t1", sitioId: "A", guardiaNombre: "Gael", entradaMs: ahora - 13 * H, salidaMs: null, finMs: ahora - H }] });
  assert.equal(est(r, "A").estado, "cubierto", "sigue en el puesto (horas extra)");
  assert.equal(est(r, "B"), undefined, "sitio inactivo");
  assert.equal(est(r, "C").estado, "sin_turno", "turno cancelado");
  const r2 = estadoPuestos({ ...base, turnos: [turno("t1", "A", ahora - 5 * H, ahora + 5 * H)], asistencias: [{ turnoId: "t1", sitioId: "A", guardiaNombre: "Gael", entradaMs: ahora - 5 * H, salidaMs: null }],
    rondines: [{ turnoId: "t1", sitioId: "A", estado: "no_iniciado", venceMs: ahora - 30 * MIN }, { turnoId: "t1", sitioId: "C", estado: "no_iniciado", venceMs: ahora - 5 * H }] });
  assert.equal(est(r2, "A").estado, "alerta");
  assert.equal(est(r2, "A").alertas[0].texto, "Rondín no iniciado");
  // un rondín no iniciado de hace horas ya no es alerta en vivo
  const r3 = estadoPuestos({ ...base, turnos: [turno("t1", "A", ahora - 5 * H, ahora + 5 * H)], asistencias: [{ turnoId: "t1", sitioId: "A", entradaMs: ahora - 5 * H }], rondines: [{ turnoId: "t1", sitioId: "A", estado: "no_iniciado", venceMs: ahora - 3 * H }] });
  assert.equal(est(r3, "A").estado, "cubierto");
});

test("estados: registros sin conexión por revisar se cuentan por puesto", () => {
  const r = estadoPuestos({ sitios: [{ id: "A", nombre: "A" }], turnos: [], ahora: T0, offline: [{ sitioId: "A", estadoRevision: "pendiente" }, { sitioId: "A", estadoRevision: "aceptado" }, { sitioId: "B", estadoRevision: "pendiente" }] });
  assert.equal(r[0].porRevisar, 1);
});

test("eventos recientes: mezcla fuentes, más nuevo primero, solo últimas 24 h, con etiqueta sin conexión", () => {
  const ahora = T0;
  const ev = eventosRecientes({ ahora,
    asistencias: [{ guardiaNombre: "Gael", sitioNombre: "Plaza", entradaMs: ahora - 3 * H, entradaSinConexion: true, retardo: true, retardoMin: 12 }, { guardiaNombre: "Gema", sitioNombre: "Bodega", entradaMs: ahora - 30 * H }],
    incidencias: [{ gravedad: "alta", tipoNombre: "Robo", sitioNombre: "Plaza", creadoMs: ahora - H }],
    visitantes: [{ nombre: "Luis", sitioNombre: "Plaza", entradaMs: ahora - 2 * H, salidaMs: ahora - H + MIN }],
    panicos: [{ guardiaNombre: "Gael", sitioNombre: "Plaza", tsMs: ahora - 10 * MIN, atendidaMs: ahora - 5 * MIN, atendidaPorNombre: "Sara" }],
    rondines: [{ estado: "completo", finalizadoMs: ahora - 4 * H, hechos: 3, total: 3, sitioNombre: "Plaza" }, { estado: "no_iniciado", venceMs: ahora - 2 * H, sitioNombre: "Plaza" }] });
  assert.equal(ev.length, 8, "el evento de hace 30 h no aparece");
  assert.deepEqual(ev.map((e) => e.tipo), ["panico_atendido", "panico", "visitante", "incidencia_alta", "visitante", "rondin_mal", "entrada", "rondin"]);
  assert.match(ev[0].texto, /atendido por Sara/);
  assert.equal(ev.find((e) => e.tipo === "entrada").sin_conexion, true);
  assert.match(ev.find((e) => e.tipo === "entrada").texto, /retardo de 12 min/);
  assert.equal(eventosRecientes({ ahora, asistencias: Array.from({ length: 40 }, (_, i) => ({ guardiaNombre: "G", entradaMs: ahora - i * MIN })), max: 10 }).length, 10);
});

test("rondín local sin conexión: copia del servidor + escaneos en cola → progreso, siguiente punto y completo", () => {
  const ahora = T0;
  const plantilla = [{ puntoId: "p1", nombre: "Portón", orden: 1 }, { puntoId: "p2", nombre: "Bodega", orden: 2 }, { puntoId: "p3", nombre: "Azotea", orden: 3 }];
  const slot = (indice, prog) => ({ indice, programadoMs: prog, abreMs: prog - 15 * MIN, cierraInicioMs: prog + 15 * MIN, venceMs: prog + 45 * MIN, estado: "pendiente", hechos: 0, total: 3 });
  const copia = { hay: true, modo: "ordenada", plantilla, rondines: [slot(0, ahora), slot(1, ahora + 2 * H)], actual: { indice: 0, puntos: plantilla.map((p) => ({ ...p, hecho: p.puntoId === "p1", tsMs: p.puntoId === "p1" ? ahora - 5 * MIN : null })), hechos: 1, total: 3 } };
  const sc = (puntoId, t) => ({ tipo: "rondin", turnoId: "t", estado: "pendiente", horaEstimadaMs: t, meta: { puntoId } });
  let r = rondinLocal(copia, [], ahora);
  assert.equal(r.actual.hechos, 1);
  assert.equal(r.actual.siguientePuntoId, "p2", "ruta ordenada: el siguiente pendiente");
  r = rondinLocal(copia, [sc("p2", ahora + 2 * MIN)], ahora + 3 * MIN);
  assert.equal(r.actual.hechos, 2);
  assert.equal(r.actual.siguientePuntoId, "p3");
  assert.equal(r.actual.puntos.find((p) => p.puntoId === "p2").hecho, true);
  r = rondinLocal(copia, [sc("p2", ahora + 2 * MIN), sc("p3", ahora + 4 * MIN)], ahora + 5 * MIN);
  assert.equal(r.actual, null, "con los 3 puntos hechos ya no hay rondín pendiente");
  assert.equal(r.rondines[0].estado, "completo");
  assert.equal(r.proximoMs, ahora + 2 * H);
  // fuera de toda ventana: no hay rondín; sin plantilla: no hay programa
  assert.equal(rondinLocal(copia, [], ahora + 60 * MIN).actual, null);
  assert.equal(rondinLocal({ hay: true, rondines: [] }, [], ahora).hay, false);
  // un escaneo duplicado del mismo punto no suma dos veces
  assert.equal(rondinLocal(copia, [sc("p1", ahora + MIN), sc("p1", ahora + 2 * MIN)], ahora + 3 * MIN).actual.hechos, 1);
});
