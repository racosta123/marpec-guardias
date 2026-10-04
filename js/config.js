// Configuración PÚBLICA del cliente. Nada de esto es secreto: la apiKey web de Firebase
// solo identifica el proyecto; la seguridad la dan las reglas de Firestore/Storage y el Worker.
// Valores a completar al crear el proyecto Firebase (ver docs/DESPLIEGUE.md).
export const config = {
  firebase: {
    apiKey: "REEMPLAZAR_AL_CREAR_PROYECTO",
    authDomain: "marpec-guardias.firebaseapp.com",
    projectId: "marpec-guardias",
  },
  workerUrl: "https://marpec-guardias-proxy.REEMPLAZAR.workers.dev",
};
