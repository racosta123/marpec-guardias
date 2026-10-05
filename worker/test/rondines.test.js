import { test } from "node:test";
import assert from "node:assert/strict";
import { calcularRondin, cumplimiento, elegirSlot, generarSlots, programaEfectivo, validarPrograma } from "../src/rondines.js";
import { localAMs } from "../src/common.js";

const MIN = 60000, H = 60 * MIN;
const hh = (ms) => new Date(ms - 7 * H).toISOString().slice(0, 16).replace("T", " ");
const P = (id, nombre, orden) => ({ puntoId: id, nombre, orden });
const REQ = [P("p1", "Portón", 1), P("p2", "Bodega", 2), P("p3", "Azotea", 3)];
const slot = { indice: 0, programadoMs: localAMs("2026-10-05", "22:00"), abreMs: localAMs("2026-10-05", "21:45"), cierraInicioMs: localAMs("2026-10-05", "22:15"), venceMs: localAMs("2026-10-05", "22:45") };
const esc = (puntoId, min) => ({ puntoId, tsMs: slot.programadoMs + min * MIN });
const calc = (o) => calcularRondin({ slot, modo: "libre", requeridos: REQ, ahora: slot.programadoMs, entradaMs: slot.programadoMs - H, ...o });

test("slots 'cada X horas' dentro del turno (nocturno que cruza medianoche, Hermosillo)", () => {
  const noc = { inicioMs: localAMs("2026-10-05", "19:00"), finMs: localAMs("2026-10-06", "07:00") };
  const s = generarSlots(noc, { frecuencia: { tipo: "cada_horas", cadaHoras: 3 } });
  assert.deepEqual(s.map((x) => hh(x.programadoMs)), ["2026-10-05 22:00", "2026-10-06 01:00", "2026-10-06 04:00"], "19+3, +6, +9; el de las 07:00 ya no cabe (no es antes del fin)");
  assert.deepEqual(s.map((x) => x.indice), [0, 1, 2]);
  assert.equal(s[0].abreMs, s[0].programadoMs - 15 * MIN);
  assert.equal(s[0].cierraInicioMs, s[0].programadoMs + 15 * MIN);
  assert.equal(s[0].venceMs, s[0].programadoMs + 45 * MIN);
  const t24 = { inicioMs: localAMs("2026-10-05", "07:00"), finMs: localAMs("2026-10-06", "07:00") };
  assert.equal(generarSlots(t24, { frecuencia: { tipo: "cada_horas", cadaHoras: 4 } }).length, 5, "24x24 cada 4 h: 11, 15, 19, 23, 03");
  assert.equal(generarSlots(noc, { frecuencia: { tipo: "cada_horas", cadaHoras: 0.1 } }).length, 0, "frecuencias absurdas no generan nada");
  assert.equal(generarSlots({ inicioMs: 0, finMs: 1000 * 365 * 24 * H }, { frecuencia: { tipo: "cada_horas", cadaHoras: 0.5 } }).length, 60, "tope por turno");
});

test("slots por horarios fijos: solo los que caen dentro del turno, incluso tras medianoche", () => {
  const noc = { inicioMs: localAMs("2026-10-05", "19:00"), finMs: localAMs("2026-10-06", "07:00") };
  const s = generarSlots(noc, { frecuencia: { tipo: "horarios", horarios: ["06:00", "23:30", "02:00", "12:00", "19:00", "07:00"] } });
  assert.deepEqual(s.map((x) => hh(x.programadoMs)), ["2026-10-05 19:00", "2026-10-05 23:30", "2026-10-06 02:00", "2026-10-06 06:00"], "19:00 (inicio) entra; 07:00 (fin) y 12:00 no");
  const dia = { inicioMs: localAMs("2026-10-05", "07:00"), finMs: localAMs("2026-10-05", "19:00") };
  assert.deepEqual(generarSlots(dia, { frecuencia: { tipo: "horarios", horarios: ["06:00", "10:00", "14:00", "23:30"] } }).map((x) => hh(x.programadoMs)), ["2026-10-05 10:00", "2026-10-05 14:00"]);
  assert.deepEqual(generarSlots(dia, { toleranciaInicioMin: 5, toleranciaFinMin: 20, frecuencia: { tipo: "horarios", horarios: ["10:00"] } }).map((x) => [x.cierraInicioMs - x.programadoMs, x.venceMs - x.programadoMs]), [[5 * MIN, 20 * MIN]]);
});

