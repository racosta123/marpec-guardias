// Pruebas de reglas de Firestore y Storage con el emulador oficial.
// Ejecutar con:  npm run test:rules   (requiere Java para los emuladores de Firebase)
import { test, before, after, beforeEach } from "node:test";
import { readFileSync } from "node:fs";
import { initializeTestEnvironment, assertFails, assertSucceeds } from "@firebase/rules-unit-testing";
import {
  doc, getDoc, setDoc, updateDoc, deleteDoc, collection, getDocs, query, where, orderBy,
} from "firebase/firestore";
import { ref, getBytes, uploadBytes } from "firebase/storage";

let env;
before(async () => {
  env = await initializeTestEnvironment({
    projectId: "demo-marpec",
    firestore: { rules: readFileSync("firebase/firestore.rules", "utf8"), host: "127.0.0.1", port: 8080 },
    storage: { rules: readFileSync("firebase/storage.rules", "utf8"), host: "127.0.0.1", port: 9199 },
  });
});
after(async () => env?.cleanup());

const T = 1_800_000_000_000;
beforeEach(async () => {
  await env.clearFirestore();
  // Datos sembrados saltando las reglas (como lo haría el Worker).
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    const put = (p, d) => setDoc(doc(db, p), d);
    await put("usuarios/g-G001", { nombre: "Gael", rol: "guardia", activo: true, sitiosAsignados: ["siteA"] });
    await put("usuarios/g-G002", { nombre: "Gema", rol: "guardia", activo: true, sitiosAsignados: ["siteB"] });
    await put("usuarios/g-G003", { nombre: "Baja", rol: "guardia", activo: false, sitiosAsignados: ["siteA"] });
    await put("usuarios/g-G004", { nombre: "SinCampo", rol: "guardia", activo: true });
    await put("usuarios/sup1", { nombre: "Sara", rol: "supervisor", activo: true });
    await put("usuarios/sup2", { nombre: "Saúl", rol: "supervisor", activo: true });
    await put("usuarios/adm1", { nombre: "Ana", rol: "admin", activo: true });
    await put("credenciales/G001", { hash: "x", salt: "y", uid: "g-G001" });
    await put("ajustes/sistema", { adminCreado: true });
    await put("sitios/siteA", { nombre: "Sitio A", consignas: "A", supervisorUid: "sup1", qrVersion: 1, radioM: 100 });
    await put("sitios/siteB", { nombre: "Sitio B", consignas: "B", supervisorUid: "sup2", qrVersion: 1, radioM: 100 });
    await put("turnos/t1", { sitioId: "siteA", supervisorUid: "sup1", guardiaUid: "g-G001", inicioMs: T, finMs: T + 1 });
    await put("turnos/t2", { sitioId: "siteB", supervisorUid: "sup2", guardiaUid: "g-G002", inicioMs: T, finMs: T + 1 });
    await put("turnos/t3", { sitioId: "siteA", supervisorUid: "sup1", guardiaUid: null, inicioMs: T + 5, finMs: T + 6 });
    await put("marcas/t1_entrada", { turnoId: "t1", sitioId: "siteA", guardiaUid: "g-G001", tipo: "entrada", tsMs: T, fotoKey: "selfies/siteA/t1/entrada-x.jpg" });
    await put("marcas/t2_entrada", { turnoId: "t2", sitioId: "siteB", guardiaUid: "g-G002", tipo: "entrada", tsMs: T, fotoKey: "selfies/siteB/t2/entrada-y.jpg" });
    await put("asistencias/t1", { turnoId: "t1", sitioId: "siteA", supervisorUid: "sup1", guardiaUid: "g-G001", inicioMs: T, estado: "en_turno", extraEstado: "pendiente" });
    await put("asistencias/t2", { turnoId: "t2", sitioId: "siteB", supervisorUid: "sup2", guardiaUid: "g-G002", inicioMs: T, estado: "falta" });
    await put("ajustesAsistencia/a1", { turnoId: "t1", supervisorUid: "sup1", guardiaUid: "g-G001", tipo: "entrada", motivo: "x" });
    await put("autorizaciones/t1_cierre", { tipo: "cierre", turnoId: "t1", supervisorUid: "sup1", guardiaUid: "g-G001", motivo: "x" });
    await put("configuracion/empresa", { toleranciaRetardoMin: 10, limiteFaltaMin: 30, retardosPorFalta: 3 });
    await put("auditoria/e1", { actorUid: "adm1", accion: "sitio.alta", objetivo: "siteA" });
  });
});

