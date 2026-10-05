// Reglas de la Fase 6 (pánico, registros sin conexión y panel en vivo) con el emulador oficial.
// Ejecutar con:  npm run test:rules   (requiere Java). Usa su propio projectId para no chocar con rules.test.js.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import { doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where, onSnapshot } from "firebase/firestore";

let env;
before(async () => {
  env = await initializeTestEnvironment({ projectId: "demo-marpec6", firestore: { rules: readFileSync("firebase/firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 } });
});
after(async () => env?.cleanup());

const T = 1_800_000_000_000;
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const put = (p, d) => setDoc(doc(ctx.firestore(), p), d);
    await put("usuarios/g-G001", { nombre: "Gael", rol: "guardia", activo: true, sitiosAsignados: ["siteA"] });
    await put("usuarios/g-G002", { nombre: "Gema", rol: "guardia", activo: true, sitiosAsignados: ["siteB"] });
    await put("usuarios/sup1", { nombre: "Sara", rol: "supervisor", activo: true });
    await put("usuarios/sup2", { nombre: "Saúl", rol: "supervisor", activo: true });
    await put("usuarios/adm1", { nombre: "Ana", rol: "admin", activo: true });
    for (const [s, sup, g] of [["A", "sup1", "g-G001"], ["B", "sup2", "g-G002"]]) {
      await put(`asistencias/t${s}`, { turnoId: `t${s}`, sitioId: `site${s}`, supervisorUid: sup, guardiaUid: g, inicioMs: T, estado: "en_turno" });
      await put(`rondines/t${s}_0`, { sitioId: `site${s}`, supervisorUid: sup, guardiaUid: g, programadoMs: T, estado: "en_curso" });
      await put(`incidenciasResumen/i${s}`, { sitioId: `site${s}`, supervisorUid: sup, guardiaUid: g, creadoMs: T, estado: "abierta" });
      await put(`visitantesVista/v${s}`, { sitioId: `site${s}`, supervisorUid: sup, dentro: true, entradaMs: T });
    }
    await put("panicos/p1", { guardiaUid: "g-G001", sitioId: "siteA", tsMs: T, lat: 29.07, lng: -110.95 });
    await put("panicoVista/p1", { panicoId: "p1", sitioId: "siteA", supervisorUid: "sup1", guardiaUid: "g-G001", estado: "activa", tsMs: T });
    await put("panicoVista/p2", { panicoId: "p2", sitioId: "siteB", supervisorUid: "sup2", guardiaUid: "g-G002", estado: "activa", tsMs: T });
    await put("panicoVista/p3", { panicoId: "p3", sitioId: null, supervisorUid: null, guardiaUid: "g-G002", estado: "activa", sinSitio: true, tsMs: T });
    await put("atencionesPanico/p1", { panicoId: "p1", atendidaPorUid: "sup1" });
    await put("registrosOffline/r1", { clientId: "x", guardiaUid: "g-G001", tipo: "entrada", refPath: "marcas/tA_entrada" });
    await put("offlineVista/r1", { registroId: "r1", sitioId: "siteA", supervisorUid: "sup1", guardiaUid: "g-G001", tipo: "entrada", estadoRevision: "pendiente", tsMs: T });
    await put("offlineVista/r2", { registroId: "r2", sitioId: "siteB", supervisorUid: "sup2", guardiaUid: "g-G002", tipo: "novedad", estadoRevision: "pendiente", tsMs: T });
    await put("revisionesOffline/r1", { registroId: "r1", accion: "aceptar" });
    await put("pushSuscripciones/ps1", { uid: "sup1", rol: "supervisor", endpoint: "https://fcm.googleapis.com/x", p256dh: "k", auth: "a" });
    await put("pushEnviados/relevo-tA", { evento: "relevo" });
  });
});

const guardia = (uid = "g-G001") => env.authenticatedContext(uid, { rol: "guardia" });
const sup = (uid = "sup1") => env.authenticatedContext(uid, { rol: "supervisor" });
const adm = () => env.authenticatedContext("adm1", { rol: "admin" });
const esperar = async (cond, ms = 8000) => { const t0 = Date.now(); while (!cond()) { if (Date.now() - t0 > ms) return; await new Promise((r) => setTimeout(r, 25)); } };

