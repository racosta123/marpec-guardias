// Entrada de bundle: SOLO lo que la app usa del SDK de Firebase (Auth + Firestore, lectura).
export { initializeApp } from "firebase/app";
// initializeAuth SIN popupRedirectResolver: evita que el SDK cargue scripts de apis.google.com.
export {
  initializeAuth, indexedDBLocalPersistence, browserLocalPersistence,
  signInWithCustomToken, signInWithEmailAndPassword, onAuthStateChanged, signOut,
} from "firebase/auth";
export {
  getFirestore, doc, getDoc, collection, getDocs, query, where, orderBy, limit,
} from "firebase/firestore";
