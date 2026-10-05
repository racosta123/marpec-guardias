import { test } from "node:test";
import assert from "node:assert/strict";
import { acumuladoSemanal, calcularAsistencia, CONFIG_DEFECTO, fechaLocal, horaEfectiva, limiteHorasSemana, lunesDe, MIN } from "../src/asistencia.js";
import { localAMs } from "../src/common.js";
import { distanciaM } from "../src/geo.js";

const H = 60 * MIN;
const cfg = { ...CONFIG_DEFECTO, toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3, ventanaEntradaMin: 30, toleranciaRelevoMin: 30 };
const diurno = { inicioMs: localAMs("2026-10-05", "07:00"), finMs: localAMs("2026-10-05", "19:00"), estado: "programado" };
const calc = (o) => calcularAsistencia({ turno: diurno, config: cfg, ahora: diurno.inicioMs, ...o });

test("retardo y falta: límites exactos (tolerancia inclusive; falta al pasar el límite)", () => {
  const en = (min) => calc({ entradaMs: diurno.inicioMs + min * MIN + 20000, ahora: diurno.inicioMs + min * MIN + 20000 });
  assert.equal(en(0).retardo, false);
  assert.equal(en(10).retardo, false, "10 min = dentro de la tolerancia");
  assert.equal(en(11).retardo, true, "11 min = retardo");
  assert.equal(en(11).retardoMin, 11);
  assert.equal(en(30).retardo, true, "30 min = aún retardo");
  assert.equal(en(30).falta, false);
  assert.equal(en(31).falta, true, "pasado el límite = falta");
  assert.equal(en(31).motivoFalta, "entrada_tardia");
  assert.equal(en(31).retardo, false);
  assert.equal(en(-20).retardo, false, "llegar antes nunca es retardo");
  assert.equal(en(-20).retardoMin, 0);
});

test("falta por no marcar: se declara pasado el límite; antes sigue 'por marcar'", () => {
  assert.equal(calc({ ahora: diurno.inicioMs + 29 * MIN }).estado, "por_marcar");
  assert.equal(calc({ ahora: diurno.inicioMs + 30 * MIN }).falta, false);
  const f = calc({ ahora: diurno.inicioMs + 31 * MIN });
  assert.equal(f.falta, true);
  assert.equal(f.estado, "falta");
  assert.equal(f.motivoFalta, "sin_entrada");
  assert.equal(calc({ ahora: diurno.inicioMs - 31 * MIN }).estado, "programado");
  assert.equal(calc({ ahora: diurno.inicioMs - 30 * MIN }).estado, "por_marcar", "la ventana abre 30 min antes");
});

test("horas extra: solo con entrada; salida tardía y en curso; autorizado/rechazado/obsoleto", () => {
  const entrada = diurno.inicioMs + 2 * MIN;
  const base = { entradaMs: entrada };
  assert.equal(calc({ ...base, salidaMs: diurno.finMs - 5 * MIN, ahora: diurno.finMs }).minutosExtra, 0);
  assert.equal(calc({ ...base, salidaMs: diurno.finMs - 5 * MIN, ahora: diurno.finMs }).salidaAnticipadaMin, 5);
  const c1 = calc({ ...base, salidaMs: diurno.finMs + 90 * MIN, ahora: diurno.finMs + 2 * H });
  assert.equal(c1.minutosExtra, 90);
  assert.equal(c1.extraEstado, "pendiente");
  assert.equal(c1.extraEnCurso, false);
  assert.equal(calc({ ...base, salidaMs: diurno.finMs + 90 * MIN, ahora: diurno.finMs + 2 * H, decisionExtra: { estado: "autorizado", minutos: 90 } }).extraEstado, "autorizado");
  assert.equal(calc({ ...base, salidaMs: diurno.finMs + 90 * MIN, ahora: diurno.finMs + 2 * H, decisionExtra: { estado: "rechazado", minutos: 90 } }).extraEstado, "rechazado");
  assert.equal(calc({ ...base, salidaMs: diurno.finMs + 90 * MIN, ahora: diurno.finMs + 2 * H, decisionExtra: { estado: "autorizado", minutos: 60 } }).extraEstado, "pendiente", "decisión sobre otros minutos queda obsoleta");
  const enCurso = calc({ ...base, ahora: diurno.finMs + 40 * MIN });
  assert.equal(enCurso.minutosExtra, 40);
  assert.equal(enCurso.extraEnCurso, true);
  assert.equal(enCurso.extraEstado, "pendiente", "en curso no puede estar autorizada todavía");
  assert.equal(calc({ ahora: diurno.finMs + 40 * MIN }).minutosExtra, 0, "sin entrada no hay extra");
});