test("pánico: el guardia NO lee alertas; el supervisor solo las de SUS sitios; admin todas; ninguna escritura desde el cliente", async () => {
  const g = guardia().firestore();
  for (const p of ["panicos/p1", "panicoVista/p1", "atencionesPanico/p1"]) await assertFails(getDoc(doc(g, p)));
  const s1 = sup("sup1").firestore();
  await assertSucceeds(getDoc(doc(s1, "panicoVista/p1")));
  await assertFails(getDoc(doc(s1, "panicoVista/p2")));
  await assertFails(getDoc(doc(s1, "panicoVista/p3")));
  for (const p of ["panicos/p1", "atencionesPanico/p1"]) await assertFails(getDoc(doc(s1, p)));
  await assertSucceeds(getDocs(query(collection(s1, "panicoVista"), where("supervisorUid", "==", "sup1"))));
  await assertFails(getDocs(collection(s1, "panicoVista")));
  await assertFails(getDocs(query(collection(s1, "panicoVista"), where("supervisorUid", "==", "sup2"))));
  await assertFails(getDocs(query(collection(s1, "panicoVista"), where("estado", "==", "activa"))));
  const a = adm().firestore();
  for (const p of ["panicos/p1", "panicoVista/p1", "panicoVista/p2", "panicoVista/p3", "atencionesPanico/p1", "revisionesOffline/r1"]) await assertSucceeds(getDoc(doc(a, p)));
  await assertSucceeds(getDocs(query(collection(a, "panicoVista"), where("estado", "==", "activa"))));
  for (const [db, quien] of [[g, "guardia"], [s1, "supervisor"], [a, "admin"]]) {
    await assertFails(setDoc(doc(db, "panicoVista/nuevo"), { estado: "activa", supervisorUid: "sup1" }), quien);
    await assertFails(updateDoc(doc(db, "panicoVista/p1"), { estado: "atendida" }), quien);
    await assertFails(deleteDoc(doc(db, "panicoVista/p1")), quien);
    await assertFails(updateDoc(doc(db, "panicos/p1"), { lat: 0 }), quien);
    await assertFails(setDoc(doc(db, "atencionesPanico/otra"), { panicoId: "p1" }), quien);
  }
});

test("sin conexión: bandeja de revisión solo del supervisor del sitio y admin; idempotencia y push cerradas para todos", async () => {
  const g = guardia().firestore(), s1 = sup("sup1").firestore(), s2 = sup("sup2").firestore(), a = adm().firestore();
  await assertFails(getDoc(doc(g, "offlineVista/r1")));
  await assertSucceeds(getDoc(doc(s1, "offlineVista/r1")));
  await assertFails(getDoc(doc(s1, "offlineVista/r2")));
  await assertFails(getDoc(doc(s2, "offlineVista/r1")));
  await assertSucceeds(getDocs(query(collection(s1, "offlineVista"), where("supervisorUid", "==", "sup1"), where("estadoRevision", "==", "pendiente"))));
  await assertFails(getDocs(collection(s1, "offlineVista")));
  await assertSucceeds(getDoc(doc(a, "offlineVista/r1")));
  await assertFails(getDoc(doc(s1, "revisionesOffline/r1")));
  for (const [db, quien] of [[g, "guardia"], [s1, "supervisor"], [a, "admin"]]) {
    for (const p of ["registrosOffline/r1", "pushSuscripciones/ps1", "pushEnviados/relevo-tA"]) {
      await assertFails(getDoc(doc(db, p)), `${quien} lee ${p}`);
      await assertFails(setDoc(doc(db, p), { a: 1 }), `${quien} escribe ${p}`);
    }
    await assertFails(updateDoc(doc(db, "offlineVista/r1"), { estadoRevision: "aceptado" }), quien);
    await assertFails(setDoc(doc(db, "revisionesOffline/nuevo"), { accion: "aceptar" }), quien);
  }
  await assertFails(getDocs(collection(a, "pushSuscripciones")));
});

