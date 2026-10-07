// Lectura LOCAL de enlaces de Google Maps y coordenadas pegadas (js/ubicacion.js). Puro: sin red ni navegador.
// Uso: node --test tests/enlace-ubicacion.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mensajePrecision, parsearUbicacion } from "../js/ubicacion.js";

const OK = { lat: 29.0729, lng: -110.9559 };
const casos = [
  ["pareja con coma", "29.0729, -110.9559", OK],
  ["pareja con espacio", "29.0729 -110.9559", OK],
  ["entre paréntesis", "(29.0729, -110.9559)", OK],
  ["punto y coma", "29.0729; -110.9559", OK],
  ["decimales con coma (es-MX)", "29,0729 -110,9559", OK],
  ["Google: centro de la vista (@)", "https://www.google.com/maps/@29.0729,-110.9559,17z", OK],
  ["Google: lugar con @ y pin !3d!4d (gana el pin)", "https://www.google.com/maps/place/Plaza/@29.1,-110.9,15z/data=!3m1!4b1!4m6!3m5!1s0x0:0x0!8m2!3d29.0729!4d-110.9559", OK],
  ["Google: ?q=", "https://maps.google.com/?q=29.0729,-110.9559", OK],
  ["Google: ?ll=", "https://maps.google.com/maps?ll=29.0729,-110.9559&z=17", OK],
  ["Google: search api (codificado)", "https://www.google.com/maps/search/?api=1&query=29.0729%2C-110.9559", OK],
  ["geo:", "geo:29.0729,-110.9559", OK],
  ["OpenStreetMap #map", "https://www.openstreetmap.org/#map=17/29.0729/-110.9559", OK],
  ["OpenStreetMap mlat/mlon", "https://www.openstreetmap.org/?mlat=29.0729&mlon=-110.9559", OK],
  ["grados-minutos-segundos", "29°04'22.4\"N 110°57'21.2\"W", { lat: 29.072889, lng: -110.955889 }],
  ["hemisferio sur y este", "-33.8688;151.2093", { lat: -33.8688, lng: 151.2093 }],
  ["espacios alrededor", "   29.0729,-110.9559  ", OK],
];
for (const [nombre, entrada, esperado] of casos) {
  test(`enlace: ${nombre}`, () => assert.deepEqual(parsearUbicacion(entrada), esperado));
}

test("rechaza vacío, texto sin coordenadas y rangos imposibles", () => {
  assert.match(parsearUbicacion("").error, /Pega/);
  assert.match(parsearUbicacion("hola mundo").error, /No encontré/);
  assert.match(parsearUbicacion("95, 10").error, /fuera de rango/);
  assert.match(parsearUbicacion("10, 200").error, /fuera de rango/);
});
test("enlaces cortos de Google: explica que no se leen sin red", () => {
  for (const u of ["https://maps.app.goo.gl/AbCdEf123", "https://goo.gl/maps/xyz", "maps.app.goo.gl/q"]) assert.match(parsearUbicacion(u).error, /cortos/);
});
test("nunca consulta la red", async () => {
  const f = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("no debe haber red"); };
  try { parsearUbicacion("https://www.google.com/maps/@29.07,-110.95,17z"); parsearUbicacion("https://maps.app.goo.gl/x"); } finally { globalThis.fetch = f; }
});
test("aviso de precisión baja: solo si es peor que 100 m", () => {
  assert.equal(mensajePrecision(100), null);
  assert.equal(mensajePrecision(8), null);
  assert.equal(mensajePrecision(50000), "Precisión baja (±50000 m). Usa el celular al aire libre o elige en el mapa");
  assert.equal(mensajePrecision(150.4), "Precisión baja (±150 m). Usa el celular al aire libre o elige en el mapa");
});
