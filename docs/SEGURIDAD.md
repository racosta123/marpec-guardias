# Modelo de seguridad (Fase 1)

## Roles
`guardia`, `supervisor`, `admin`. Se guardan como **custom claim `rol`** y como `usuarios/{uid}.rol`. Solo el Worker los asigna:
- Guardia: el Worker mete `rol` en el *custom token* que emite tras verificar el PIN.
- Supervisor/admin: el Worker crea la cuenta en Firebase Auth con `customAttributes={"rol":...}`.
- Ningún endpoint permite a un usuario cambiar su propio rol. La API no permite crear admins (solo el endpoint de primer admin, de un solo uso).

## Acceso del guardia (número de empleado + PIN)
- Hash: `PBKDF2-SHA256(HMAC-SHA256(PIN_PEPPER, pin), sal de 16 bytes, 100 000 iteraciones)`. El *pepper* es un secret del Worker, nunca está en Firestore: un volcado de la base no basta para fuerza bruta offline del espacio de 10⁶ PIN.
- Comparación en tiempo constante. Si el número no existe se calcula un hash ficticio (mismo costo) y se cuenta el fallo igual.
- Bloqueo: 5 fallos → 15 min por número de empleado (existente o no); 20 fallos → 15 min por IP. Estado en un Durable Object (atómico). Durante el bloqueo se responde igual que un PIN incorrecto.
- Mensaje único: «Número de empleado o PIN incorrectos, o acceso bloqueado temporalmente.»
- Custom token de 5 minutos; se intercambia de inmediato por un ID token.

## Worker
- CORS: solo `ALLOWED_ORIGIN` (GitHub Pages). Cualquier otro `Origin` recibe 403, incluso con credenciales válidas.
- Cada endpoint protegido valida el ID token (firma RS256 contra las llaves públicas de Google, `iss`, `aud`, `exp`, `iat`, `sub`) **y** que el perfil exista, esté activo y su rol coincida con el del token.
- Encabezados: HSTS, `nosniff`, `no-store`, CSP `default-src 'none'`, `frame-ancestors 'none'`, `no-referrer`, CORP.
- Cuerpos limitados a 4 KB; entradas validadas con listas blancas.
- Secrets (`SERVICE_ACCOUNT_JSON`, `PIN_PEPPER`, `SETUP_TOKEN`) solo como `wrangler secret`.

## Firestore / Storage
- Por defecto `allow read, write: if false`.
- Única excepción: `get` de `usuarios/{uid}` por su propio dueño con claim `rol` válido. `credenciales` y `ajustes` no son legibles por nadie desde el cliente.
- Cero escrituras de cliente. La cuenta de servicio del Worker no se rige por reglas.
- Pruebas: `tests/rules.test.js` (emulador oficial).

## Cliente
- CSP por `<meta>` (GitHub Pages no permite encabezados): scripts, estilos, fuentes e imágenes solo del propio origen; conexiones solo a Firebase y al Worker. Sin estilos ni scripts en línea.
- Firebase Auth se inicializa **sin** `popupRedirectResolver`, para que el SDK no cargue `apis.google.com`.
- El Service Worker no intercepta ni cachea nada que no sea del propio origen (ni Worker ni Firebase).
- Sin dependencias de terceros en ejecución: SDK de Firebase empaquetado en `js/vendor/firebase.js`, fuentes Barlow en `fonts/`.