const anon = () => env.unauthenticatedContext();
const guardia = (uid = "g-G001") => env.authenticatedContext(uid, { rol: "guardia" });
const sup = (uid = "sup1") => env.authenticatedContext(uid, { rol: "supervisor" });
const adm = () => env.authenticatedContext("adm1", { rol: "admin" });
const sinRol = () => env.authenticatedContext("intruso");
const COLS = ["marcas/t1_entrada", "asistencias/t1", "ajustesAsistencia/a1", "autorizaciones/t1_cierre","usuarios/g-G001", "credenciales/G001", "ajustes/sistema", "sitios/siteA", "turnos/t1", "configuracion/empresa", "auditoria/e1", "otra/cosa"];

// ---------------------------------------------------------------- sin sesión
test("sin sesión: no lee ni escribe NADA", async () => {
  const db = anon().firestore();
  for (const p of COLS) {
    await assertFails(getDoc(doc(db, p)));
    await assertFails(setDoc(doc(db, p), { a: 1 }));
    await assertFails(updateDoc(doc(db, p), { a: 1 }));
    await assertFails(deleteDoc(doc(db, p)));
  }
  for (const c of ["usuarios", "sitios", "turnos", "auditoria"]) await assertFails(getDocs(collection(db, c)));
});

test("sin sesión: nada en Storage", async () => {
  const st = anon().storage();
  await assertFails(getBytes(ref(st, "fotos/a.jpg")));
  await assertFails(uploadBytes(ref(st, "fotos/a.jpg"), new Uint8Array([1])));
});

// ---------------------------------------------------------------- guardia
test("guardia: lee su perfil, su sitio asignado y sus turnos", async () => {
  const db = guardia().firestore();
  await assertSucceeds(getDoc(doc(db, "usuarios/g-G001")));
  await assertSucceeds(getDoc(doc(db, "sitios/siteA")));
  await assertSucceeds(getDoc(doc(db, "turnos/t1")));
  await assertSucceeds(getDocs(query(collection(db, "turnos"), where("guardiaUid", "==", "g-G001"), orderBy("inicioMs"))));
});

test("guardia: NO ve sitios, turnos ni consignas que no sean suyos", async () => {
  const db = guardia().firestore();
  await assertFails(getDoc(doc(db, "sitios/siteB")));
  await assertFails(getDoc(doc(db, "turnos/t2")));
  await assertFails(getDoc(doc(db, "turnos/t3"))); // vacante de un sitio suyo, pero no asignada a él
  await assertFails(getDocs(collection(db, "sitios")));
  await assertFails(getDocs(collection(db, "turnos")));
  await assertFails(getDocs(query(collection(db, "turnos"), where("guardiaUid", "==", "g-G002"))));
});

test("guardia: NO ve perfiles ajenos, credenciales, configuración ni auditoría", async () => {
  const db = guardia().firestore();
  await assertFails(getDoc(doc(db, "usuarios/g-G002")));
  await assertFails(getDoc(doc(db, "usuarios/sup1")));
  await assertFails(getDoc(doc(db, "usuarios/adm1")));
  await assertFails(getDocs(collection(db, "usuarios")));
  await assertFails(getDoc(doc(db, "credenciales/G001")));
  await assertFails(getDoc(doc(db, "ajustes/sistema")));
  await assertFails(getDoc(doc(db, "configuracion/empresa")));
  await assertFails(getDoc(doc(db, "auditoria/e1")));
});

test("guardia: NO puede escribir nada (rol, perfil, turnos, sitios, config, auditoría)", async () => {
  const db = guardia().firestore();
  await assertFails(updateDoc(doc(db, "usuarios/g-G001"), { rol: "admin" }));
  await assertFails(updateDoc(doc(db, "usuarios/g-G001"), { sitiosAsignados: ["siteA", "siteB"] }));
  await assertFails(setDoc(doc(db, "usuarios/g-G999"), { nombre: "X", rol: "guardia", activo: true }));
  await assertFails(deleteDoc(doc(db, "usuarios/g-G001")));
  await assertFails(updateDoc(doc(db, "turnos/t1"), { guardiaUid: "g-G002" }));
  await assertFails(setDoc(doc(db, "turnos/nuevo"), { guardiaUid: "g-G001", sitioId: "siteB" }));
  await assertFails(updateDoc(doc(db, "sitios/siteA"), { radioM: 5000 }));
  await assertFails(setDoc(doc(db, "configuracion/empresa"), { retardosPorFalta: 99 }));
  await assertFails(setDoc(doc(db, "auditoria/falso"), { accion: "x" }));
  await assertFails(deleteDoc(doc(db, "auditoria/e1")));
});

