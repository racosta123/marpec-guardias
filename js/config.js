// Configuración PÚBLICA del cliente. Nada de esto es secreto: la apiKey web de Firebase
// solo identifica el proyecto; la seguridad la dan las reglas de Firestore y el Worker.
export const config = {
  firebase: {
    apiKey: "AIzaSyC5cCkRMuf4z1RkkTTL_MAu8QkO0PgIXWY",
    authDomain: "marpec-guardias.firebaseapp.com",
    projectId: "marpec-guardias",
  },
  workerUrl: "https://marpec-guardias-proxy.acosta4770.workers.dev",
};
