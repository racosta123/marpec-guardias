# Sistema de diseño de MARPEC Guardias

Solo cambia la apariencia y la experiencia: ninguna función, endpoint, colección, regla ni validación de seguridad.

## Recursos (cero dependencias en tiempo de ejecución)
- **Fuente Inter** (SIL OFL) en `fonts/` (400, 500, 600, 700, subconjunto latino). Sin Google Fonts.
- **Íconos Lucide** (ISC) como SVG locales, solo los usados: `js/iconos.js` (generado). Para agregar uno: añadirlo a `tools/build-diseno.mjs` y ejecutar `node tools/build-diseno.mjs`.
- Sin librerías de UI, sin blur, sombras moderadas, sin animaciones pesadas (el único movimiento es el pulso del pánico, que se apaga con «reducir movimiento»).

## Paleta (el color solo tiene significado operativo)
| Uso | Fondo/ícono | Relleno con texto blanco (AA) |
|---|---|---|
| Navegación, encabezados | `#082D5B` | — |
| Acción | `#1E6EFF` | `#1D6AF5` |
| En turno, cubierto, correcto | `#16A34A` | `#15803D` |
| Pánico, descubierto, crítico | `#EF4444` | `#DC2626` (pánico `#B91C1C`) |
| Alertas, advertencias | `#F59E0B` | texto marino `#051E3E` (el blanco no pasa AA) |
| Categoría Visitantes / Bitácora | — | `#7C3AED` / `#0E7490` |
| Fondos y bordes | `#F8FAFC`, `#FFFFFF`, `#E2E8F0` | — |

Los tonos «originales» solo se usan en íconos y barras (3:1); todo texto cumple WCAG AA. Verificación: `node tools/contraste.mjs` (pares del sistema) y `node tools/contraste-pantallas.mjs <url>` (cada texto de 30 pantallas reales).

## Pantallas
- **Guardia** (celular): fondo marino; perfil con estado; tarjeta de turno (avance y tiempo restante calculados con el horario); acción principal verde; accesos de color; botón de pánico como barra roja fija («Mantén 3 s · Pánico»). Todo botón mide ≥ 48 px.
- **Supervisor / admin**: menú lateral marino con íconos (escritorio) o menú desplegable (celular); encabezado con lema, campana (número de pánicos activos) y usuario.
- **Operación en vivo**: 4 indicadores, franja de pánico con ATENDER (usa el mismo formulario de atención), puestos con ícono y etiqueta de estado, últimos eventos.
- No se muestran datos que la app no tiene: sin fotos de sitios, sin distancia en vivo al puesto (el aviso de privacidad dice que la ubicación solo se usa al marcar).

## Capturas
`node tools/serve.mjs 5182 --fake` y `node tools/capturas-rediseno.mjs http://localhost:5182 [escena ...]` → `.tools/capturas-rediseno/` (celular 360 px a 2x, escritorio 1440 px, tableta 768 px). Avisa si una pantalla se desborda horizontalmente.