test("guardia dado de baja pierde el acceso AL INSTANTE (aunque su token siga vigente)", async () => {
  const ctx = guardia("g-G003"); // el token dice rol=guardia, pero el perfil está activo=false
  const db = ctx.firestore();
  await assertFails(getDoc(doc(db, "usuarios/g-G003")));
  await assertFails(getDoc(doc(db, "sitios/siteA")));
  // y un guardia activo que se da de baja a mitad de sesión:
  const g1 = guardia().firestore();
  await assertSucceeds(getDoc(doc(g1, "sitios/siteA")));
  await env.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), "usuarios/g-G001"), { activo: false }));
  await assertFails(getDoc(doc(g1, "sitios/siteA")));
  await assertFails(getDoc(doc(g1, "turnos/t1")));
  await assertFails(getDoc(doc(g1, "usuarios/g-G001")));
});

test("guardia: sin campo sitiosAsignados no ve ningún sitio", async () => {
  await assertFails(getDoc(doc(guardia("g-G004").firestore(), "sitios/siteA")));
});

test("guardia: al quitarle el sitio de sus asignaciones deja de verlo", async () => {
  await env.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), "usuarios/g-G001"), { sitiosAsignados: [] }));
  await assertFails(getDoc(doc(guardia().firestore(), "sitios/siteA")));
});

// ---------------------------------------------------------------- supervisor
test("supervisor: ve SUS sitios y SUS turnos; no los de otros", async () => {
  const db = sup().firestore();
  await assertSucceeds(getDoc(doc(db, "sitios/siteA")));
  await assertSucceeds(getDoc(doc(db, "turnos/t1")));
  await assertSucceeds(getDoc(doc(db, "turnos/t3")));
  await assertSucceeds(getDocs(query(collection(db, "sitios"), where("supervisorUid", "==", "sup1"))));
  await assertSucceeds(getDocs(query(collection(db, "turnos"), where("supervisorUid", "==", "sup1"), orderBy("inicioMs"))));
  await assertFails(getDoc(doc(db, "sitios/siteB")));
  await assertFails(getDoc(doc(db, "turnos/t2")));
  await assertFails(getDocs(collection(db, "turnos")));
  await assertFails(getDocs(collection(db, "sitios")));
  await assertFails(getDocs(query(collection(db, "turnos"), where("supervisorUid", "==", "sup2"))));
});

test("supervisor: ve guardias (nombres) pero no a otros supervisores ni al admin; nada sensible", async () => {
  const db = sup().firestore();
  await assertSucceeds(getDoc(doc(db, "usuarios/sup1")));
  await assertSucceeds(getDoc(doc(db, "usuarios/g-G001")));
  await assertSucceeds(getDocs(query(collection(db, "usuarios"), where("rol", "==", "guardia"))));
  await assertFails(getDoc(doc(db, "usuarios/sup2")));
  await assertFails(getDoc(doc(db, "usuarios/adm1")));
  await assertFails(getDocs(collection(db, "usuarios")));
  await assertFails(getDoc(doc(db, "credenciales/G001")));
  await assertFails(getDoc(doc(db, "configuracion/empresa")));
  await assertFails(getDoc(doc(db, "auditoria/e1")));
});

test("supervisor: NO puede escribir (ni crear personal o sitios, ni editar turnos)", async () => {
  const db = sup().firestore();
  await assertFails(setDoc(doc(db, "usuarios/g-NUEVO"), { nombre: "X", rol: "guardia", activo: true }));
  await assertFails(updateDoc(doc(db, "usuarios/sup1"), { rol: "admin" }));
  await assertFails(setDoc(doc(db, "sitios/nuevo"), { nombre: "X" }));
  await assertFails(updateDoc(doc(db, "sitios/siteA"), { supervisorUid: "sup2" }));
  await assertFails(updateDoc(doc(db, "turnos/t1"), { guardiaUid: "g-G002" }));
  await assertFails(setDoc(doc(db, "turnos/nuevo"), { sitioId: "siteA", supervisorUid: "sup1" }));
  await assertFails(deleteDoc(doc(db, "turnos/t3")));
});

