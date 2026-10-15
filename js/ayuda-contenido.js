// Contenido FIJO del módulo Ayuda (sin servidor, sin IA). Cada respuesta se verificó contra las pantallas de la app:
// nombres de botones, menús y valores por defecto. Si cambia una pantalla, hay que cambiar aquí su respuesta.
//   para: "guardia" | "oficina" (admin y supervisor) · soloAdmin: el supervisor no la ve
//   ir: sección del menú a la que lleva «Ir a ese módulo» ("inicio" = pantalla de turno del guardia)
export const CATEGORIAS = {
  oficina: ["Personal", "Sitios y rondines", "Turnos", "Operación diaria", "Reportes y avisos", "Problemas comunes"],
  guardia: ["Mi turno", "Durante el turno", "Emergencias y sin internet", "Problemas comunes"],
};

export const PREGUNTAS = [
  // ---------------------------------------------------------------- oficina
  { id: "alta-guardia", para: "oficina", soloAdmin: true, cat: "Personal", ir: "personal",
    q: "¿Cómo doy de alta un guardia?",
    pasos: ["Abre el menú Personal.", "Toca «+ Guardia».", "Escribe el número de empleado (3 a 12 letras o números) y el nombre completo.", "Escribe el PIN inicial de 4 a 6 dígitos y toca «Dar de alta».", "Entrégale el número y el PIN en persona. Después asígnale un turno (sin turno no puede marcar entrada)."] },
  { id: "asignar-turno", para: "oficina", cat: "Turnos", ir: "turnos",
    q: "¿Dónde le asigno el turno a un guardia?",
    pasos: ["Abre el menú Turnos y elige el sitio en la lista de arriba.", "Toca «+ Agregar turnos».", "Elige la plantilla (Diurno, Nocturno, 12x24, 24x24 o Personalizada), las fechas Desde y Hasta y el guardia.", "Toca «Crear turnos». Si el guardia ya tiene un turno que se empalme, se rechaza todo el lote.", "Para cambiar un turno ya creado, tócalo en la semana: puedes asignar otro guardia o cancelarlo."],
    nota: "Sin turno asignado el guardia no puede marcar entrada. Si no eliges guardia, el turno queda «SIN CUBRIR»." },
  { id: "crear-sitio", para: "oficina", soloAdmin: true, cat: "Sitios y rondines", ir: "sitios",
    q: "¿Cómo creo un sitio y su QR?",
    pasos: ["Abre el menú Sitios y toca «+ Sitio».", "Escribe el nombre, y si quieres cliente, dirección, supervisor, consignas y teléfono de emergencia.", "En «Ubicación y perímetro» usa «📍 Usar mi ubicación actual» (estando en el sitio) o «🗺️ Elegir en el mapa». El radio es de 100 m por defecto (20 a 1000).", "Toca «Crear sitio».", "En la tarjeta del sitio toca «QR de asistencia», imprímelo y pégalo en el puesto."],
    nota: "Sin ubicación capturada nadie puede marcar en ese sitio. «Regenerar QR» invalida el QR impreso: tendrás que imprimir el nuevo." },
  { id: "alta-supervisor", para: "oficina", soloAdmin: true, cat: "Personal", ir: "personal",
    q: "¿Cómo doy de alta un supervisor?",
    pasos: ["Abre el menú Personal y toca «+ Supervisor».", "Escribe su nombre completo y su correo.", "Toca «Dar de alta y enviar enlace».", "El supervisor recibe un correo para definir su propia contraseña y entra por la pestaña «Supervisor / Admin».", "Asígnale sus sitios en Sitios → Editar → «Supervisor asignado»."] },
  { id: "desbloquear-pin", para: "oficina", soloAdmin: true, cat: "Personal", ir: "personal",
    q: "¿Cómo desbloqueo el PIN de un guardia?",
    pasos: ["Abre el menú Personal.", "En la fila del guardia toca «PIN».", "Si recuerda su PIN: toca «Desbloquear sin cambiar el PIN».", "Si lo olvidó: escribe un nuevo PIN de 4 a 6 dígitos y toca «Restablecer PIN» (también lo desbloquea). Entrégaselo en persona."],
    nota: "Tras 5 intentos fallidos el acceso se bloquea 15 minutos; también se desbloquea solo al pasar ese tiempo." },
  { id: "baja-reactivar", para: "oficina", soloAdmin: true, cat: "Personal", ir: "personal",
    q: "¿Cómo doy de baja o reactivo a alguien?",
    pasos: ["Abre el menú Personal.", "Para dar de baja: toca «Dar de baja» y confirma. Pierde el acceso al instante y sus turnos futuros quedan sin cubrir.", "Para reactivar: en la fila de quien está de baja toca «Reactivar».", "Al reactivar a un guardia, vuelve a asignarle sus turnos."] },
  { id: "horas-extra", para: "oficina", cat: "Operación diaria", ir: "asistencia",
    q: "¿Cómo autorizo horas extra?",
    pasos: ["Abre el menú Asistencia.", "Busca el bloque «Horas extra por autorizar».", "Toca «Autorizar» o «Rechazar», escribe el motivo (obligatorio) y confirma.", "Queda registrado con tu nombre."],
    nota: "Mientras el guardia siga en el puesto los botones están desactivados: se resuelven cuando cierra su turno." },
  { id: "revisar-incidencia", para: "oficina", cat: "Operación diaria", ir: "incidencias",
    q: "¿Cómo reviso una incidencia?",
    pasos: ["Abre el menú Incidencias. Arriba aparecen las de gravedad ALTA sin cerrar.", "Usa los filtros de sitio, estado, gravedad y fechas (por defecto los últimos 30 días).", "Toca «En atención» cuando la estés atendiendo, «Comentar» para agregar seguimiento y «Cerrar» al resolverla.", "Si tiene fotos, toca «Foto 1», «Foto 2»… para verlas."],
    nota: "Las incidencias no se editan: cada cambio queda como registro nuevo con tu nombre y la hora." },
  { id: "puntos-rondin", para: "oficina", cat: "Sitios y rondines", ir: "sitios",
    q: "¿Cómo creo puntos de rondín?",
    pasos: ["Abre Sitios (o «Mis sitios» si eres supervisor) y en el sitio toca «Puntos y rondín».", "Toca «+ Punto», escribe el nombre y dónde está. El GPS del punto es opcional (radio de 30 m por defecto).", "Toca «Agregar punto». Repite por cada lugar del recorrido y ordénalos con ▲ ▼.", "Toca «Programar rondín»: elige ruta libre u ordenada y la frecuencia (cada X horas o en horarios fijos).", "Toca «🖨 Hoja de QR», imprime los QR y pega cada uno en su punto."],
    nota: "Sin programación no se generan rondines en ese sitio." },
  { id: "sin-conexion", para: "oficina", cat: "Operación diaria", ir: "offline",
    q: "¿Qué hago con un registro «Sin conexión»?",
    pasos: ["Abre el menú Sin conexión.", "En «Por revisar» verás lo que el guardia capturó sin internet, con la hora estimada, la del celular y la de recepción.", "Si la hora es razonable toca «Aceptar».", "Si no, toca «Ajustar», escribe la hora real y el motivo (mínimo 5 caracteres) y guarda."],
    nota: "El servidor ya validó el QR, la ubicación y el turno. El registro original no se modifica: el ajuste queda con tu nombre." },
  { id: "reporte", para: "oficina", soloAdmin: true, cat: "Reportes y avisos", ir: "reportes",
    q: "¿Cómo saco un reporte?",
    pasos: ["Abre el menú Reportes.", "Elige Desde, Hasta y el sitio (o «Todos los sitios»).", "Toca «Generar reporte»: verás el resumen por guardia, las horas extra por semana y el detalle.", "Toca «⬇ Exportar CSV» para abrirlo en Excel."],
    nota: "Las incidencias tienen su propio botón «⬇ CSV» en el menú Incidencias." },
  { id: "notificaciones", para: "oficina", cat: "Reportes y avisos", ir: "alertas",
    q: "¿Cómo activo las notificaciones?",
    pasos: ["Abre el menú Alertas (o la campana de arriba).", "Toca «🔔 Activar notificaciones» y acepta el permiso del navegador.", "Marca qué alertas quieres recibir: incidencia de gravedad alta, relevo que no llegó y rondín no iniciado o incompleto. El pánico siempre se avisa.", "Hazlo en cada celular o computadora donde quieras recibirlas."],
    nota: "En iPhone primero instala la app (Compartir → Añadir a pantalla de inicio) y ábrela desde ahí; requiere iOS 16.4 o superior." },
  { id: "reglas-empresa", para: "oficina", soloAdmin: true, cat: "Reportes y avisos", ir: "empresa",
    q: "¿Dónde cambio las reglas de la empresa (retardos, ventana de entrada)?",
    pasos: ["Abre el menú Empresa.", "Revisa la ventana de entrada (30 min antes por defecto), la tolerancia de retardo (10 min), el límite de falta (30 min), los retardos que equivalen a una falta (3) y la tolerancia de relevo (30 min).", "Toca «Guardar configuración».", "Abajo puedes ajustar el catálogo de tipos de incidencia."] },
  // problemas comunes (oficina)
  { id: "p-perimetro", para: "oficina", cat: "Problemas comunes", ir: "sitios",
    q: "El guardia dice «Estás fuera del perímetro»",
    pasos: ["Revisa en Sitios que la ubicación del sitio sea la correcta (mejor capturada estando en el puesto).", "Si el puesto es grande, aumenta el «Radio del perímetro» (20 a 1000 m).", "Si el mensaje habla de la precisión del GPS, el guardia debe salir a cielo abierto y reintentar."] },
  { id: "p-qr", para: "oficina", cat: "Problemas comunes", ir: "sitios",
    q: "El celular no lee el QR",
    pasos: ["Comprueba que el guardia escanee el «QR de asistencia» de SU sitio (no el de un punto de rondín ni el de otro sitio).", "Si alguien regeneró el QR, el impreso ya no sirve: imprime el actual desde Sitios → «QR de asistencia».", "Que limpie la cámara, acerque el celular y tenga buena luz."] },
  { id: "p-pin", para: "oficina", cat: "Problemas comunes", ir: "personal",
    q: "El guardia tiene el PIN bloqueado",
    pasos: ["Tras 5 intentos fallidos se bloquea 15 minutos; se libera solo.", "El administrador puede liberarlo antes en Personal → «PIN» → «Desbloquear sin cambiar el PIN».", "Si lo olvidó, el administrador le pone uno nuevo con «Restablecer PIN»."] },
  { id: "p-cierre", para: "oficina", cat: "Problemas comunes", ir: "asistencia",
    q: "El guardia no puede cerrar su turno",
    pasos: ["Pasa cuando su relevo aún no marca entrada: no puede irse dejando el puesto solo.", "Si el relevo no llegará, abre Asistencia y en «⚠ Relevo no llegó» toca «Autorizar cierre sin relevo» con el motivo.", "El tiempo de más queda como horas extra para autorizar."] },
  { id: "p-notif", para: "oficina", cat: "Problemas comunes", ir: "alertas",
    q: "No me llegan las notificaciones",
    pasos: ["En Alertas revisa que diga «✔ Activadas en este dispositivo».", "Si dice que están bloqueadas, actívalas en los ajustes del navegador para este sitio.", "En iPhone deben estar con la app instalada en la pantalla de inicio (iOS 16.4 o superior).", "Con la app cerrada del todo o sin internet en el teléfono no llegan: revisa el panel En vivo."] },

  // ---------------------------------------------------------------- guardia
  { id: "g-entrada", para: "guardia", cat: "Mi turno", ir: "inicio",
    q: "¿Cómo marco mi entrada?",
    pasos: ["En tu pantalla de inicio toca «MARCAR ENTRADA» (aparece desde 30 minutos antes de tu turno, o lo que haya fijado la empresa).", "Toca «Comenzar» y permite la ubicación: debes estar dentro del puesto.", "Escanea el QR del puesto.", "Tómate la selfie con la cámara frontal.", "Toca «Registrar entrada»."] },
  { id: "g-salida", para: "guardia", cat: "Mi turno", ir: "inicio",
    q: "¿Cómo marco mi salida y dejo notas al relevo?",
    pasos: ["Toca «MARCAR SALIDA».", "Escribe las notas de entrega para tu relevo (opcional): novedades, llaves, equipo.", "Toca «Comenzar» y repite: ubicación, QR del puesto y selfie.", "Toca «Registrar salida»."],
    nota: "No podrás cerrar tu turno hasta que tu relevo marque entrada, salvo que tu supervisor lo autorice." },
  { id: "g-incidencia", para: "guardia", cat: "Durante el turno", ir: "inicio",
    q: "¿Cómo reporto una incidencia?",
    pasos: ["Con tu entrada ya marcada, en «Libro del turno» toca «Reportar incidencia».", "Elige el tipo, la gravedad y describe lo que pasó.", "Agrega hasta 3 fotos si puedes.", "Toca «Enviar incidencia»."] },
  { id: "g-visitante", para: "guardia", cat: "Durante el turno", ir: "inicio",
    q: "¿Cómo registro un visitante?",
    pasos: ["En «Libro del turno» toca «Visitantes».", "Toca «+ REGISTRAR ENTRADA».", "Escribe el nombre, a quién visita y el motivo (empresa, placas y foto del vehículo son opcionales).", "Toca «Registrar entrada».", "Cuando se vaya, en «Dentro del sitio ahora» toca «Registrar salida»."] },
  { id: "g-rondin", para: "guardia", cat: "Durante el turno", ir: "inicio",
    q: "¿Cómo hago un rondín?",
    pasos: ["Con tu entrada marcada, en la tarjeta «Rondines» toca «INICIAR RONDÍN» cuando sea la hora.", "Ve a cada punto y escanea su QR.", "Si te lo pide, permite la ubicación. Puedes agregar una nota o foto.", "Toca «Registrar punto» y sigue con el siguiente hasta completarlos."] },
  { id: "g-sin-internet", para: "guardia", cat: "Emergencias y sin internet", ir: "inicio",
    q: "¿Qué hago si no tengo internet?",
    pasos: ["Sigue trabajando normal: marcar, reportar, visitantes y rondines se guardan en tu celular.", "Arriba verás «Sin conexión» y cuántos registros faltan por enviar.", "Al volver la señal se envían solos; también puedes tocar «Enviar ahora».", "NO cierres sesión con registros pendientes: se borrarían."] },
  { id: "g-panico", para: "guardia", cat: "Emergencias y sin internet", ir: "inicio",
    q: "¿Cómo uso el botón de pánico?",
    pasos: ["Mantén presionado el botón rojo «Pánico» 3 segundos.", "Se avisa a tu supervisor y a la administración con tu ubicación.", "Sin internet la alerta se guarda y se envía al volver la señal: usa los botones para llamar al supervisor o al 911."] },
  { id: "g-no-marca", para: "guardia", cat: "Problemas comunes", ir: "inicio",
    q: "¿Qué hago si no me deja marcar?",
    pasos: ["Si no ves el botón: aún no es la hora (se habilita 30 minutos antes, o lo que haya fijado la empresa) o no tienes turno asignado. Avisa a tu supervisor.", "«Fuera del perímetro»: acércate al puesto o sal a cielo abierto y reintenta.", "«Ese QR es de otro puesto»: escanea el QR de tu puesto.", "«El sitio aún no tiene ubicación»: avisa a tu supervisor."] },
  { id: "g-p-perimetro", para: "guardia", cat: "Problemas comunes", ir: "inicio",
    q: "Me dice que estoy fuera del perímetro",
    pasos: ["Acércate al punto donde está el QR del puesto.", "Sal a cielo abierto para que el GPS sea preciso y toca «Reintentar».", "Si sigue fallando dentro del puesto, avisa a tu supervisor."] },
  { id: "g-p-qr", para: "guardia", cat: "Problemas comunes", ir: "inicio",
    q: "La cámara no lee el QR",
    pasos: ["Limpia la cámara y acércate con buena luz.", "Asegúrate de escanear el QR de asistencia de tu puesto (no el de un punto de rondín).", "Si el QR está dañado o lo cambiaron, avisa a tu supervisor."] },
  { id: "g-p-pin", para: "guardia", cat: "Problemas comunes", ir: "inicio",
    q: "Mi PIN está bloqueado",
    pasos: ["Tras 5 intentos fallidos se bloquea 15 minutos: espera y vuelve a intentar.", "Si olvidaste tu PIN, pide a la administración uno nuevo (te lo entregan en persona)."] },
  { id: "g-p-cierre", para: "guardia", cat: "Problemas comunes", ir: "inicio",
    q: "No me deja cerrar mi turno",
    pasos: ["Tu relevo aún no marca entrada: espera a que llegue.", "Si no llegará, pide a tu supervisor que autorice el cierre sin relevo.", "El tiempo de más queda registrado como horas extra."] },
];

// Preguntas que ve cada rol (el supervisor no ve las exclusivas del administrador).
export function preguntasDe(rol) {
  if (rol === "guardia") return PREGUNTAS.filter((p) => p.para === "guardia");
  return PREGUNTAS.filter((p) => p.para === "oficina" && (rol === "admin" || !p.soloAdmin));
}

// Búsqueda local: sin acentos ni mayúsculas, todas las palabras deben aparecer (pregunta, pasos, nota o categoría).
const normal = (s) => String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export function buscar(lista, texto) {
  const palabras = normal(texto).split(/\s+/).filter(Boolean);
  if (!palabras.length) return lista;
  return lista.filter((p) => { const t = normal([p.q, p.cat, p.nota || "", ...p.pasos].join(" ")); return palabras.every((w) => t.includes(w)); });
}
