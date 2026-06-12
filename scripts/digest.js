#!/usr/bin/env node
// Friend-testing usage digest. Reads the append-only TOKEN_USAGE_LOG JSONL
// + the users table and prints a per-user / per-endpoint summary across a
// few rolling windows. Run it whenever you want a snapshot — no schedule,
// no UI, just a thing to open.
//
// Usage (local, against downloaded files):
//   node scripts/digest.js
//
// Usage (on Render shell, against the live data):
//   AUTH_DB_PATH=/var/data/portaltext.db \
//   TOKEN_USAGE_LOG=/var/data/token-usage.jsonl \
//   node scripts/digest.js
//
// Defaults: TOKEN_USAGE_LOG=./token-usage.jsonl, AUTH_DB_PATH=./portaltext.db.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const LOG_PATH = process.env.TOKEN_USAGE_LOG || path.join(process.cwd(), 'token-usage.jsonl');
const DB_PATH  = process.env.AUTH_DB_PATH    || path.join(process.cwd(), 'portaltext.db');
const NOW = Date.now();
const DAY = 24 * 60 * 60 * 1000;

// ---- load token-usage events ----
async function readEvents(file) {
  if (!fs.existsSync(file)) {
    console.error(`(no log at ${file} — set TOKEN_USAGE_LOG or run from project root)`);
    return [];
  }
  const events = [];
  const rl = readline.createInterface({ input: fs.createReadStream(file) });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      e.ts = new Date(e.ts).getTime();
      // Field-name compat: older entries used `tester`, current code writes `user`.
      e.uid = e.user || e.tester || 'anonymous';
      events.push(e);
    } catch { /* skip malformed */ }
  }
  return events;
}

// ---- load users for id → email mapping ----
function loadUsers(dbPath) {
  if (!fs.existsSync(dbPath)) {
    console.error(`(no db at ${dbPath} — emails will show as user-ids)`);
    return new Map();
  }
  const db = new Database(dbPath, { readonly: true });
  const rows = db.prepare('SELECT id, email, plan_tier, usage_count, created_at FROM users').all();
  db.close();
  const m = new Map();
  for (const r of rows) m.set(r.id, r);
  return m;
}

// ---- formatters ----
const fmtCost = (n) => n >= 0.01 ? `$${n.toFixed(2)}` : `$${n.toFixed(4)}`;
const fmtPct = (n, t) => t === 0 ? '  0%' : `${(n / t * 100).toFixed(0).padStart(3)}%`;
const trunc = (s, n) => s.length <= n ? s : s.slice(0, n - 1) + '…';
const pad = (s, n) => String(s).padEnd(n);
const padL = (s, n) => String(s).padStart(n);

function summarize(events) {
  let calls = 0, cost = 0, inTok = 0, outTok = 0, cacheR = 0, cacheW = 0;
  const users = new Set();
  for (const e of events) {
    calls++;
    cost += e.cost || 0;
    inTok += e.in || 0;
    outTok += e.out || 0;
    cacheR += e.cacheR || 0;
    cacheW += e.cacheW || 0;
    users.add(e.uid);
  }
  const cacheHitRate = (inTok + cacheR) > 0 ? cacheR / (inTok + cacheR) : 0;
  return { calls, cost, users: users.size, cacheHitRate, inTok, outTok };
}

function byUser(events, usersMap) {
  const m = new Map();
  for (const e of events) {
    if (!m.has(e.uid)) m.set(e.uid, { calls: 0, cost: 0 });
    const r = m.get(e.uid);
    r.calls++;
    r.cost += e.cost || 0;
  }
  return [...m.entries()]
    .map(([uid, r]) => {
      const u = usersMap.get(uid);
      return {
        uid,
        email: u ? u.email : uid,
        plan: u ? u.plan_tier : '—',
        calls: r.calls,
        cost: r.cost,
      };
    })
    .sort((a, b) => b.cost - a.cost);
}

