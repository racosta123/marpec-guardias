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
    await put("config/licencia", { modo: "produccion" }); // sin licencia las reglas no dejan leer nada (ver rules-licencia.test.js)
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
    await put("puntos/pA1", { sitioId: "siteA", supervisorUid: "sup1", nombre: "Portón", orden: 1, qrVersion: 1, lat: 29.07, lng: -110.95, radioM: 30, activo: true });
    await put("puntos/pB1", { sitioId: "siteB", supervisorUid: "sup2", nombre: "Caseta", orden: 1, qrVersion: 1, radioM: 30, activo: true });
    await put("programasRondin/siteA", { sitioId: "siteA", supervisorUid: "sup1", modo: "libre", activo: true });
    await put("programasRondin/siteB", { sitioId: "siteB", supervisorUid: "sup2", modo: "libre", activo: true });
    await put("rondines/t1_0", { rondinId: "t1_0", turnoId: "t1", sitioId: "siteA", supervisorUid: "sup1", guardiaUid: "g-G001", programadoMs: T, estado: "no_iniciado" });
    await put("rondines/t2_0", { rondinId: "t2_0", turnoId: "t2", sitioId: "siteB", supervisorUid: "sup2", guardiaUid: "g-G002", programadoMs: T, estado: "completo" });
    await put("escaneos/t1_0_pA1", { rondinId: "t1_0", sitioId: "siteA", guardiaUid: "g-G001", puntoId: "pA1", tsMs: T, lat: 29.07, lng: -110.95, fotoKey: "rondines/siteA/t1/0/pA1-x.jpg" });
    await put("ajustesRondin/aj1", { rondinId: "t1_0", supervisorUid: "sup1", guardiaUid: "g-G001", tipo: "justificar_rondin", motivo: "x" });
    await put("incidencias/i1", { sitioId: "siteA", guardiaUid: "g-G001", tipoId: "robo", gravedad: "alta", descripcion: "x", fotoKeys: ["incidencias/siteA/i1/0-x.jpg"] });
    await put("incidencias/i2", { sitioId: "siteB", guardiaUid: "g-G002", tipoId: "robo", gravedad: "baja", descripcion: "y", fotoKeys: [] });
    await put("incidenciasResumen/i1", { incidenciaId: "i1", sitioId: "siteA", supervisorUid: "sup1", guardiaUid: "g-G001", gravedad: "alta", estado: "abierta", creadoMs: T });
    await put("incidenciasResumen/i2", { incidenciaId: "i2", sitioId: "siteB", supervisorUid: "sup2", guardiaUid: "g-G002", gravedad: "baja", estado: "abierta", creadoMs: T });
    await put("seguimientosIncidencia/s1", { incidenciaId: "i1", tipo: "comentario", texto: "x", autorNombre: "Sara", tsMs: T });
    await put("visitantes/v1", { sitioId: "siteA", nombre: "Luis", visitaA: "Casa 1", motivo: "visita", fotoKey: "visitantes/siteA/v1.jpg", entradaMs: T });
    await put("salidasVisitante/v1", { visitanteId: "v1", sitioId: "siteA", salidaMs: T + 1 });
    await put("visitantesVista/v1", { visitanteId: "v1", sitioId: "siteA", supervisorUid: "sup1", nombre: "Luis", dentro: true, entradaMs: T });
    await put("visitantesVista/v2", { visitanteId: "v2", sitioId: "siteB", supervisorUid: "sup2", nombre: "Marta", dentro: true, entradaMs: T });
    await put("novedades/n1", { turnoId: "t1", sitioId: "siteA", guardiaUid: "g-G001", texto: "x", tsMs: T });
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