test("turno nocturno que cruza medianoche (Hermosillo): fecha, extra y retardo", () => {
  const noc = { inicioMs: localAMs("2026-10-05", "19:00"), finMs: localAMs("2026-10-06", "07:00"), estado: "programado" };
  assert.ok(noc.finMs - noc.inicioMs === 12 * H);
  assert.equal(fechaLocal(noc.inicioMs), "2026-10-05", "19:00 en Hermosillo ya es el día siguiente en UTC, pero la fecha local es el 5");
  assert.equal(new Date(noc.inicioMs).toISOString().slice(0, 10), "2026-10-06", "(UTC ya cambió de día)");
  const r = calcularAsistencia({ turno: noc, config: cfg, entradaMs: noc.inicioMs + 20 * MIN, salidaMs: noc.finMs + 45 * MIN, ahora: noc.finMs + H });
  assert.equal(r.retardo, true);
  assert.equal(r.retardoMin, 20);
  assert.equal(r.minutosExtra, 45);
  assert.equal(r.estado, "cumplido");
  // entrada a las 23:50 del mismo día local: tardó 4h50 → falta
  assert.equal(calcularAsistencia({ turno: noc, config: cfg, entradaMs: localAMs("2026-10-05", "23:50"), ahora: localAMs("2026-10-06", "00:10") }).motivoFalta, "entrada_tardia");
  // en curso a las 07:20 del día 6: relevo pendiente → extra en curso 20 min
  const curso = calcularAsistencia({ turno: noc, config: cfg, entradaMs: noc.inicioMs, ahora: noc.finMs + 20 * MIN });
  assert.equal(curso.minutosExtra, 20);
  assert.equal(curso.estado, "salida_pendiente");
});

test("turno 24x24: duración completa y extra posterior", () => {
  const t24 = { inicioMs: localAMs("2026-10-05", "07:00"), finMs: localAMs("2026-10-06", "07:00"), estado: "programado" };
  const ok = calcularAsistencia({ turno: t24, config: cfg, entradaMs: t24.inicioMs, salidaMs: t24.finMs, ahora: t24.finMs + H });
  assert.equal(ok.minutosExtra, 0);
  assert.equal(ok.estado, "cumplido");
  const ex = calcularAsistencia({ turno: t24, config: cfg, entradaMs: t24.inicioMs + 5 * MIN, salidaMs: t24.finMs + 150 * MIN, ahora: t24.finMs + 4 * H });
  assert.equal(ex.minutosExtra, 150);
  assert.equal(ex.retardo, false);
  const mitad = calcularAsistencia({ turno: t24, config: cfg, entradaMs: t24.inicioMs, ahora: t24.inicioMs + 13 * H });
  assert.equal(mitad.estado, "en_turno");
  assert.equal(mitad.minutosExtra, 0);
});

test("relevo: requerido, llegó, cierre autorizado y alerta (fin + tolerancia)", () => {
  const entrada = diurno.inicioMs;
  const sinRelevo = { existe: true, turnoId: "t2", guardiaUid: "g2", entradaMs: null };
  const alerta = (min, extra = {}) => calc({ entradaMs: entrada, ahora: diurno.finMs + min * MIN, sucesor: sinRelevo, ...extra });
  assert.equal(alerta(10).relevoAlerta, false, "dentro de la tolerancia");
  assert.equal(alerta(30).relevoAlerta, false);
  assert.equal(alerta(31).relevoAlerta, true, "fin + tolerancia + 1");
  assert.equal(alerta(31).estado, "relevo_no_llego");
  assert.equal(alerta(31).puedeCerrar, false);
  assert.equal(alerta(31, { sucesor: { ...sinRelevo, entradaMs: diurno.finMs } }).relevoAlerta, false, "el relevo ya llegó");
  assert.equal(alerta(31, { sucesor: { ...sinRelevo, entradaMs: diurno.finMs } }).puedeCerrar, true);
  assert.equal(alerta(31, { cierreAutorizado: true }).relevoAlerta, false);
  assert.equal(alerta(31, { cierreAutorizado: true }).puedeCerrar, true);
  assert.equal(alerta(31, { sucesor: { existe: false } }).relevoAlerta, false, "sin relevo previsto no hay alerta");
  assert.equal(alerta(31, { sucesor: { existe: false } }).puedeCerrar, true);
  assert.equal(alerta(31, { salidaMs: diurno.finMs + 31 * MIN }).relevoAlerta, false, "ya cerró");
  assert.equal(alerta(31).minutosExtra, 31, "el tiempo extra del saliente corre mientras espera");
});