function byKey(events, key) {
  const m = new Map();
  for (const e of events) {
    const k = e[key] || '—';
    if (!m.has(k)) m.set(k, { calls: 0, cost: 0 });
    const r = m.get(k);
    r.calls++;
    r.cost += e.cost || 0;
  }
  return [...m.entries()]
    .map(([k, r]) => ({ key: k, ...r }))
    .sort((a, b) => b.calls - a.calls);
}

// ---- rendering blocks ----
function renderSummary(label, events) {
  const s = summarize(events);
  console.log(`== ${label} ==`);
  console.log(`  calls    ${s.calls}`);
  console.log(`  cost     ${fmtCost(s.cost)}`);
  console.log(`  users    ${s.users} active`);
  console.log(`  cache    ${(s.cacheHitRate * 100).toFixed(0)}% hit rate`);
  if (s.users > 0) console.log(`  per-user ${fmtCost(s.cost / s.users)} avg`);
  console.log('');
}

function renderUserTable(label, events, usersMap, limit = 20) {
  const rows = byUser(events, usersMap);
  if (rows.length === 0) return;
  console.log(`== ${label} ==`);
  console.log(`  ${pad('email', 36)} ${pad('plan', 6)} ${padL('calls', 6)} ${padL('cost', 8)}`);
  console.log(`  ${'─'.repeat(36)} ${'─'.repeat(6)} ${'─'.repeat(6)} ${'─'.repeat(8)}`);
  for (const r of rows.slice(0, limit)) {
    console.log(`  ${pad(trunc(r.email, 36), 36)} ${pad(r.plan, 6)} ${padL(r.calls, 6)} ${padL(fmtCost(r.cost), 8)}`);
  }
  if (rows.length > limit) console.log(`  …and ${rows.length - limit} more`);
  console.log('');
}

function renderBreakdown(label, events, key) {
  const rows = byKey(events, key);
  if (rows.length === 0) return;
  const total = rows.reduce((s, r) => s + r.calls, 0);
  console.log(`== ${label} ==`);
  for (const r of rows) {
    console.log(`  ${pad(trunc(r.key, 32), 32)} ${padL(r.calls, 6)}  ${fmtPct(r.calls, total)}   ${fmtCost(r.cost)}`);
  }
  console.log('');
}

function renderAccountsSnapshot(usersMap) {
  if (usersMap.size === 0) return;
  console.log(`== accounts snapshot (DB) ==`);
  console.log(`  ${pad('email', 36)} ${pad('plan', 6)} ${padL('used', 6)}  joined`);
  console.log(`  ${'─'.repeat(36)} ${'─'.repeat(6)} ${'─'.repeat(6)}  ${'─'.repeat(10)}`);
  const rows = [...usersMap.values()].sort((a, b) => b.created_at - a.created_at);
  for (const u of rows) {
    const joined = new Date(u.created_at).toISOString().slice(0, 10);
    console.log(`  ${pad(trunc(u.email, 36), 36)} ${pad(u.plan_tier, 6)} ${padL(u.usage_count, 6)}  ${joined}`);
  }
  console.log('');
}

// ---- main ----
const events = await readEvents(LOG_PATH);
const usersMap = loadUsers(DB_PATH);
const since = (days) => events.filter(e => NOW - e.ts < days * DAY);

console.log('');
console.log(`portaltext usage digest — ${new Date().toISOString().slice(0, 10)}`);
console.log(`source: ${LOG_PATH}`);
console.log(`        ${DB_PATH}`);
console.log('');

renderSummary('last 24h', since(1));
renderSummary('last 7d',  since(7));
renderSummary('last 30d', since(30));
renderSummary('all-time', events);

renderUserTable('top users (7d)',  since(7),  usersMap);
renderUserTable('top users (30d)', since(30), usersMap);

renderBreakdown('endpoints (7d)', since(7),  'endpoint');
renderBreakdown('models (7d)',    since(7),  'model');

renderAccountsSnapshot(usersMap);