// ---------------------------------------------------------------- Fase 4: rondines
test("guardia: lee SUS rondines; NO los de otro sitio, ni puntos, programas, escaneos ni ajustes", async () => {
  const db = guardia().firestore();
  await assertSucceeds(getDoc(doc(db, "rondines/t1_0")));
  await assertSucceeds(getDocs(query(collection(db, "rondines"), where("guardiaUid", "==", "g-G001"), orderBy("programadoMs"))));
  await assertFails(getDoc(doc(db, "rondines/t2_0")));
  await assertFails(getDocs(query(collection(db, "rondines"), where("guardiaUid", "==", "g-G002"))));
  await assertFails(getDocs(collection(db, "rondines")));
  for (const p of ["puntos/pA1", "puntos/pB1", "programasRondin/siteA", "escaneos/t1_0_pA1", "ajustesRondin/aj1"]) await assertFails(getDoc(doc(db, p)));
  for (const c of ["puntos", "escaneos", "programasRondin", "ajustesRondin"]) await assertFails(getDocs(collection(db, c)));
});

test("guardia: no escribe puntos, programas, rondines, escaneos ni ajustes", async () => {
  const db = guardia().firestore();
  await assertFails(setDoc(doc(db, "escaneos/t1_0_pA1"), { tsMs: 1 }));
  await assertFails(setDoc(doc(db, "escaneos/falso"), { guardiaUid: "g-G001", puntoId: "pA1" }));
  await assertFails(updateDoc(doc(db, "rondines/t1_0"), { estado: "completo" }));
  await assertFails(setDoc(doc(db, "rondines/nuevo"), { guardiaUid: "g-G001", estado: "completo" }));
  await assertFails(setDoc(doc(db, "puntos/mio"), { sitioId: "siteA", nombre: "Falso" }));
  await assertFails(updateDoc(doc(db, "puntos/pA1"), { activo: false }));
  await assertFails(updateDoc(doc(db, "programasRondin/siteA"), { modo: "ordenada" }));
  await assertFails(deleteDoc(doc(db, "rondines/t1_0")));
});

test("supervisor: ve puntos, programa, rondines y ajustes de SUS sitios; no los de otros ni escaneos; no escribe", async () => {
  const db = sup().firestore();
  await assertSucceeds(getDoc(doc(db, "puntos/pA1")));
  await assertSucceeds(getDoc(doc(db, "programasRondin/siteA")));
  await assertSucceeds(getDoc(doc(db, "rondines/t1_0")));
  await assertSucceeds(getDoc(doc(db, "ajustesRondin/aj1")));
  await assertSucceeds(getDocs(query(collection(db, "puntos"), where("supervisorUid", "==", "sup1"))));
  await assertSucceeds(getDocs(query(collection(db, "rondines"), where("supervisorUid", "==", "sup1"), orderBy("programadoMs"))));
  await assertSucceeds(getDocs(query(collection(db, "rondines"), where("supervisorUid", "==", "sup1"), where("estado", "==", "no_iniciado"))));
  for (const p of ["puntos/pB1", "programasRondin/siteB", "rondines/t2_0"]) await assertFails(getDoc(doc(db, p)));
  await assertFails(getDocs(collection(db, "rondines")));
  await assertFails(getDocs(query(collection(db, "rondines"), where("supervisorUid", "==", "sup2"))));
  await assertFails(getDoc(doc(db, "escaneos/t1_0_pA1"))); // GPS y ruta de la foto: solo admin; fotos vía Worker
  await assertFails(updateDoc(doc(db, "rondines/t1_0"), { estado: "completo" }));
  await assertFails(setDoc(doc(db, "puntos/nuevo"), { sitioId: "siteA", supervisorUid: "sup1" }));
  await assertFails(updateDoc(doc(db, "puntos/pA1"), { nombre: "Hack" }));
  await assertFails(setDoc(doc(db, "ajustesRondin/falso"), { tipo: "marcar_punto" }));
  const otro = sup("sup2").firestore();
  await assertFails(getDoc(doc(otro, "puntos/pA1")));
  await assertFails(getDoc(doc(otro, "rondines/t1_0")));
  await assertFails(getDoc(doc(otro, "ajustesRondin/aj1")));
});

