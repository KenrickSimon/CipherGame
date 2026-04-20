// ════════════════════════════════════════════════════════════════
//  firebase.js — Firebase config + DB abstraction layer
//  Replace firebaseConfig with your own credentials from:
//  https://console.firebase.google.com
// ════════════════════════════════════════════════════════════════

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import {
  getDatabase, ref, set, get,
  onValue, update, remove, off
} from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

// ── REPLACE THIS WITH YOUR OWN CONFIG ──────────────────────────
const firebaseConfig = {
  apiKey: "AIzaSyBzFfsSUWOZkczlRm3uAOSR0toLYSUpwCY",
  authDomain: "numberguessing-b1b2c.firebaseapp.com",
  databaseURL: "https://numberguessing-b1b2c-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "numberguessing-b1b2c",
  storageBucket: "numberguessing-b1b2c.firebasestorage.app",
  messagingSenderId: "13643712631",
  appId: "1:13643712631:web:5981bffb9387e975995e72",
  measurementId: "G-18JCT86NVP",
};
// ───────────────────────────────────────────────────────────────

// ── LocalStorage / In-Memory Fallback ────────────────────────────────────────
//  Used when Firebase is not configured — works for local / singleplayer testing.

const localDB   = {};
const localSubs = {}; // path → callback

function localWrite(path, val) {
  const keys = path.split('/');
  let node = localDB;
  for (let i = 0; i < keys.length - 1; i++) {
    if (node[keys[i]] == null || typeof node[keys[i]] !== 'object') node[keys[i]] = {};
    node = node[keys[i]];
  }
  node[keys[keys.length - 1]] = val;
  // Notify any listeners whose path overlaps
  for (const sub of Object.keys(localSubs)) {
    if (path.startsWith(sub) || sub.startsWith(path)) {
      localSubs[sub]?.(localRead(sub));
    }
  }
}

function localRead(path) {
  const keys = path.split('/');
  let node = localDB;
  for (const k of keys) {
    if (node == null) return null;
    node = node[k];
  }
  return node ?? null;
}

function localMerge(path, obj) {
  for (const [k, v] of Object.entries(obj)) localWrite(`${path}/${k}`, v);
}

// ── Firebase Init ─────────────────────────────────────────────────────────────
let db       = null;
let useLocal = false;

try {
  if (firebaseConfig.apiKey === 'YOUR_API_KEY') throw new Error('Config not set');
  const app = initializeApp(firebaseConfig);
  db = getDatabase(app);
  console.log('[CIPHER] Firebase connected.');
} catch (e) {
  useLocal = true;
  console.warn('[CIPHER] Firebase not configured — running in local mode.');
}

// ── Public DB API ─────────────────────────────────────────────────────────────
//  Uniform interface used by game.js regardless of backend.

export const DB = {
  /**
   * Write a value at path (overwrites).
   */
  set(path, val) {
    if (useLocal) return localWrite(path, val);
    return set(ref(db, path), val);
  },

  /**
   * Read a value once at path.
   * @returns {Promise<any>}
   */
  async get(path) {
    if (useLocal) return localRead(path);
    const snap = await get(ref(db, path));
    return snap.val();
  },

  /**
   * Subscribe to real-time changes at path.
   * Callback fires immediately with current value, then on every change.
   * @param {string} path
   * @param {function} cb
   */
  subscribe(path, cb) {
    if (useLocal) { localSubs[path] = cb; cb(localRead(path)); return; }
    onValue(ref(db, path), snap => cb(snap.val()));
  },

  /**
   * Unsubscribe from a path.
   */
  unsubscribe(path) {
    if (useLocal) { delete localSubs[path]; return; }
    off(ref(db, path));
  },

  /**
   * Merge (shallow update) an object into path.
   */
  update(path, obj) {
    if (useLocal) return localMerge(path, obj);
    return update(ref(db, path), obj);
  },

  /**
   * Delete a path.
   */
  remove(path) {
    if (useLocal) return localWrite(path, null);
    return remove(ref(db, path));
  },

  /** Is the game running locally (no Firebase)? */
  get isLocal() { return useLocal; }
};
