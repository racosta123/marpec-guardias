// El QR que imprime la app (qrcode-generator) debe poder leerse con el lector de respaldo (jsQR).
import { test } from "node:test";
import assert from "node:assert/strict";
import { qrMatriz } from "../tools/qr-entry.js";
import { jsQR } from "../tools/jsqr-entry.js";

function aPixeles({ n, oscuro }, escala = 6, silencio = 4) {
  const lado = (n + 2 * silencio) * escala;
  const px = new Uint8ClampedArray(lado * lado * 4).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!oscuro[r][c]) continue;
    for (let y = 0; y < escala; y++) for (let x = 0; x < escala; x++) {
      const i = (((r + silencio) * escala + y) * lado + (c + silencio) * escala + x) * 4;
      px[i] = px[i + 1] = px[i + 2] = 0;
    }
  }
  return { px, lado };
}

test("QR del puesto: ida y vuelta generador → lector de respaldo (jsQR)", () => {
  for (const texto of ["MPC1.8515c4fa78933fd4.1.AAAAAAAAAAAAAAAAAAAAAA", "MPC1.0a1b2c3d4e5f6a7b.12.q-_3Zk9XyWvUtSrQpOnMl1"]) {
    const { px, lado } = aPixeles(qrMatriz(texto));
    const r = jsQR(px, lado, lado);
    assert.ok(r, "se detectó el QR");
    assert.equal(r.data, texto);
  }
});

test("jsQR no inventa códigos: imagen en blanco y ruido no devuelven nada", () => {
  const lado = 200;
  assert.equal(jsQR(new Uint8ClampedArray(lado * lado * 4).fill(255), lado, lado), null);
  const ruido = new Uint8ClampedArray(lado * lado * 4);
  for (let i = 0; i < ruido.length; i += 4) { const v = (i * 2654435761 >>> 0) % 2 ? 255 : 0; ruido[i] = ruido[i + 1] = ruido[i + 2] = v; ruido[i + 3] = 255; }
  assert.equal(jsQR(ruido, lado, lado), null);
});
