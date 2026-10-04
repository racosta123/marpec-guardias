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
3. **Revocación:** un guardia dado de baja pierde acceso en el Worker de inmediato (`activo=false`), pero su ID token vigente (≤1 h) sigue siendo aceptado por las reglas de Firestore para leer su propio perfil. Fase 2: revocar *refresh tokens* al desactivar.
4. **Auto-registro de Firebase Auth:** con Email/Password activo, cualquiera con la apiKey pública puede crear cuentas sin rol. No obtienen acceso a nada (reglas + Worker), pero ensucian el directorio. Desactivar el registro (Identity Platform) cuando se pueda.
5. **CORS por origen, no por ruta:** `https://<usuario>.github.io` es compartido por todos los sitios de esa cuenta de GitHub. Un dominio propio lo resolvería.
6. **Icono PWA:** el logo entregado es 211×225 px. Para una instalación nítida se recomienda una versión ≥512 px (no se modificó el logo).
7. Aviso de privacidad es **borrador** y requiere revisión legal.