test("ajustes: el último ajuste manda; la marca original no se toca", () => {
  const marca = 1000;
  assert.equal(horaEfectiva(marca, [], "entrada"), 1000);
  assert.equal(horaEfectiva(marca, [{ tipo: "entrada", horaMs: 500, tsMs: 1 }, { tipo: "entrada", horaMs: 700, tsMs: 2 }], "entrada"), 700);
  assert.equal(horaEfectiva(marca, [{ tipo: "salida", horaMs: 500, tsMs: 1 }], "entrada"), 1000);
  assert.equal(horaEfectiva(null, [{ tipo: "entrada", horaMs: 500, tsMs: 1 }], "entrada"), 500, "un ajuste puede registrar una entrada que faltó");
  assert.equal(horaEfectiva(null, [], "salida"), null);
});

test("límites legales de horas extra configurables por año (no fijos en el código)", () => {
  assert.equal(limiteHorasSemana({}, 2026), 9);
  assert.equal(limiteHorasSemana({}, 2027), 12);
  assert.equal(limiteHorasSemana({}, 2030), 12, "sin año propio: aplica el más reciente anterior");
  assert.equal(limiteHorasSemana({}, 2025), null, "antes del primer año configurado no hay límite definido");
  assert.equal(limiteHorasSemana({ limitesExtraPorAnio: [{ anio: 2026, horasSemana: 9 }, { anio: 2028, horasSemana: 15 }] }, 2027), 9);
  assert.equal(limiteHorasSemana({ limitesExtraPorAnio: [{ anio: 2026, horasSemana: 9 }, { anio: 2028, horasSemana: 15 }] }, 2028), 15);
});

test("acumulado semanal de extras (lunes a domingo, Hermosillo) y exceso por año", () => {
  assert.equal(lunesDe(localAMs("2026-10-04", "12:00")), "2026-09-28", "el domingo 4 pertenece a la semana del lunes 28");
  assert.equal(lunesDe(localAMs("2026-10-05", "00:30")), "2026-10-05");
  assert.equal(lunesDe(localAMs("2026-10-05", "23:30")), "2026-10-05");
  const mk = (fecha, hora, min, estado, g = "g1") => ({ guardiaUid: g, inicioMs: localAMs(fecha, hora), minutosExtra: min, extraEstado: estado });
  const filas = [
    mk("2026-10-05", "07:00", 240, "autorizado"), mk("2026-10-06", "07:00", 180, "pendiente"), mk("2026-10-09", "07:00", 150, "autorizado"), // 570 min = 9.5 h
    mk("2026-10-07", "07:00", 300, "rechazado"), mk("2026-10-08", "07:00", 0, "ninguno"),
    mk("2026-10-12", "07:00", 60, "autorizado"), mk("2026-10-05", "07:00", 600, "autorizado", "g2"),
  ];
  const r = acumuladoSemanal(filas, {});
  const g1 = r.find((x) => x.guardiaUid === "g1" && x.semana === "2026-10-05");
  assert.equal(g1.autorizadoMin, 390);
  assert.equal(g1.pendienteMin, 180);
  assert.equal(g1.rechazadoMin, 300);
  assert.equal(g1.horasConsideradas, 9.5, "los rechazados no cuentan");
  assert.equal(g1.limiteHoras, 9);
  assert.equal(g1.excedeLimite, true, "9.5 h > 9 h en 2026");
  assert.equal(r.find((x) => x.guardiaUid === "g1" && x.semana === "2026-10-12").excedeLimite, false);
  assert.equal(r.find((x) => x.guardiaUid === "g2").excedeLimite, true, "10 h > 9 h");
  // las mismas 10 h en 2027 (límite 12 h por la reforma): ya no exceden
  const en2027 = acumuladoSemanal([mk("2027-03-01", "07:00", 600, "autorizado")], {});
  assert.equal(en2027[0].limiteHoras, 12);
  assert.equal(en2027[0].excedeLimite, false);
  // y el límite sale de la configuración, no del código
  assert.equal(acumuladoSemanal([mk("2026-10-05", "07:00", 600, "autorizado")], { limitesExtraPorAnio: [{ anio: 2026, horasSemana: 12 }] })[0].excedeLimite, false);
});

test("distancia haversine (metros)", () => {
  assert.ok(distanciaM(29.0729, -110.9559, 29.0729, -110.9559) < 0.01);
  const d = distanciaM(29.0729, -110.9559, 29.0829, -110.9559); // 0.01° de latitud ≈ 1111 m
  assert.ok(d > 1100 && d < 1120, String(d));
  const d2 = distanciaM(29.0729, -110.9559, 29.0729, -110.9549); // 0.001° de longitud a 29° ≈ 97 m
  assert.ok(d2 > 95 && d2 < 99, String(d2));
});