test("admin: lee todo lo de rondines; nada se escribe desde el cliente (escaneos y ajustes inmutables)", async () => {
  const db = adm().firestore();
  for (const p of ["puntos/pA1", "puntos/pB1", "programasRondin/siteA", "rondines/t1_0", "rondines/t2_0", "escaneos/t1_0_pA1", "ajustesRondin/aj1"]) await assertSucceeds(getDoc(doc(db, p)));
  await assertSucceeds(getDocs(collection(db, "rondines")));
  await assertFails(setDoc(doc(db, "escaneos/x"), { tsMs: 1 }));
  await assertFails(updateDoc(doc(db, "escaneos/t1_0_pA1"), { tsMs: 1 }));
  await assertFails(deleteDoc(doc(db, "escaneos/t1_0_pA1")));
  await assertFails(updateDoc(doc(db, "ajustesRondin/aj1"), { motivo: "otro" }));
  await assertFails(setDoc(doc(db, "puntos/nuevo"), { nombre: "x" }));
  await assertFails(updateDoc(doc(db, "rondines/t1_0"), { estado: "completo" }));
});

test("dado de baja pierde también los rondines al instante; sin sesión no lee nada de rondines", async () => {
  const a = guardia().firestore();
  await assertSucceeds(getDoc(doc(a, "rondines/t1_0")));
  await env.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), "usuarios/g-G001"), { activo: false }));
  await assertFails(getDoc(doc(a, "rondines/t1_0")));
  const n = anon().firestore();
  for (const p of ["puntos/pA1", "programasRondin/siteA", "rondines/t1_0", "escaneos/t1_0_pA1", "ajustesRondin/aj1"]) await assertFails(getDoc(doc(n, p)));
});

// ---------------------------------------------------------------- Fase 5: incidencias, visitantes, bitácora
test("guardia: lee solo el RESUMEN de SUS incidencias; nada de visitantes, novedades, seguimientos ni originales", async () => {
  const db = guardia().firestore();
  await assertSucceeds(getDoc(doc(db, "incidenciasResumen/i1")));
  await assertSucceeds(getDocs(query(collection(db, "incidenciasResumen"), where("guardiaUid", "==", "g-G001"), orderBy("creadoMs"))));
  await assertFails(getDoc(doc(db, "incidenciasResumen/i2")));
  await assertFails(getDocs(query(collection(db, "incidenciasResumen"), where("guardiaUid", "==", "g-G002"))));
  await assertFails(getDocs(collection(db, "incidenciasResumen")));
  for (const p of ["incidencias/i1", "seguimientosIncidencia/s1", "visitantes/v1", "salidasVisitante/v1", "visitantesVista/v1", "novedades/n1"]) await assertFails(getDoc(doc(db, p)));
  for (const c of ["incidencias", "visitantes", "visitantesVista", "novedades", "seguimientosIncidencia"]) await assertFails(getDocs(collection(db, c)));
});

test("guardia: no escribe incidencias, visitantes, novedades ni seguimientos (todo pasa por el Worker)", async () => {
  const db = guardia().firestore();
  for (const [p, d] of [["incidencias/nueva", { sitioId: "siteA", guardiaUid: "g-G001" }], ["visitantes/nuevo", { nombre: "X", sitioId: "siteA" }], ["novedades/nueva", { texto: "x", guardiaUid: "g-G001" }],
    ["seguimientosIncidencia/nuevo", { incidenciaId: "i1" }], ["visitantesVista/v1", { dentro: false }], ["incidenciasResumen/i1", { estado: "cerrada" }], ["salidasVisitante/x", { visitanteId: "v1" }]])
    await assertFails(setDoc(doc(db, p), d));
  await assertFails(updateDoc(doc(db, "incidencias/i1"), { gravedad: "baja" }));
  await assertFails(deleteDoc(doc(db, "novedades/n1")));
});