test("supervisor dado de baja pierde el acceso al instante", async () => {
  const db = sup().firestore();
  await assertSucceeds(getDoc(doc(db, "turnos/t1")));
  await env.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), "usuarios/sup1"), { activo: false }));
  await assertFails(getDoc(doc(db, "turnos/t1")));
  await assertFails(getDoc(doc(db, "sitios/siteA")));
});

// ---------------------------------------------------------------- admin
test("admin: lee todo lo operativo, pero jamás credenciales ni ajustes", async () => {
  const db = adm().firestore();
  for (const p of ["usuarios/g-G001", "usuarios/sup1", "sitios/siteB", "turnos/t2", "configuracion/empresa", "auditoria/e1"])
    await assertSucceeds(getDoc(doc(db, p)));
  await assertSucceeds(getDocs(collection(db, "usuarios")));
  await assertSucceeds(getDocs(collection(db, "sitios")));
  await assertSucceeds(getDocs(collection(db, "turnos")));
  await assertSucceeds(getDocs(query(collection(db, "auditoria"))));
  await assertFails(getDoc(doc(db, "credenciales/G001")));
  await assertFails(getDoc(doc(db, "ajustes/sistema")));
  await assertFails(getDocs(collection(db, "credenciales")));
});

test("admin: tampoco escribe desde el cliente (todo pasa por el Worker); auditoría inmutable", async () => {
  const db = adm().firestore();
  await assertFails(setDoc(doc(db, "sitios/x"), { nombre: "X" }));
  await assertFails(updateDoc(doc(db, "turnos/t1"), { guardiaUid: null }));
  await assertFails(updateDoc(doc(db, "usuarios/g-G001"), { activo: false }));
  await assertFails(setDoc(doc(db, "configuracion/empresa"), { retardosPorFalta: 1 }));
  await assertFails(setDoc(doc(db, "auditoria/nuevo"), { accion: "x" }));
  await assertFails(updateDoc(doc(db, "auditoria/e1"), { accion: "borrado" }));
  await assertFails(deleteDoc(doc(db, "auditoria/e1")));
});

// ---------------------------------------------------------------- otros
test("cuenta SIN claim de rol o con rol inventado: sin acceso a nada", async () => {
  for (const ctx of [sinRol(), env.authenticatedContext("u1", { rol: "superadmin" })]) {
    const db = ctx.firestore();
    for (const p of COLS) await assertFails(getDoc(doc(db, p)));
    await assertFails(setDoc(doc(db, "usuarios/intruso"), { rol: "admin" }));
    await assertFails(getBytes(ref(ctx.storage(), "x")));
  }
});

test("token con rol admin pero perfil de guardia (claim falsificado/desfasado): sin acceso", async () => {
  const db = env.authenticatedContext("g-G001", { rol: "admin" }).firestore();
  await assertFails(getDocs(collection(db, "usuarios")));
  await assertFails(getDoc(doc(db, "auditoria/e1")));
});

test("Storage: nadie, ni con sesión ni admin", async () => {
  for (const ctx of [guardia(), sup(), adm()]) {
    await assertFails(getBytes(ref(ctx.storage(), "fotos/a.jpg")));
    await assertFails(uploadBytes(ref(ctx.storage(), "fotos/a.jpg"), new Uint8Array([1])));
  }
});

// ---------------------------------------------------------------- Fase 3: asistencia
test("guardia: lee SU marca y SU asistencia; no las de otro guardia", async () => {
  const db = guardia().firestore();
  await assertSucceeds(getDoc(doc(db, "marcas/t1_entrada")));
  await assertSucceeds(getDoc(doc(db, "asistencias/t1")));
  await assertSucceeds(getDocs(query(collection(db, "asistencias"), where("guardiaUid", "==", "g-G001"), orderBy("inicioMs"))));
  await assertFails(getDoc(doc(db, "marcas/t2_entrada")));
  await assertFails(getDoc(doc(db, "asistencias/t2")));
  await assertFails(getDocs(query(collection(db, "asistencias"), where("guardiaUid", "==", "g-G002"))));
  await assertFails(getDocs(collection(db, "marcas")));
  await assertFails(getDocs(collection(db, "asistencias")));
});

