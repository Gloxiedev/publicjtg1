import { setTimeout as sleep } from "node:timers/promises";

export const PANEL = process.env.PANEL_URL || "http://127.0.0.1:6767";
export const NODE1_PORT = Number(process.env.NODE1_PORT || 18081);
export const NODE2_PORT = Number(process.env.NODE2_PORT || 18082);
export const NODE1_HOST = process.env.NODE1_HOST || "node1.localhost";
export const NODE2_HOST = process.env.NODE2_HOST || "node2.localhost";

export const OWNER_USER = process.env.JTG_OWNER_USER || "jtgowner";
export const OWNER_PASS = process.env.JTG_OWNER_PASS || "jtgOwnerPass123";

const results = [];
let currentSection = "";

export function section(name) {
  currentSection = name;
  console.log(`\n\x1b[1m=== ${name} ===\x1b[0m`);
}

export function record(test, status, note = "") {
  results.push({ section: currentSection, test, status, note });
  const color = status === "PASS" ? 32 : status === "NOT TESTED" ? 33 : 31;
  console.log(`  \x1b[${color}m[${status}]\x1b[0m ${test}${note ? ` :: ${note}` : ""}`);
  return status === "PASS";
}

export function pass(test, note) { return record(test, "PASS", note); }
export function fail(test, note) { return record(test, "FAIL", note); }
export function notTested(test, note) { return record(test, "NOT TESTED", note); }

/** Record a result derived from a boolean condition. */
export function check(test, condition, note = "") {
  return condition ? pass(test, note) : fail(test, note);
}

export function getResults() { return results; }

export function printTable(rows) {
  const w = Math.max(...rows.map((r) => r[0].length)) + 2;
  const line = "-".repeat(w + 12);
  console.log("\n" + line);
  for (const [name, status] of rows) {
    const c = status === "PASS" ? 32 : status === "NOT TESTED" ? 33 : 31;
    console.log(name.padEnd(w) + `\x1b[${c}m${status}\x1b[0m`);
  }
  console.log(line);
}

export function summary() {
  const rows = results.map((r) => [r.test, r.status]);
  printTable(rows);
  const counts = results.reduce((acc, r) => ((acc[r.status] = (acc[r.status] || 0) + 1), acc), {});
  console.log(`\nTotals: PASS=${counts.PASS || 0} FAIL=${counts.FAIL || 0} NOT_TESTED=${counts["NOT TESTED"] || 0}`);
  return counts;
}

export async function api(path, { method = "GET", body, token, raw = false, headers = {} } = {}) {
  const h = { ...headers };
  if (body !== undefined) h["Content-Type"] = "application/json";
  if (token) h["Authorization"] = `Bearer ${token}`;
  const res = await fetch(PANEL + path, {
    method,
    headers: h,
    body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  if (raw) return { status: res.status, data, text, headers: res.headers };
  return data;
}

export async function login(username, password) {
  const r = await api("/api/auth/login", { method: "POST", body: { username, password } });
  if (!r?.token) throw new Error(`login failed for ${username}: ${JSON.stringify(r)}`);
  return r.token;
}

export async function waitFor(fn, { timeout = 20000, interval = 500, label = "condition" } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (e) {
      last = e.message;
    }
    await sleep(interval);
  }
  throw new Error(`timeout waiting for ${label} (last=${JSON.stringify(last)})`);
}

export async function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => (t = setTimeout(() => rej(new Error(`timeout: ${label}`)), ms)));
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(t); }
}

/** Read a JSON file, returning null when missing/corrupt. */
export async function readJson(file) {
  try {
    const fs = await import("node:fs/promises");
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch { return null; }
}

export async function writeJson(file, data) {
  const fs = await import("node:fs/promises");
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}