## Riesgos conocidos / pendientes
1. **Denegación dirigida:** un atacante que conozca un número de empleado puede bloquearlo 15 min (5 fallos). Mitigado por el límite por IP; aceptado a cambio de proteger el PIN corto. Fase futura: alerta al supervisor.
2. **PIN de 4–6 dígitos** es inherentemente débil; la defensa depende del bloqueo, el pepper y el hash lento. No usar PIN reutilizados.
3. ~~Revocación~~ **Cerrado en Fase 2:** al dar de baja, el perfil queda inactivo (las reglas de Firestore lo verifican en cada lectura, así que el ID token vigente deja de servir al instante), la cuenta se inhabilita y los refresh tokens se revocan.
4. **Auto-registro de Firebase Auth:** con Email/Password activo, cualquiera con la apiKey pública puede crear cuentas sin rol. No obtienen acceso a nada (reglas + Worker), pero ensucian el directorio. Desactivar el registro (Identity Platform) cuando se pueda.
5. **CORS por origen, no por ruta:** `https://<usuario>.github.io` es compartido por todos los sitios de esa cuenta de GitHub. Un dominio propio lo resolvería.
6. **Icono PWA:** el logo entregado es 211×225 px. Para una instalación nítida se recomienda una versión ≥512 px (no se modificó el logo).
7. Aviso de privacidad es **borrador** y requiere revisión legal.

## Fase 2 — Sitios, personal y turnos

- **Lecturas por reglas, escrituras por el Worker.** Las reglas exigen cuenta *activa* (perfil existente, `activo=true` y rol igual al claim) en cada lectura. Guardia: solo sus turnos y los sitios de `usuarios/{uid}.sitiosAsignados` (mantenido por el Worker, solo `get`, nunca `list`). Supervisor: sitios/turnos donde `supervisorUid` es él (campo denormalizado en los turnos) y los perfiles de guardias para asignar. Admin: todo lo operativo, **nunca** `credenciales` ni `ajustes`.
- **Baja inmediata:** perfil inactivo + cuenta de Auth inhabilitada + `validSince` (revoca refresh tokens) + turnos futuros liberados.
- **QR firmado:** `MPC1.<sitio>.<versión>.<HMAC-SHA256 truncado a 128 bits>` con `QR_SECRET` (secret del Worker). El Worker rechaza firma alterada, versión vieja (regenerado), sitio distinto al esperado, sitio inactivo y formato inválido. Un guardia no puede obtener la firma de un QR; solo el admin o el supervisor del sitio.
- **Empalmes:** se validan en el Worker contra TODOS los turnos vigentes del guardia (cualquier sitio) y dentro del propio lote; el lote entero se rechaza (todo o nada).
- **Auditoría inmutable:** cada cambio escribe un documento en `auditoria/` en el mismo commit atómico (quién, qué, cuándo del servidor). Las reglas niegan toda escritura de cliente y el Worker solo crea. Se omiten PIN, contraseñas, hashes y tokens.
- **Zona horaria fija:** America/Hermosillo (UTC-7 sin horario de verano) en Worker y pantallas.
- **Entradas validadas** (tipos, longitudes, rangos) en el Worker; el cliente nunca escribe en Firestore.
- **Dependencias nuevas:** `qrcode-generator` 2.0.4 (MIT, sin dependencias propias), vendorizada en `js/vendor/qr.js`. `npm audit`: 0 vulnerabilidades.

### Riesgos pendientes de la Fase 2
1. Las lecturas de `get()` en reglas suman lecturas facturables por consulta; con pocos cientos de guardias es despreciable.
2. Los turnos denormalizan `sitioNombre`; si se renombra un sitio, los turnos ya creados conservan el nombre anterior (el guardia ve el nombre vigente en el sitio y las consignas).
3. El supervisor puede ver los nombres de todos los guardias activos (necesario para asignar turnos).
4. La baja de un guardia que nunca inició sesión no tiene cuenta de Auth que revocar; queda cubierto por `credenciales.activo=false` y por el perfil inactivo.

## Fase 3 — Entrada, salida, relevo y asistencia