test("guardia: no ve ajustes ni autorizaciones y no escribe marcas ni asistencias", async () => {
  const db = guardia().firestore();
  await assertFails(getDoc(doc(db, "ajustesAsistencia/a1")));
  await assertFails(getDoc(doc(db, "autorizaciones/t1_cierre")));
  await assertFails(setDoc(doc(db, "marcas/t1_salida"), { turnoId: "t1", guardiaUid: "g-G001", tipo: "salida", tsMs: 1 }));
  await assertFails(setDoc(doc(db, "marcas/falsa_entrada"), { guardiaUid: "g-G001", tsMs: 1 }));
  await assertFails(updateDoc(doc(db, "marcas/t1_entrada"), { tsMs: 0 }));
  await assertFails(deleteDoc(doc(db, "marcas/t1_entrada")));
  await assertFails(updateDoc(doc(db, "asistencias/t1"), { extraEstado: "autorizado", estado: "cumplido" }));
  await assertFails(setDoc(doc(db, "asistencias/nueva"), { guardiaUid: "g-G001", estado: "cumplido" }));
  await assertFails(setDoc(doc(db, "ajustesAsistencia/mio"), { turnoId: "t1", tipo: "entrada", motivo: "x" }));
});

test("supervisor: ve asistencias, ajustes y autorizaciones de SUS sitios; no las de otros; no escribe; no lee marcas", async () => {
  const db = sup().firestore();
  await assertSucceeds(getDoc(doc(db, "asistencias/t1")));
  await assertSucceeds(getDocs(query(collection(db, "asistencias"), where("supervisorUid", "==", "sup1"), orderBy("inicioMs"))));
  await assertSucceeds(getDocs(query(collection(db, "asistencias"), where("supervisorUid", "==", "sup1"), where("extraEstado", "==", "pendiente"))));
  await assertSucceeds(getDoc(doc(db, "ajustesAsistencia/a1")));
  await assertSucceeds(getDoc(doc(db, "autorizaciones/t1_cierre")));
  await assertFails(getDoc(doc(db, "asistencias/t2")));
  await assertFails(getDocs(query(collection(db, "asistencias"), where("supervisorUid", "==", "sup2"))));
  await assertFails(getDocs(collection(db, "asistencias")));
  await assertFails(getDoc(doc(db, "marcas/t1_entrada"))); // GPS y ruta de la foto: solo admin y el propio guardia
  await assertFails(updateDoc(doc(db, "asistencias/t1"), { extraEstado: "autorizado" }));
  await assertFails(setDoc(doc(db, "autorizaciones/falsa"), { tipo: "extra", decision: "autorizado" }));
  await assertFails(setDoc(doc(db, "ajustesAsistencia/falso"), { tipo: "entrada" }));
  const otro = sup("sup2").firestore();
  await assertFails(getDoc(doc(otro, "asistencias/t1")));
  await assertFails(getDoc(doc(otro, "ajustesAsistencia/a1")));
  await assertFails(getDoc(doc(otro, "autorizaciones/t1_cierre")));
});

test("admin: lee todo lo de asistencia; nadie escribe desde el cliente (marcas, ajustes y autorizaciones inmutables)", async () => {
  const db = adm().firestore();
  for (const p of ["marcas/t1_entrada", "marcas/t2_entrada", "asistencias/t1", "asistencias/t2", "ajustesAsistencia/a1", "autorizaciones/t1_cierre"]) await assertSucceeds(getDoc(doc(db, p)));
  await assertSucceeds(getDocs(collection(db, "asistencias")));
  await assertFails(setDoc(doc(db, "marcas/x_entrada"), { tsMs: 1 }));
  await assertFails(updateDoc(doc(db, "marcas/t1_entrada"), { tsMs: 1 }));
  await assertFails(deleteDoc(doc(db, "marcas/t1_entrada")));
  await assertFails(updateDoc(doc(db, "asistencias/t1"), { estado: "cumplido" }));
  await assertFails(setDoc(doc(db, "ajustesAsistencia/x"), { tipo: "entrada" }));
  await assertFails(updateDoc(doc(db, "ajustesAsistencia/a1"), { motivo: "otro" }));
  await assertFails(deleteDoc(doc(db, "autorizaciones/t1_cierre")));
});

test("guardia dado de baja pierde también marcas y asistencias al instante", async () => {
  const db = guardia().firestore();
  await assertSucceeds(getDoc(doc(db, "asistencias/t1")));
  await env.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), "usuarios/g-G001"), { activo: false }));
  await assertFails(getDoc(doc(db, "asistencias/t1")));
  await assertFails(getDoc(doc(db, "marcas/t1_entrada")));
});