test("panel en vivo: el supervisor recibe en TIEMPO REAL lo de sus sitios; la escucha de sitios ajenos es rechazada", async () => {
  const s1 = sup("sup1").firestore();
  const q = (c, uid) => query(collection(s1, c), where("supervisorUid", "==", uid));
  const vistos = [];
  let errorPropio = null;
  const baja = onSnapshot(query(collection(s1, "panicoVista"), where("supervisorUid", "==", "sup1"), where("estado", "==", "activa")), (snap) => vistos.push(snap.docs.map((d) => d.id).sort().join(",")), (e) => { errorPropio = e; });
  await esperar(() => vistos.length >= 1);
  assert.equal(errorPropio, null);
  assert.equal(vistos.at(-1), "p1");
  // llega una alerta nueva de su sitio y otra de un sitio ajeno: solo la propia aparece, sin pedirla
  await env.withSecurityRulesDisabled(async (c) => {
    await setDoc(doc(c.firestore(), "panicoVista/p9"), { panicoId: "p9", sitioId: "siteA", supervisorUid: "sup1", estado: "activa", tsMs: T + 5 });
    await setDoc(doc(c.firestore(), "panicoVista/p10"), { panicoId: "p10", sitioId: "siteB", supervisorUid: "sup2", estado: "activa", tsMs: T + 6 });
  });
  await esperar(() => vistos.at(-1) === "p1,p9");
  assert.equal(vistos.at(-1), "p1,p9");
  await env.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), "panicoVista/p9"), { estado: "atendida", atendidaPorNombre: "Sara" }));
  await esperar(() => vistos.at(-1) === "p1");
  assert.equal(vistos.at(-1), "p1", "al atenderse sale de las activas en vivo");
  baja();
  const colecciones = ["panicoVista", "asistencias", "rondines", "incidenciasResumen", "visitantesVista", "offlineVista"];
  // escuchas de datos AJENOS: permiso denegado y no llega ningún documento
  for (const c of colecciones) {
    let recibidos = 0, err = null;
    const off = onSnapshot(q(c, "sup2"), () => { recibidos++; }, (e) => { err = e; });
    await esperar(() => err !== null || recibidos > 0);
    off();
    assert.ok(err && err.code === "permission-denied", `${c}: la escucha ajena debe fallar`);
    assert.equal(recibidos, 0, `${c}: no debe llegar nada`);
  }
  // escucha sin filtro (podría incluir sitios ajenos): rechazada completa
  const limpio = sup("sup1").firestore(); // contexto nuevo: sin caché local que responda antes que el servidor
  for (const c of colecciones) {
    let err = null, recibidos = 0;
    const off = onSnapshot(collection(limpio, c), () => { recibidos++; }, (e) => { err = e; });
    await esperar(() => err !== null || recibidos > 0);
    off();
    assert.ok(err && err.code === "permission-denied" && recibidos === 0, `${c}: sin filtro`);
  }
  // las escuchas propias de cada colección del panel SÍ funcionan
  for (const c of colecciones) {
    let err = null, n = null;
    const off = onSnapshot(q(c, "sup1"), (s) => { n = s.size; }, (e) => { err = e; });
    await esperar(() => err !== null || n !== null);
    off();
    assert.equal(err, null, `${c}: escucha propia`);
    assert.ok(n >= 1, `${c}: trae lo suyo`);
  }
  // un guardia no escucha ni alertas ni la bandeja
  const g = guardia().firestore();
  for (const c of ["panicoVista", "offlineVista"]) {
    let err = null;
    const off = onSnapshot(query(collection(g, c), where("guardiaUid", "==", "g-G001")), () => {}, (e) => { err = e; });
    await esperar(() => err !== null);
    off();
    assert.equal(err?.code, "permission-denied", c);
  }
  // el admin escucha todo en tiempo real
  const a = adm().firestore();
  const filas = [];
  const offA = onSnapshot(query(collection(a, "panicoVista"), where("estado", "==", "activa")), (s) => filas.push(s.size));
  await esperar(() => filas.length >= 1);
  offA();
  assert.equal(filas[0], 4, "p1, p2, p10 y la alerta sin sitio");
});

test("supervisor dado de baja deja de recibir el panel en vivo al instante (el perfil se consulta en cada lectura)", async () => {
  const s1 = sup("sup1").firestore();
  await assertSucceeds(getDocs(query(collection(s1, "panicoVista"), where("supervisorUid", "==", "sup1"))));
  await env.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), "usuarios/sup1"), { activo: false }));
  await assertFails(getDocs(query(collection(s1, "panicoVista"), where("supervisorUid", "==", "sup1"))));
  let err = null;
  const off = onSnapshot(query(collection(s1, "offlineVista"), where("supervisorUid", "==", "sup1")), () => {}, (e) => { err = e; });
  await esperar(() => err !== null);
  off();
  assert.equal(err?.code, "permission-denied");
});