test("estado del rondín: programado → pendiente → no iniciado; en curso → completo/incompleto", () => {
  assert.equal(calc({ ahora: slot.abreMs - MIN }).estado, "programado");
  assert.equal(calc({ ahora: slot.abreMs }).estado, "pendiente", "la ventana abre 15 min antes");
  assert.equal(calc({ ahora: slot.cierraInicioMs }).estado, "pendiente");
  assert.equal(calc({ ahora: slot.cierraInicioMs + MIN }).estado, "no_iniciado", "pasada la tolerancia de inicio sin escanear nada");
  const c = calc({ escaneos: [esc("p1", 1)], ahora: slot.programadoMs + 5 * MIN });
  assert.equal(c.estado, "en_curso");
  assert.equal(c.hechos, 1);
  assert.equal(c.porcentaje, 33);
  assert.deepEqual(c.faltantes.map((f) => f.nombre), ["Bodega", "Azotea"]);
  assert.equal(calc({ escaneos: [esc("p1", 1)], ahora: slot.venceMs }).estado, "en_curso", "hasta el último minuto del plazo");
  const inc = calc({ escaneos: [esc("p1", 1), esc("p3", 4)], ahora: slot.venceMs + MIN });
  assert.equal(inc.estado, "incompleto");
  assert.deepEqual(inc.saltados, ["Bodega"], "punto saltado");
  const ok = calc({ escaneos: [esc("p1", 1), esc("p2", 3), esc("p3", 5)], ahora: slot.venceMs + 60 * MIN });
  assert.equal(ok.estado, "completo");
  assert.equal(ok.porcentaje, 100);
  assert.equal(ok.finalizadoMs, slot.programadoMs + 5 * MIN);
  assert.equal(ok.iniciadoMs, slot.programadoMs + MIN);
});

test("hora de cada punto en el detalle; el primer escaneo de un punto es el que cuenta", () => {
  const r = calc({ escaneos: [esc("p2", 2), esc("p1", 1), { ...esc("p1", 9), nota: "duplicado tardío" }], ahora: slot.programadoMs + 10 * MIN });
  assert.equal(r.detalle.find((d) => d.puntoId === "p1").tsMs, slot.programadoMs + MIN);
  assert.deepEqual(r.detalle.map((d) => [d.nombre, d.hecho]), [["Portón", true], ["Bodega", true], ["Azotea", false]]);
});

test("ruta ordenada: el siguiente punto esperado; libre: sin orden", () => {
  assert.equal(calc({ modo: "ordenada", ahora: slot.programadoMs }).siguientePuntoId, "p1");
  assert.equal(calc({ modo: "ordenada", escaneos: [esc("p1", 1)], ahora: slot.programadoMs }).siguientePuntoId, "p2");
  assert.equal(calc({ modo: "ordenada", escaneos: [esc("p1", 1), esc("p2", 2), esc("p3", 3)], ahora: slot.programadoMs }).siguientePuntoId, null);
  assert.equal(calc({ modo: "libre", ahora: slot.programadoMs }).siguientePuntoId, null);
});

