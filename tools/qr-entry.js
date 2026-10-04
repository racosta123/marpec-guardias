// Envoltura mínima de qrcode-generator (MIT, sin dependencias): devuelve la matriz de módulos del QR.
import qrcode from "qrcode-generator";

export function qrMatriz(texto) {
  const q = qrcode(0, "M"); // versión automática, corrección de errores M
  q.addData(texto, "Byte");
  q.make();
  const n = q.getModuleCount();
  const oscuro = [];
  for (let r = 0; r < n; r++) {
    const fila = [];
    for (let c = 0; c < n; c++) fila.push(q.isDark(r, c));
    oscuro.push(fila);
  }
  return { n, oscuro };
}