**Verificaciones de una marca (todas en el Worker, el cliente solo guía):**
1. *Identidad y turno:* solo un `guardia` con un turno **propio**, programado y vigente. Turno ajeno o inexistente → misma respuesta 403 (no revela existencia). Admin y supervisor no pueden marcar.
2. *Ventana:* entrada desde `ventanaEntradaMin` antes del inicio (configurable, 30 por defecto) y antes del fin del turno. Una sola entrada y una sola salida por turno (`marcas/{turno}_{tipo}` con precondición «no existe»).
3. *GPS:* dentro del radio del sitio (haversine en el servidor) y precisión reportada ≤ radio. Se guardan lat, lng, precisión y distancia.
4. *QR:* firma HMAC válida, versión vigente (regenerar invalida el impreso) y del **sitio del turno**.
5. *Selfie:* JPEG real (cabecera FFD8FF y cierre FFD9), 1–150 KB. El cliente la toma de un cuadro de la cámara frontal **en vivo** (`getUserMedia`, sin selector de archivos) y la comprime a ≈100 KB.
6. *Hora:* siempre la del servidor (`tsMs` + marca de tiempo de Firestore); la del dispositivo se guarda solo como dato informativo con su desfase.
7. *Salida:* exige entrada previa; si hay un turno que releva en el mismo sitio y aún no marcó entrada, se rechaza (`relevo_pendiente`) salvo **autorización del supervisor** (documento inmutable con nombre y motivo).

**Selfies (Cloudflare R2):** bucket privado, sin dominio público ni URL pública; solo el Worker lo lee/escribe. `GET /selfies?marca=…` exige token válido y rol `admin` o el supervisor **actual** del sitio (si el sitio cambia de supervisor, el acceso lo sigue). El guardia no ve ni su propia foto. Respuesta `private, no-store`, `nosniff`. Una marca sin foto no existe (si falla el guardado de la marca se borra la foto huérfana).

**Inmutabilidad:** `marcas`, `ajustesAsistencia` y `autorizaciones` solo se crean (reglas niegan toda escritura de cliente y el Worker no actualiza ni borra). Una corrección es un **ajuste** con motivo y autor; la marca original nunca cambia. `asistencias` es un resultado **recalculable** (se sobrescribe), no una marca.

**Cálculo en el servidor:** retardo (> tolerancia, ≤ límite), falta (sin entrada o entrada pasado el límite), horas extra (salida − fin; en curso mientras el saliente sigue sin cerrar), alerta de relevo (fin + tolerancia sin entrada del relevo). Horas extra quedan **pendientes** hasta que un supervisor del sitio/admin las autorice o rechace con motivo; una decisión sobre minutos que luego cambian (por un ajuste) vuelve a pendiente. Límites legales de horas extra dobles por semana **configurables por año** (`limitesExtraPorAnio`; por defecto 2026: 9 h, 2027: 12 h). Un cron del Worker recalcula cada 5 min los turnos recientes.

**Lecturas (reglas):** guardia → sus `marcas` y `asistencias`; supervisor → `asistencias`, `ajustesAsistencia` y `autorizaciones` de sus sitios (nunca `marcas`, que traen GPS y ruta de la foto); admin → todo. La baja de una persona corta estas lecturas al instante.

**Permisos del navegador:** ubicación y cámara se piden solo al marcar, con explicación previa; no hay rastreo en segundo plano. Sin conexión no se marca (mensaje claro); el modo offline es de la Fase 6.

### Riesgos pendientes de la Fase 3
1. **«Cámara en vivo» no es demostrable por el servidor.** Un cliente manipulado puede enviar cualquier JPEG válido. Se mitiga con QR firmado + GPS en servidor + selfie revisable por el supervisor, y registrando el desfase del reloj del dispositivo. Verificación biométrica/liveness queda fuera de alcance.
2. **GPS falsificable** en dispositivos con ubicación simulada; el servidor solo ve coordenadas. La precisión reportada y la revisión de selfies reducen el riesgo.
3. **Relevo:** «sucesor» se infiere por el mismo sitio y un inicio entre 2 h antes y 4 h después del fin del turno. Turnos con huecos mayores no exigen relevo.
4. **Retención de selfies:** no hay borrado automático; la política de conservación debe definirla MARPEC (aviso de privacidad en borrador).
5. **Costos/cuotas:** el cron (cada 5 min) y las lecturas de `get()` en reglas consumen cuota gratuita de Firestore; vigilar al crecer el número de turnos simultáneos.
6. **jsQR 1.4.0** (Apache-2.0, sin dependencias, sin acceso a red) está vendorizada como lector de respaldo; su último release es de 2020. `npm audit`: 0 vulnerabilidades. En navegadores con `BarcodeDetector` no se usa.