test("ajustes con motivo: marcar un punto, justificar el rondín; el guardia ausente no genera 'no iniciado'", () => {
  const aj = { tipo: "marcar_punto", puntoId: "p2", tsMs: slot.programadoMs + 20 * MIN, horaMs: slot.programadoMs + 4 * MIN, motivo: "Escaneó pero el QR estaba dañado", autorNombre: "Sara Sup" };
  const r = calc({ escaneos: [esc("p1", 1), esc("p3", 2)], ajustes: [aj], ahora: slot.venceMs + MIN });
  assert.equal(r.estado, "completo");
  const d = r.detalle.find((x) => x.puntoId === "p2");
  assert.equal(d.origen, "ajuste");
  assert.equal(d.ajustePor, "Sara Sup");
  assert.equal(d.tsMs, slot.programadoMs + 4 * MIN);
  const j = calc({ ajustes: [{ tipo: "justificar_rondin", tsMs: 1, motivo: "Evacuación por simulacro", autorNombre: "Sara Sup" }], ahora: slot.venceMs + H });
  assert.equal(j.estado, "justificado");
  assert.equal(j.justificadoPor, "Sara Sup");
  assert.equal(calc({ entradaMs: null, ahora: slot.cierraInicioMs + MIN }).estado, "no_exigible", "sin entrada del guardia ya hay falta; no se duplica la alerta");
  assert.equal(calc({ entradaMs: null, ahora: slot.programadoMs }).estado, "pendiente", "aún dentro de la tolerancia");
});

test("elegirSlot: el rondín en curso o el que tiene ventana de inicio abierta", () => {
  const slots = [0, 1, 2].map((i) => ({ indice: i, programadoMs: 1000 * H + i * 2 * H, abreMs: 1000 * H + i * 2 * H - 15 * MIN, cierraInicioMs: 1000 * H + i * 2 * H + 15 * MIN, venceMs: 1000 * H + i * 2 * H + 45 * MIN }));
  const e = (a, b, c) => ({ 0: a, 1: b, 2: c });
  assert.equal(elegirSlot(slots, e("pendiente", "programado", "programado"), 1000 * H)?.indice, 0);
  assert.equal(elegirSlot(slots, e("en_curso", "programado", "programado"), 1000 * H + 30 * MIN)?.indice, 0, "en curso, ya pasó la tolerancia de inicio");
  assert.equal(elegirSlot(slots, e("no_iniciado", "programado", "programado"), 1000 * H + 30 * MIN), null, "no hay rondín activo entre uno y otro");
  assert.equal(elegirSlot(slots, e("completo", "pendiente", "programado"), 1000 * H + 2 * H)?.indice, 1);
  assert.equal(elegirSlot(slots, e("completo", "completo", "completo"), 1000 * H + 4 * H), null);
});

test("cumplimiento: completos / exigibles (justificados y futuros no cuentan)", () => {
  const r = cumplimiento([{ estado: "completo" }, { estado: "completo" }, { estado: "incompleto" }, { estado: "no_iniciado" }, { estado: "justificado" }, { estado: "programado" }, { estado: "pendiente" }, { estado: "en_curso" }, { estado: "no_exigible" }]);
  assert.deepEqual(r, { exigibles: 4, completos: 2, incompletos: 1, noIniciados: 1, porcentaje: 50 });
  assert.equal(cumplimiento([]).porcentaje, null);
});

test("validación de la programación", () => {
  const ok = { modo: "ordenada", frecuencia: { tipo: "cada_horas", cadaHoras: 2 }, toleranciaInicioMin: 10, toleranciaFinMin: 30 };
  assert.deepEqual(validarPrograma(ok), ok);
  assert.deepEqual(validarPrograma({ ...ok, frecuencia: { tipo: "horarios", horarios: ["22:00", "02:00", "22:00"] } }).frecuencia.horarios, ["02:00", "22:00"]);
  for (const mal of [{ modo: "x" }, { frecuencia: { tipo: "cada_horas", cadaHoras: 0 } }, { frecuencia: { tipo: "cada_horas", cadaHoras: 25 } }, { frecuencia: { tipo: "cada_horas", cadaHoras: "2" } },
    { frecuencia: { tipo: "horarios", horarios: [] } }, { frecuencia: { tipo: "horarios", horarios: ["25:00"] } }, { frecuencia: { tipo: "otra" } },
    { toleranciaInicioMin: -1 }, { toleranciaInicioMin: 1.5 }, { toleranciaFinMin: 2 }, { toleranciaInicioMin: 60, toleranciaFinMin: 30 }])
    assert.throws(() => validarPrograma({ ...ok, ...mal }), undefined, JSON.stringify(mal));
  assert.equal(programaEfectivo(null).modo, "libre");
});
