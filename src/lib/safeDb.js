// src/lib/safeDb.js
import { get, set, update, remove } from "firebase/database";

const DEFAULT_TIMEOUT_MS = 800;

export async function safeDbGet(dbRef, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return Promise.race([
    get(dbRef),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Database read timed out")), timeoutMs)
    ),
  ]);
}

export async function safeDbSet(dbRef, val, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return Promise.race([
    set(dbRef, val),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Database write timed out")), timeoutMs)
    ),
  ]);
}

export async function safeDbUpdate(dbRef, val, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return Promise.race([
    update(dbRef, val),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Database update timed out")), timeoutMs)
    ),
  ]);
}

export async function safeDbRemove(dbRef, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return Promise.race([
    remove(dbRef),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Database remove timed out")), timeoutMs)
    ),
  ]);
}
