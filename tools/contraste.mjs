// Revisión de contraste WCAG (AA = 4.5:1 texto normal, 3:1 texto grande ≥ 24 px o ≥ 18.66 px en negritas y componentes de interfaz).
// Uso: node tools/contraste.mjs   — revisa los pares de color del sistema de diseño (los mismos de css/app.css).
const lum = (hex) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
export const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };

// [descripción, texto, fondo, mínimo requerido]
export const PARES = [
  ["texto sobre fondo claro", "#0F172A", "#F8FAFC", 4.5],
  ["texto sobre tarjeta blanca", "#0F172A", "#FFFFFF", 4.5],
  ["texto secundario sobre tarjeta", "#475569", "#FFFFFF", 4.5],
  ["texto secundario sobre fondo claro", "#475569", "#F8FAFC", 4.5],
  ["blanco sobre azul marino", "#FFFFFF", "#082D5B", 4.5],
  ["texto de menú (claro) sobre azul marino", "#E2E8F0", "#082D5B", 4.5],
  ["texto atenuado en menú sobre marino", "#B6C4DA", "#082D5B", 4.5],
  ["blanco sobre azul acción (botón)", "#FFFFFF", "#1E6EFF", 4.5],
  ["azul acción como texto/enlace sobre blanco", "#1E6EFF", "#FFFFFF", 4.5],
  ["blanco sobre verde #16A34A (original)", "#FFFFFF", "#16A34A", 4.5],
  ["blanco sobre verde #15803D (relleno)", "#FFFFFF", "#15803D", 4.5],
  ["verde oscuro como texto sobre blanco", "#166534", "#FFFFFF", 4.5],
  ["verde oscuro sobre verde claro (etiqueta)", "#166534", "#DCFCE7", 4.5],
  ["blanco sobre rojo #EF4444 (original)", "#FFFFFF", "#EF4444", 4.5],
  ["blanco sobre rojo #DC2626 (relleno)", "#FFFFFF", "#DC2626", 4.5],
  ["blanco sobre rojo #B91C1C (pánico)", "#FFFFFF", "#B91C1C", 4.5],
  ["rojo oscuro sobre rojo claro (etiqueta)", "#991B1B", "#FEE2E2", 4.5],
  ["blanco sobre ámbar #F59E0B (original)", "#FFFFFF", "#F59E0B", 4.5],
  ["marino oscuro sobre ámbar #F59E0B", "#082D5B", "#F59E0B", 4.5],
  ["ámbar oscuro sobre ámbar claro (etiqueta)", "#78350F", "#FEF3C7", 4.5],
  ["azul oscuro sobre azul claro (etiqueta)", "#1E3A8A", "#DBEAFE", 4.5],
  ["texto sobre franja ámbar de aviso", "#3B2A00", "#FDE68A", 4.5],
  ["blanco sobre morado (categoría Visitantes)", "#FFFFFF", "#7C3AED", 4.5],
  ["blanco sobre turquesa (categoría Bitácora)", "#FFFFFF", "#0E7490", 4.5],
  ["blanco sobre azul acción (relleno)", "#FFFFFF", "#1D6AF5", 4.5],
  ["marino oscuro sobre ámbar en fondo de franja", "#051E3E", "#F59E0B", 4.5],
  ["borde de campo sobre blanco (componente)", "#64748B", "#FFFFFF", 3],
  ["ícono verde sobre blanco (componente)", "#16A34A", "#FFFFFF", 3],
  ["ícono rojo sobre blanco (componente)", "#EF4444", "#FFFFFF", 3],
];

if (process.argv[1] && import.meta.url === `file:///${process.argv[1].replace(/\\/g, "/")}`) {
  let mal = 0;
  for (const [d, t, f, min] of PARES) {
    const r = ratio(t, f);
    const ok = r >= min;
    if (!ok) mal++;
    console.log(`${ok ? "✔" : "✖"} ${r.toFixed(2).padStart(5)}:1 (mín ${min})  ${d}  [${t} sobre ${f}]`);
  }
  console.log(mal ? `\n${mal} par(es) NO cumplen (los marcados como «original» se documentan: se usa el tono ajustado)` : "\nTodos cumplen.");
}
