#!/usr/bin/env node
// Grant a plan tier to a user by email or user id. Used during friend-
// testing to flip signups onto `beta`, and post-launch to flip donors onto
// `supporter` until the Stripe claim-code flow automates it. Reads
// AUTH_DB_PATH from env (same as server.js) and falls back to ./portaltext.db.
//
// Usage:
//   node scripts/grant-tier.js <email-or-user-id> <anon|free|plus|supporter|beta>
//
// Anon (account-less) users have no real email — grant by user id instead.
// The id shows up in the server's "[auth] anon identity created" log line
// and in TOKEN_USAGE entries.
//
// On Render (production DB on the mounted disk):
//   AUTH_DB_PATH=/var/data/portaltext.db node scripts/grant-tier.js friend@example.com beta

import Database from 'better-sqlite3';
import path from 'node:path';

const [, , rawWho, tier] = process.argv;
const VALID_TIERS = new Set(['anon', 'free', 'plus', 'supporter', 'beta']);

if (!rawWho || !tier) {
  console.error('usage: node scripts/grant-tier.js <email-or-user-id> <anon|free|plus|supporter|beta>');
  process.exit(1);
}
if (!VALID_TIERS.has(tier)) {
  console.error(`invalid tier: ${tier} (valid: ${[...VALID_TIERS].join(', ')})`);
  process.exit(1);
}

// Keep in sync with server.js PLAN_LIMITS — quota_remaining gets reset
// to the new tier's bank on every tier change so the usage ring reflects
// a fresh bucket rather than carrying over stale state from the prior tier.
// Unlimited tiers (supporter/beta) never read quota_remaining; 0 is fine.
const BANK_FOR_TIER = { anon: 280, free: 280, plus: 1050, supporter: 0, beta: 0 };

const who = rawWho.trim();
const byEmail = who.includes('@');
const dbPath = process.env.AUTH_DB_PATH || path.join(process.cwd(), 'portaltext.db');
const db = new Database(dbPath);
const before = byEmail
  ? db.prepare('SELECT id, plan_tier FROM users WHERE email = ?').get(who.toLowerCase())
  : db.prepare('SELECT id, plan_tier FROM users WHERE id = ?').get(who);
if (!before) {
  console.error(`no user found with ${byEmail ? 'email' : 'id'}: ${who}`);
  process.exit(1);
}
const freshBank = BANK_FOR_TIER[tier] ?? 0;
const now = Date.now();
db.prepare(
  'UPDATE users SET plan_tier = ?, quota_remaining = ?, last_refill_at = ?, daily_used = 0, pdf_daily_used = 0 WHERE id = ?'
).run(tier, freshBank, now, before.id);
console.log(`${who}: ${before.plan_tier} → ${tier} (quota reset to ${freshBank}, daily counters reset)`);