test("supervisor: resumen de incidencias y visitantes de SUS sitios; no los de otros; no los originales; no escribe", async () => {
  const db = sup().firestore();
  await assertSucceeds(getDoc(doc(db, "incidenciasResumen/i1")));
  await assertSucceeds(getDoc(doc(db, "visitantesVista/v1")));
  await assertSucceeds(getDocs(query(collection(db, "incidenciasResumen"), where("supervisorUid", "==", "sup1"), orderBy("creadoMs"))));
  await assertSucceeds(getDocs(query(collection(db, "incidenciasResumen"), where("supervisorUid", "==", "sup1"), where("gravedad", "==", "alta"))));
  await assertSucceeds(getDocs(query(collection(db, "visitantesVista"), where("supervisorUid", "==", "sup1"), where("dentro", "==", true))));
  await assertSucceeds(getDocs(query(collection(db, "visitantesVista"), where("supervisorUid", "==", "sup1"), orderBy("entradaMs"))));
  for (const p of ["incidenciasResumen/i2", "visitantesVista/v2"]) await assertFails(getDoc(doc(db, p)));
  await assertFails(getDocs(collection(db, "incidenciasResumen")));
  await assertFails(getDocs(collection(db, "visitantesVista")));
  await assertFails(getDocs(query(collection(db, "visitantesVista"), where("supervisorUid", "==", "sup2"))));
  for (const p of ["incidencias/i1", "seguimientosIncidencia/s1", "visitantes/v1", "salidasVisitante/v1", "novedades/n1"]) await assertFails(getDoc(doc(db, p))); // originales y fotos: solo admin / Worker
  await assertFails(updateDoc(doc(db, "incidenciasResumen/i1"), { estado: "cerrada" }));
  await assertFails(setDoc(doc(db, "seguimientosIncidencia/nuevo"), { incidenciaId: "i1", texto: "x" }));
  const otro = sup("sup2").firestore();
  await assertFails(getDoc(doc(otro, "incidenciasResumen/i1")));
  await assertFails(getDoc(doc(otro, "visitantesVista/v1")));
});

test("admin: lee todo lo de la Fase 5 (incluido el catálogo); nada se escribe desde el cliente; inmutables", async () => {
  const db = adm().firestore();
  for (const p of ["incidencias/i1", "incidencias/i2", "incidenciasResumen/i1", "seguimientosIncidencia/s1", "visitantes/v1", "salidasVisitante/v1", "visitantesVista/v1", "novedades/n1", "configuracion/empresa"]) await assertSucceeds(getDoc(doc(db, p)));
  await assertSucceeds(getDocs(collection(db, "incidenciasResumen")));
  await assertFails(setDoc(doc(db, "incidencias/x"), { sitioId: "siteA" }));
  await assertFails(updateDoc(doc(db, "incidencias/i1"), { descripcion: "editada" }));
  await assertFails(deleteDoc(doc(db, "incidencias/i1")));
  await assertFails(updateDoc(doc(db, "seguimientosIncidencia/s1"), { texto: "editado" }));
  await assertFails(deleteDoc(doc(db, "visitantes/v1")));
  await assertFails(updateDoc(doc(db, "novedades/n1"), { texto: "editada" }));
  await assertFails(setDoc(doc(db, "configuracion/catalogos"), { tiposIncidencia: [] }));
});

test("sin sesión y dado de baja: nada de la Fase 5", async () => {
  const n = anon().firestore();
  for (const p of ["incidencias/i1", "incidenciasResumen/i1", "seguimientosIncidencia/s1", "visitantes/v1", "visitantesVista/v1", "salidasVisitante/v1", "novedades/n1", "configuracion/catalogos"]) await assertFails(getDoc(doc(n, p)));
  const a = guardia().firestore();
  await assertSucceeds(getDoc(doc(a, "incidenciasResumen/i1")));
  await env.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), "usuarios/g-G001"), { activo: false }));
  await assertFails(getDoc(doc(a, "incidenciasResumen/i1")));
});

test("guardia dado de baja pierde también marcas y asistencias al instante", async () => {
  const db = guardia().firestore();
  await assertSucceeds(getDoc(doc(db, "asistencias/t1")));
  await env.withSecurityRulesDisabled(async (c) => updateDoc(doc(c.firestore(), "usuarios/g-G001"), { activo: false }));
  await assertFails(getDoc(doc(db, "asistencias/t1")));
  await assertFails(getDoc(doc(db, "marcas/t1_entrada")));
});