## Fase 4 — Rondines

**QR de puntos:** formato `MPC2.<puntoId>.<versión>.<HMAC>`; el prefijo entra en el mensaje firmado (separación de dominios con el QR de asistencia `MPC1`). Un QR de asistencia no sirve como punto ni al revés, aunque se reescriba el prefijo. Cada punto tiene el suyo y «Regenerar» invalida el impreso. Solo el admin o el supervisor del sitio obtiene la firma; el guardia nunca.

**Escaneo (Worker):** hora del servidor; exige guardia con **turno propio, programado, con entrada marcada y sin salida**; el punto debe ser activo, de **su sitio**, versión vigente y formar parte del rondín en curso (los puntos se congelan al abrirse la ventana del rondín). Si el punto tiene GPS: precisión ≤ radio y distancia ≤ radio (30 m por defecto). Ruta ordenada: solo el siguiente punto. Un escaneo por punto y rondín (`escaneos/{rondín}_{punto}` con precondición «no existe»). Foto y nota opcionales; la foto va al mismo bucket R2 privado (`rondines/…`) y solo la sirve el Worker al admin o al supervisor actual del sitio.

**Estados (calculados por el Worker y por el cron de 5 min, recalculables, sin tocar los escaneos):** `programado` → `pendiente` (ventana abierta: programado ± tolerancia de inicio) → `no_iniciado` (pasó la tolerancia sin escanear nada) · `en_curso` → `completo` o `incompleto` (venció el plazo con puntos faltantes; los faltantes se listan como «puntos saltados») · `justificado` (ajuste) · `no_exigible` (el guardia nunca marcó entrada: ya es una falta de asistencia, no se duplica la alerta). Cumplimiento = completos / (completos + incompletos + no iniciados).

**Horarios en America/Hermosillo:** los rondines `cada X horas` salen de la hora de inicio del turno; los horarios fijos se interpretan en hora local, también tras medianoche; cada rondín se asigna al día **local** de su hora programada.

**Correcciones:** solo como `ajustesRondin` (marcar un punto como realizado, o justificar el rondín) con motivo obligatorio, nombre del autor y bitácora; el escaneo original nunca cambia.

**Lecturas (reglas):** admin y supervisor del sitio leen `puntos`, `programasRondin`, `rondines` y `ajustesRondin`; el guardia lee solo **sus** `rondines`; `escaneos` (GPS y ruta de la foto) solo el admin; el guardia recibe de `GET /rondines/proximo` únicamente lo necesario de su rondín en curso. La baja de una persona corta estas lecturas al instante.

**Exportación CSV:** con BOM UTF-8, escape de comas/comillas y neutralización de fórmulas (`=`, `+`, `-`, `@`).

### Riesgos pendientes de la Fase 4
1. **QR fotografiado:** un QR de punto impreso puede ser fotografiado y escaneado desde otro lugar. Se mitiga con el GPS del punto (opcional, recomendable) y la foto opcional; el rondín exige turno y entrada marcados.
2. **Puntos sin GPS** dependen solo del QR firmado.
3. **Cron:** cada ciclo recalcula solo los rondines con ventana activa; los rondines ya cerrados se consolidan al pasar su plazo. Los reportes de más de 2 días no fuerzan recálculo de rondines pasados.
4. **Cambios de puntos a mitad de turno:** los rondines cuya ventana ya abrió conservan los puntos que tenían; los siguientes usan la lista nueva.
