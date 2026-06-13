import http from 'node:http';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';
import dns from 'node:dns/promises';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { parseHTML } from 'linkedom';
import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import sharp from 'sharp';
import Database from 'better-sqlite3';

// Local-dev convenience: auto-load .env if present, so `npm start` works locally
// without --env-file. In production (Render etc.) there's no .env file and the
// host injects env vars directly — this is a no-op there.
try {
  const env = fsSync.readFileSync('.env', 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
} catch { /* no .env, that's fine */ }

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT) || 3000;
// Wikimedia's User-Agent policy: bare strings get rate-limited aggressively at
// the edge. UAs that include contact info (a URL or email) are treated as
// well-behaved clients. https://meta.wikimedia.org/wiki/User-Agent_policy
const WIKI_USER_AGENT = 'portaltext/0.1 (https://github.com/alaskahoffman/portaltext) Node-prototype';

if (!process.env.ANTHROPIC_API_KEY) {
  console.error('Missing ANTHROPIC_API_KEY. Put it in .env (key=value) and run `npm start`.');
  process.exit(1);
}

const claude = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 5 // SDK retries 429/5xx with exponential backoff before giving up
});

// Optional OpenAI-compatible providers for output-quality A/B testing.
// Activates when MODEL_PROVIDER=together or =openrouter.
const together = process.env.TOGETHER_API_KEY
  ? new OpenAI({
      apiKey: process.env.TOGETHER_API_KEY,
      baseURL: 'https://api.together.xyz/v1',
    })
  : null;
const openrouter = process.env.OPENROUTER_API_KEY
  ? new OpenAI({
      apiKey: process.env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    })
  : null;
const TOGETHER_MODEL   = process.env.TOGETHER_MODEL   || 'Qwen/Qwen3.5-397B-A17B';
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || 'qwen/qwen3.6-plus';
const MODEL_PROVIDER   = process.env.MODEL_PROVIDER   || 'anthropic';

// Resolve the active OpenAI-compatible client + model id for the current
// MODEL_PROVIDER. Returns nulls when the provider is anthropic or when the
// configured key is missing (in which case getModelStream falls back to
// Anthropic).
function getOpenAICompatProvider() {
  if (MODEL_PROVIDER === 'openrouter' && openrouter) {
    return { client: openrouter, model: OPENROUTER_MODEL };
  }
  if (MODEL_PROVIDER === 'together' && together) {
    return { client: together, model: TOGETHER_MODEL };
  }
  return { client: null, model: null };
}

// Returns the model id that actually answered the request — Anthropic uses
// the resolved model id, OpenAI-compatible providers override to whatever
// is configured. Used so the usage log + cost calc reflect what really ran.
function actualModel(anthropicModelId) {
  const { model } = getOpenAICompatProvider();
  return model || anthropicModelId;
}

// Print active provider config at boot so a misconfigured env is obvious
// in the deploy logs (rather than silently falling back to Anthropic).
{
  const active = getOpenAICompatProvider();
  const where = active.client ? `using ${active.model}` : 'no compatible provider → falling back to Anthropic';
  console.log(
    `[provider] MODEL_PROVIDER=${MODEL_PROVIDER}  ${where}  ` +
    `(together=${!!together}, openrouter=${!!openrouter})`
  );
}

// Wraps a model stream behind an Anthropic-shaped interface — yields the
// same `content_block_delta` events for the for-await loop, and exposes
// `finalMessage()` returning `{ usage }` in the Anthropic shape. Lets call
// sites stay identical regardless of which provider is active.
// `signal` (optional AbortSignal) cancels the provider request mid-stream —
// wired to the SSE response's 'close' event so a dismissed tooltip stops
// the token meter instead of generating into the void.
function getModelStream(opts, { signal } = {}) {
  const { client, model } = getOpenAICompatProvider();
  if (!client) {
    return claude.messages.stream(opts, { signal });
  }
  // OpenAI-compatible path (Together or OpenRouter). Convert Anthropic-style
  // options:
  //   system (top-level string) -> messages[0] with role:'system'
  //   stop_sequences -> stop
  //   content[].{type:'image', source:{type:'base64', media_type, data}}
  //     -> content[].{type:'image_url', image_url:{url:'data:<mt>;base64,<d>'}}
  // Log the *real* model id we asked for so the usage log shows what ran.
  const rawMessages = opts.system
    ? [{ role: 'system', content: opts.system }, ...opts.messages]
    : opts.messages;
  const messages = rawMessages.map((msg) => {
    if (!Array.isArray(msg.content)) return msg;
    const converted = msg.content.map((block) => {
      if (block.type === 'image' && block.source?.type === 'base64') {
        return {
          type: 'image_url',
          image_url: { url: `data:${block.source.media_type};base64,${block.source.data}` },
        };
      }
      return block;
    });
    return { ...msg, content: converted };
  });
  let finalUsage = null;
  const params = {
    model,
    max_tokens: opts.max_tokens,
    stop: opts.stop_sequences,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    // Qwen3 family thinking mode is on by default and burns the entire
    // token budget on <think>...</think> content that DOMPurify strips on
    // the client. Disable it so the model generates the actual answer.
    // Two different mechanisms because each provider exposes a different
    // hook; the unused one is ignored by the other:
    //   - chat_template_kwargs.enable_thinking → Together (Qwen3 native)
    //   - reasoning.enabled=false / exclude=true → OpenRouter's unified
    //     reasoning control (also caps effort low as a defensive layer in
    //     case `enabled` isn't recognized on the active route).
    chat_template_kwargs: { enable_thinking: false },
    reasoning: { enabled: false, exclude: true, effort: 'low' },
  };
  // Async iterable that re-emits Anthropic-style delta events.
  const iterable = (async function* () {
    const stream = await client.chat.completions.create(params, { signal });
    for await (const chunk of stream) {
      const text = chunk.choices?.[0]?.delta?.content;
      if (text) {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
      }
      if (chunk.usage) {
        finalUsage = {
          input_tokens: chunk.usage.prompt_tokens || 0,
          output_tokens: chunk.usage.completion_tokens || 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        };
      }
    }
  })();
  iterable.finalMessage = async () => ({ usage: finalUsage });
  return iterable;
}

// Friendly model keys exposed to clients. Server resolves them to actual
// Anthropic model IDs so we can swap underlying versions without breaking
// the extension. Annotation passes (Bible/Manifesto/Gutenberg) are NOT
// switchable — they're heavy-output and infrequent (cached per chapter),
// so always use Haiku to keep costs predictable. Only the per-hover
// tooltip streams respect the client's selected model.
//
// When pro tier ships, gate 'smart' (and any future 'best') behind an
// auth check before resolution — for now any client can request any key.
const MODEL_KEYS = {
  fast:  'claude-haiku-4-5-20251001',
  smart: 'claude-sonnet-4-6',
};
const DEFAULT_MODEL_KEY = 'fast';
function resolveModel(key) {
  return MODEL_KEYS[key] || MODEL_KEYS[DEFAULT_MODEL_KEY];
}

// Per-model pricing in USD per million tokens. Approximate — update when
// Anthropic publishes changes. Cache-read tokens are billed at ~10% of the
// regular input rate; cache-creation at ~125%. We pull both off the usage
// object so the per-call cost is exact when prompt caching kicks in.
const MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { in: 1.00, out: 5.00,  cacheRead: 0.10, cacheWrite: 1.25 },
  'claude-sonnet-4-6':         { in: 3.00, out: 15.00, cacheRead: 0.30, cacheWrite: 3.75 },
  // Together AI Qwen pricing — placeholder; update from together.ai/pricing.
  // Env vars TOGETHER_INPUT_PRICE / TOGETHER_OUTPUT_PRICE override at runtime.
  'Qwen/Qwen3.5-397B-A17B':    {
    in:  Number(process.env.TOGETHER_INPUT_PRICE)  || 0.60,
    out: Number(process.env.TOGETHER_OUTPUT_PRICE) || 1.80,
    cacheRead: 0, cacheWrite: 0,
  },
  // OpenRouter qwen3.6-plus pricing as of 2026-05-25: $0.325/M in, $1.95/M out.
  // Env vars OPENROUTER_INPUT_PRICE / OPENROUTER_OUTPUT_PRICE override.
  'qwen/qwen3.6-plus':         {
    in:  Number(process.env.OPENROUTER_INPUT_PRICE)  || 0.325,
    out: Number(process.env.OPENROUTER_OUTPUT_PRICE) || 1.95,
    cacheRead: 0, cacheWrite: 0,
  },
};

function computeCost(model, usage) {
  let p = MODEL_PRICING[model];
  // Fallback: if the specific model isn't in the table, use the active
  // provider's env-var pricing. Lets us swap OpenRouter/Together models
  // via env var alone (no code push) and still get accurate cost logs,
  // as long as OPENROUTER_INPUT_PRICE / TOGETHER_INPUT_PRICE etc. are set.
  if (!p) {
    if (MODEL_PROVIDER === 'openrouter' && process.env.OPENROUTER_INPUT_PRICE) {
      p = {
        in:  Number(process.env.OPENROUTER_INPUT_PRICE),
        out: Number(process.env.OPENROUTER_OUTPUT_PRICE) || 0,
        cacheRead: 0, cacheWrite: 0,
      };
    } else if (MODEL_PROVIDER === 'together' && process.env.TOGETHER_INPUT_PRICE) {
      p = {
        in:  Number(process.env.TOGETHER_INPUT_PRICE),
        out: Number(process.env.TOGETHER_OUTPUT_PRICE) || 0,
        cacheRead: 0, cacheWrite: 0,
      };
    }
  }
  if (!p || !usage) return 0;
  const inTok    = usage.input_tokens || 0;
  const outTok   = usage.output_tokens || 0;
  const cacheR   = usage.cache_read_input_tokens || 0;
  const cacheW   = usage.cache_creation_input_tokens || 0;
  return (inTok * p.in + outTok * p.out + cacheR * p.cacheRead + cacheW * p.cacheWrite) / 1_000_000;
}

// Append-only JSONL token-usage log. One line per Anthropic call. Includes
// authenticated user id (or 'anonymous'), endpoint, model, raw usage counts,
// and computed dollar cost. Set TOKEN_USAGE_LOG=/var/data/token-usage.jsonl
// in production so the log lives on the persistent disk and survives redeploys
// (otherwise the default path is the deploy directory, which is ephemeral).
// Tally with:
//   node scripts/digest.js
// The `tester` parameter name in recordTokenUsage() predates the auth system —
// it's actually the authenticated user id (or null for anonymous demo traffic).
const TOKEN_USAGE_LOG = process.env.TOKEN_USAGE_LOG || path.join(__dirname, 'token-usage.jsonl');

// ---------- Global daily spend breaker ----------
// Hard ceiling on what the server will spend on model inference per UTC day.
// Every recordTokenUsage call accrues into todaySpend; once it crosses
// DAILY_SPEND_CAP_USD, gateAiRequest pauses server-paid inference for
// non-funded tiers until the next UTC day. This is the backstop that makes
// "free for everyone" financially safe: worst-case daily spend is a number
// chosen in advance, regardless of virality or abuse. Set the env var to 0
// to disable.
const DAILY_SPEND_CAP_USD = Number(process.env.DAILY_SPEND_CAP_USD ?? 10);
let spendDay = new Date().toISOString().slice(0, 10);
let todaySpend = 0;

function rollSpendDay() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== spendDay) {
    spendDay = today;
    todaySpend = 0;
  }
}
function noteSpend(cost) {
  rollSpendDay();
  todaySpend += cost || 0;
}
function spendBreakerTripped() {
  if (!(DAILY_SPEND_CAP_USD > 0)) return false;
  rollSpendDay();
  return todaySpend >= DAILY_SPEND_CAP_USD;
}

// Seed today's total from the usage log so a mid-day restart (deploys
// happen) doesn't reset the breaker to zero. Sync read at boot only.
try {
  const lines = fsSync.readFileSync(TOKEN_USAGE_LOG, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.startsWith(`{"ts":"${spendDay}`)) continue;
    try { todaySpend += JSON.parse(line).cost || 0; } catch {}
  }
  if (todaySpend > 0) console.log(`[spend] seeded today's total from log: $${todaySpend.toFixed(4)}`);
} catch { /* no log yet — fresh deploy */ }

function recordTokenUsage({ tester, endpoint, model, usage }) {
  if (!usage) return;
  const cost = computeCost(model, usage);
  noteSpend(cost);
  const entry = {
    ts: new Date().toISOString(),
    user: tester || 'anonymous',
    endpoint,
    model,
    in: usage.input_tokens || 0,
    out: usage.output_tokens || 0,
    cacheR: usage.cache_read_input_tokens || 0,
    cacheW: usage.cache_creation_input_tokens || 0,
    cost: Number(cost.toFixed(6)),
  };
  // Stdout for easy `render logs | grep TOKEN_USAGE` tailing.
  console.log('TOKEN_USAGE', JSON.stringify(entry));
  // File for offline tallying. Append-only, fire-and-forget. fsSync gives
  // us the callback-style appendFile we want here (fs/promises is the
  // default elsewhere); rejections from a misfired promise would be noisy.
  fsSync.appendFile(TOKEN_USAGE_LOG, JSON.stringify(entry) + '\n', (err) => {
    if (err) console.warn('TOKEN_USAGE log write failed:', err.message);
  });
}

// Bounded-size LRU. Map iteration order is insertion-order, so we evict the
// oldest key (the head) when over capacity, and "touch" a get by deleting +
// re-inserting (which moves it to the tail = most-recently-used). Same API
// shape as Map (has/get/set/delete) so call sites are unchanged.
function lru(max) {
  const m = new Map();
  return {
    has: k => m.has(k),
    get: k => {
      if (!m.has(k)) return undefined;
      const v = m.get(k);
      m.delete(k); m.set(k, v);
      return v;
    },
    set: (k, v) => {
      if (m.has(k)) m.delete(k);
      else if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, v);
    },
    delete: k => m.delete(k),
    get size() { return m.size; },
  };
}

// Caches keyed by traffic. Sizes tuned so each cache stays in single-digit
// MB at cap; wiktionary entries (definitions + nested trees + raw wikitext)
// are denser than tooltip HTML, so they get tighter caps.
const summaryCache = lru(1000);           // `${target}|${contextTitle}` -> { title, description, html }
const externalPageCache = lru(1000);      // url -> { title, content, excerpt }
const externalSummaryCache = lru(1000);   // `${url}|${contextTitle}` -> { title, description, html }
const titleResolveCache = lru(2000);      // raw query -> canonical Wikipedia title (or null if no match)
const urlSearchCache = lru(1000);         // raw query -> top URL from OpenRouter `:online` web search (or null)

// ---------- Wikipedia helpers ----------

// Cap concurrent Wikipedia requests to avoid Varnish-edge burst rate-limits.
// Wikimedia REST APIs allow ~200 req/s sustained per IP, but a tooltip whose
// payload contains 8 wikilinks fires 8 parallel HEAD checks via verifyLinks,
// and several tooltips chaining together can put 16–24 HEADs in flight at once
// — that's exactly the burst pattern that triggers 429s. Cap at 4 concurrent;
// extra requests queue. The added latency is negligible (~50–150ms per tooltip
// for typical wikilink counts) and trades for far fewer rate-limit responses.
function makeSemaphore(maxConcurrent) {
  let active = 0;
  const queue = [];
  function release() {
    active--;
    while (queue.length > 0 && active < maxConcurrent) {
      active++;
      const next = queue.shift();
      next();
    }
  }
  return async function acquire(fn) {
    if (active < maxConcurrent) active++;
    else await new Promise(resolve => queue.push(resolve));
    try { return await fn(); }
    finally { release(); }
  };
}
const wikiSem = makeSemaphore(4);

async function wikiFetch(url, opts = {}) {
  return wikiSem(async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const resp = await fetch(url, {
        method: opts.method || 'GET',
        headers: { 'User-Agent': WIKI_USER_AGENT, ...(opts.headers || {}) }
      });
      if (resp.status === 429 && attempt === 0) {
        const retryAfter = parseInt(resp.headers.get('retry-after') || '0', 10);
        const delay = retryAfter > 0 ? Math.min(retryAfter * 1000, 3000) : 400;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (!resp.ok && !opts.allowNonOk) {
        throw new Error(`Wikipedia ${resp.status} for ${url}`);
      }
      return resp;
    }
  });
}

async function fetchWikiSummary(title) {
  const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  const resp = await wikiFetch(url);
  return await resp.json();
}

// Resolve an arbitrary user query ("the egyptian river") to a real Wikipedia
// title via OpenSearch. Returns the top namespace-0 match, or null if nothing
// reasonable came back. Used as the 404 fallback in streamSummary so multi-
// word selections that don't match a title verbatim still land somewhere.
async function searchWikiTitle(query) {
  if (titleResolveCache.has(query)) return titleResolveCache.get(query);
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=opensearch&format=json&limit=1&namespace=0&search=${encodeURIComponent(query)}`;
    const resp = await wikiFetch(url, { allowNonOk: true });
    if (!resp.ok) { titleResolveCache.set(query, null); return null; }
    const data = await resp.json();
    // OpenSearch shape: [query, [titles], [descriptions], [urls]]
    const title = Array.isArray(data) && Array.isArray(data[1]) ? data[1][0] : null;
    titleResolveCache.set(query, title || null);
    return title || null;
  } catch {
    return null;
  }
}

// Last-resort fallback for queries with no Wikipedia article: ask any model
// via OpenRouter's `:online` suffix, which routes the call through OpenRouter's
// Exa-backed web search before generation. The response's url_citation
// annotations expose the source URLs the model grounded against; we take the
// top one and hand off to streamExternalSummary so the tooltip reuses the
// existing fetch/Readability/summarize pipeline. Gated on the openrouter
// client being configured; absent key degrades to the previous "No Wikipedia
// article found" error path. Defaults to Gemini Flash Lite since it's the
// cheapest grounded path for a query that only needs to return one URL.
const OPENROUTER_SEARCH_MODEL = process.env.OPENROUTER_SEARCH_MODEL || 'google/gemini-2.5-flash-lite:online';
async function searchWebUrl(query) {
  if (!openrouter) return null;
  if (urlSearchCache.has(query)) return urlSearchCache.get(query);
  try {
    const resp = await openrouter.chat.completions.create({
      model: OPENROUTER_SEARCH_MODEL,
      max_tokens: 64,
      messages: [{ role: 'user', content: `Most authoritative web page about: ${query}` }]
    });
    const annotations = resp.choices?.[0]?.message?.annotations || [];
    const url = annotations.find(a => a.type === 'url_citation')?.url_citation?.url || null;
    urlSearchCache.set(query, url);
    return url;
  } catch {
    return null;
  }
}

// ---------- Wiktionary (definitions + etymology) ----------
// On-demand fetch only — triggered by the etymology arrow button in tooltips,
// never called as part of normal /summary flow. Cached aggressively since
// dictionary data is stable.
const wiktionaryCache = lru(300);  // word -> { definitions, etymology, ipa, lookedUpFrom }
const WIKT_LANG_MAP = {
  la: 'Latin', grc: 'Ancient Greek', el: 'Greek', fr: 'French', it: 'Italian',
  es: 'Spanish', de: 'German', en: 'English', enm: 'Middle English',
  ang: 'Old English', fro: 'Old French', frm: 'Middle French', pt: 'Portuguese',
  goh: 'Old High German', gmh: 'Middle High German', non: 'Old Norse',
  'gem-pro': 'Proto-Germanic', 'gem': 'Germanic', 'ine-pro': 'Proto-Indo-European',
  'ine': 'Indo-European', 'itc-pro': 'Proto-Italic', 'sla-pro': 'Proto-Slavic',
  'cel-pro': 'Proto-Celtic', 'gmw-pro': 'Proto-West Germanic',
  'gmq': 'North Germanic', 'gmw': 'West Germanic',
  'es-US': 'American Spanish', 'en-US': 'American English',
  'en-GB': 'British English', 'fr-CA': 'Canadian French',
  'ar-and': 'Andalusian Arabic', 'sem-pho': 'Phoenician',
  'pt-BR': 'Brazilian Portuguese', 'osp': 'Old Spanish',
  ar: 'Arabic', he: 'Hebrew', sa: 'Sanskrit', ja: 'Japanese', zh: 'Chinese',
  ru: 'Russian', nl: 'Dutch', sv: 'Swedish', no: 'Norwegian', da: 'Danish',
  is: 'Icelandic', ga: 'Irish', cy: 'Welsh', tr: 'Turkish', fa: 'Persian',
  hi: 'Hindi', ko: 'Korean', vi: 'Vietnamese', th: 'Thai',
  pl: 'Polish', cs: 'Czech', uk: 'Ukrainian', bg: 'Bulgarian',
  ro: 'Romanian', hu: 'Hungarian', fi: 'Finnish', et: 'Estonian',
  odt: 'Old Dutch', dum: 'Middle Dutch', osx: 'Old Saxon',
  gml: 'Middle Low German', nds: 'Low German', sco: 'Scots',
  oco: 'Old Cornish', wlm: 'Middle Welsh', sga: 'Old Irish',
  xno: 'Anglo-Norman', LL: 'Late Latin', VL: 'Vulgar Latin', ML: 'Medieval Latin',
};
function wiktLang(code) {
  if (!code) return '';
  if (WIKT_LANG_MAP[code]) return WIKT_LANG_MAP[code];
  // Heuristic for unmapped "*-pro" codes
  if (code.endsWith('-pro')) return 'Proto-' + (WIKT_LANG_MAP[code.slice(0, -4)] || code.slice(0, -4));
  return code;
}

// Parse a template body like "der|en|la|imperium|t=power" into positional and
// named parameters. Robust to template authors using either form for the gloss
// (positional alt-display or named t=...).
function parseWikiTemplate(body) {
  const parts = body.split('|');
  const name = parts.shift().trim();
  const positional = [];
  const named = {};
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq > 0 && /^[a-zA-Z0-9_-]+$/.test(part.slice(0, eq).trim())) {
      named[part.slice(0, eq).trim()] = part.slice(eq + 1).trim();
    } else {
      positional.push(part.trim());
    }
  }
  return { name, positional, named };
}

// Render a parsed template back to readable text. Returns '' for templates
// we want stripped entirely (labels, qualifiers, references).
function renderWikiTemplate({ name, positional, named }) {
  switch (name) {
    case 'der': case 'inh': case 'bor': case 'bor+': case 'des':
    case 'derived': case 'inherited': case 'borrowed':
    case 'lbor': case 'slbor': case 'obor': case 'cal': case 'calque':
    case 'partial calque': case 'pcal': case 'sl': case 'semantic loan': {
      // Two-language form: {{der|src|tgt|word|alt|gloss}}
      // positional[0]=source lang, positional[1]=target lang, [2]=word, [3]=alt, [4]=gloss
      const lang = wiktLang(positional[1]);
      const word = named.alt || positional[3] || positional[2] || '';
      const gloss = named.t || named.gloss || positional[4] || '';
      if (!word) return lang;
      return gloss ? `${lang} ${word} ('${gloss}')`.trim() : `${lang} ${word}`.trim();
    }
    case 'cog': case 'cognate': {
      // Single-language form: {{cog|lang|word|alt|gloss}}
      const lang = wiktLang(positional[0]);
      const word = named.alt || positional[2] || positional[1] || '';
      const gloss = named.t || named.gloss || positional[3] || '';
      if (!word) return lang;
      return gloss ? `${lang} ${word} ('${gloss}')`.trim() : `${lang} ${word}`.trim();
    }
    case 'm': case 'l': case 'mention': case 'link':
    case 'm+': case 'll': case 'langname-mention': {
      // {{m|lang|word|alt|gloss}} — no language label in output
      const word = named.alt || positional[2] || positional[1] || '';
      const gloss = named.t || named.gloss || positional[3] || '';
      if (!word) return '';
      return gloss ? `${word} ('${gloss}')` : word;
    }
    case 'lang': case 'lang-l': case 'langname':
      return positional[1] || positional[0] || '';
    case 'taxlink': case 'taxfmt': case 'taxon':
    case 'vern': case 'w': case 'wikipedia':
      return named.alt || positional[1] || positional[0] || '';
    case 'suf': case 'suffix':
    case 'pre': case 'prefix':
    case 'compound': case 'com': case 'affix': case 'af': {
      // {{suf|en|cute|ness}} → "cute + -ness"
      const args = positional.slice(1).filter(Boolean);
      if (!args.length) return '';
      if (name === 'pre' || name === 'prefix') return `${args[0]}- + ${args.slice(1).join(' ')}`.trim();
      if (name === 'suf' || name === 'suffix') return `${args[0]} + -${args.slice(1).join(' ')}`.trim();
      return args.join(' + ');
    }
    case 'lb': case 'label': case 'lbl': case 'context': case 'qualifier':
    case 'q': case 'qual': case 'i': case 'italbrac':
    case 'gloss': case 'gl': case 'sense':
    case 'IPAchar': case 'IPAfont':
    case 'rfe': case 'rfdef': case 'rfquotek': case 'rfd-sense':
    case 'attention': case 'attn':
      return '';
    case 'w-link':
      return positional[0] || '';
    default:
      // Unknown / unhandled templates — strip silently
      return '';
  }
}

function stripWikitext(wt) {
  let out = wt;
  // Drop file/image/category links entirely — they're page chrome, not etymology.
  out = out.replace(/\[\[(?:File|Image|Category|Wikipedia|wikipedia|wp):[^\]]*\]\]/gi, '');
  // Iteratively expand templates from innermost outward.
  for (let i = 0; i < 6; i++) {
    const next = out.replace(/\{\{([^{}]+)\}\}/g, (_, body) => renderWikiTemplate(parseWikiTemplate(body)));
    if (next === out) break;
    out = next;
  }
  // Wiki links: [[X|Y|Z]] → Y (use the last pipe-separated piece as display);
  // [[X|Y]] → Y; [[X]] → X.
  out = out
    .replace(/\[\[([^\]]+)\]\]/g, (_, body) => {
      const parts = body.split('|');
      return parts[parts.length - 1];
    })
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/g, '')
    .replace(/<ref[^>]*\/>/g, '')
    .replace(/'''([^']+)'''/g, '$1')
    .replace(/''([^']+)''/g, '$1');
  // Cleanup: any inline `t=value` residue (template gloss param leaking into text)
  out = out.replace(/\bt=([^,;.\)]+)/g, "('$1')");
  // Cleanup: orphan punctuation/connectors left by stripped-empty templates
  out = out
    .replace(/\bof\s+([a-z][a-z-]+)\s*-?\s*origin/g, (_, code) => `of ${wiktLang(code)} origin`)
    .replace(/From\s*,\s*/g, '')               // "From , after X" → "after X"
    .replace(/From\s*\.\s*\.?/g, '')           // "From . ." → ""
    .replace(/From\s+from\s+/gi, 'From ')      // double "from from"
    .replace(/,\s*,/g, ',')
    .replace(/,\s*\./g, '.')
    .replace(/\.\s*\./g, '.')
    .replace(/\(\s*\)/g, '')                   // empty parens
    .replace(/\s+([,.;])/g, '$1')              // " ," / " ." → ","
    .replace(/\s+/g, ' ')
    .replace(/(\s|^)akin to\s*[,.]/gi, '')     // "akin to ." → ""
    .replace(/\s+/g, ' ')
    .trim();
  return out;
}

// Pull the etymology section for a specific language (e.g. "English",
// "Latin", "Ancient Greek"). Returns both the raw wikitext (for template
// inspection — compound detection etc.) and the stripped readable text.
function extractEtymologyForLanguage(wikitext, langName = 'English') {
  const escaped = langName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const langRe = new RegExp(`==\\s*${escaped}\\s*==([\\s\\S]*?)(?=\\n==[^=]|$)`);
  const langMatch = wikitext.match(langRe);
  if (!langMatch) return null;
  const ety = langMatch[1].match(/===\s*Etymology(?:\s*\d*)?\s*===([\s\S]*?)(?=\n===|\n==[^=]|$)/);
  if (!ety) return null;
  return { raw: ety[1], text: stripWikitext(ety[1]) };
}

// Legacy wrapper used elsewhere — English-only, returns just the stripped text.
function extractEtymologySection(wikitext) {
  const r = extractEtymologyForLanguage(wikitext, 'English');
  return r ? r.text : null;
}

// Detect compound/affix etymologies in raw wikitext — when found, the
// word has *multiple* parent nodes (cute + -ness) rather than a linear
// single-parent chain. Returns an array of parent nodes or null.
function parseCompoundParents(rawEty) {
  // {{ety|en|:af|cute|-ness|...}} — modern unified etymology template, affix mode
  // {{ety|en|:com|water|fall|...}} — same template, compound mode
  let m = rawEty.match(/\{\{ety\|en\|:(?:af|com|affix|compound)\|([^|}]+)\|([^|}]+)(?:\|[^}]*)?\}\}/i);
  if (m) return [
    { language: 'English', word: m[1].trim(), gloss: null },
    { language: 'English', word: m[2].trim(), gloss: null }
  ];
  // {{suf|en|cute|ness}} → cute, -ness
  m = rawEty.match(/\{\{suf(?:fix)?\|en\|([^|}]+)\|([^|}]+)(?:\|[^}]*)?\}\}/i);
  if (m) return [
    { language: 'English', word: m[1].trim(), gloss: null },
    { language: 'English', word: '-' + m[2].trim(), gloss: null }
  ];
  // {{prefix|en|un|happy}} → un-, happy
  m = rawEty.match(/\{\{pre(?:fix)?\|en\|([^|}]+)\|([^|}]+)(?:\|[^}]*)?\}\}/i);
  if (m) return [
    { language: 'English', word: m[1].trim() + '-', gloss: null },
    { language: 'English', word: m[2].trim(), gloss: null }
  ];
  // {{compound|en|water|fall}} or {{com|en|water|fall}}
  m = rawEty.match(/\{\{(?:compound|com)\|en\|([^|}]+)\|([^|}]+)(?:\|[^}]*)?\}\}/i);
  if (m) return [
    { language: 'English', word: m[1].trim(), gloss: null },
    { language: 'English', word: m[2].trim(), gloss: null }
  ];
  // {{affix|en|stem|-suf}} — general affix template
  m = rawEty.match(/\{\{(?:affix|af)\|en\|([^|}]+)\|([^|}]+)(?:\|[^}]*)?\}\}/i);
  if (m) return [
    { language: 'English', word: m[1].trim(), gloss: null },
    { language: 'English', word: m[2].trim(), gloss: null }
  ];
  return null;
}

// Raw wikitext cache for ancestor pages — many etymologies share the same
// deep ancestors (Latin imperare, PIE *gʰel-, etc.) so repeated fetches hit
// the cache hard.
const wikitextPageCache = lru(500);  // word -> raw wikitext (10–50KB each — biggest cache by bytes/entry)
async function fetchPageWikitext(word) {
  const key = word.toLowerCase();
  if (wikitextPageCache.has(key)) return wikitextPageCache.get(key);
  let wt = null;
  try {
    const url = `https://en.wiktionary.org/w/api.php?action=parse&format=json&formatversion=2&page=${encodeURIComponent(word)}&prop=wikitext`;
    const resp = await fetch(url, { headers: { 'User-Agent': WIKI_USER_AGENT } });
    if (resp.ok) {
      const data = await resp.json();
      wt = data?.parse?.wikitext || null;
    }
  } catch { /* return null */ }
  wikitextPageCache.set(key, wt);
  return wt;
}

// Recursively build an etymology tree for a node. At each step:
//   1. Fetch the word's wiktionary page.
//   2. Look at the section matching this node's language (== Latin ==,
//      == Ancient Greek ==, etc).
//   3. If the etymology is a compound/affix, branch into multiple parents.
//   4. Otherwise, take the prose chain (multiple ancestors on this one page)
//      and recurse on the DEEPEST one to extend further back.
//
// `visited` tracks (lang, word) pairs to short-circuit cycles. `maxDepth`
// limits how many recursion levels (= how many additional fetches) we do
// beyond what the initial prose chain already gave us.
async function buildEtymTree(node, depth, maxDepth, visited) {
  const lang = node.language || 'English';
  const key = `${lang.toLowerCase()}:${node.word.toLowerCase()}`;
  if (depth >= maxDepth || visited.has(key)) {
    return { ...node, children: [] };
  }
  visited.add(key);

  const wt = await fetchPageWikitext(node.word);
  if (!wt) return { ...node, children: [] };

  const ety = extractEtymologyForLanguage(wt, lang);
  if (!ety) return { ...node, children: [] };

  // Branch on compound
  const compound = parseCompoundParents(ety.raw);
  if (compound) {
    const children = await Promise.all(
      compound.map(p => buildEtymTree(p, depth + 1, maxDepth, visited))
    );
    return { ...node, children };
  }

  // Linear chain at this level
  const chain = parseEtymologyChain(ety.text);
  if (chain.length === 0) return { ...node, children: [] };

  // The prose chain at this page already gives us multiple ancestors —
  // nest them linearly (deepest at the leaf), then recurse on the deepest
  // to extend beyond what this page tells us.
  const deepestRecursed = await buildEtymTree(chain[chain.length - 1], depth + 1, maxDepth, visited);
  // Walk from the deepest back to build the nested chain
  let leaf = deepestRecursed;
  for (let i = chain.length - 2; i >= 0; i--) {
    leaf = { ...chain[i], children: [leaf] };
  }
  return { ...node, children: [leaf] };
}

// Pull the first IPA pronunciation out of the English Pronunciation section.
// Format: {{IPA|en|/kjuːt/|...}} — first slot is the canonical transcription.
function extractIPA(wikitext) {
  const en = wikitext.match(/==\s*English\s*==([\s\S]*?)(?=\n==[^=]|$)/);
  if (!en) return null;
  const m = en[1].match(/\{\{IPA\|en\|([^|}]+)/i);
  return m ? m[1].trim() : null;
}

// Detect when a word is morphologically derived from a simpler root and we
// should show the root's entry instead. Two signals:
//   1. Wiktionary {{suf}}/{{prefix}} templates in the raw etymology wikitext
//      ({{suf|en|cute|ness}} → root "cute"; {{prefix|en|un|happy}} → "happy").
//   2. Inflection-of definitions ("Present participle of fish" → "fish").
// Returns the root word, or null if no clean redirect signal.
function detectRootForm(rawWikitext, definitions) {
  const en = rawWikitext.match(/==\s*English\s*==([\s\S]*?)(?=\n==[^=]|$)/);
  if (en) {
    const ety = en[1].match(/===\s*Etymology(?:\s*\d*)?\s*===([\s\S]*?)(?=\n===|\n==[^=]|$)/);
    if (ety) {
      const sufMatch = ety[1].match(/\{\{suf\|en\|([^|}]+)\|/i);
      if (sufMatch) return sufMatch[1].trim();
      const prefixMatch = ety[1].match(/\{\{prefix\|en\|[^|}]+\|([^|}]+)/i);
      if (prefixMatch) return prefixMatch[1].trim();
    }
  }
  if (definitions && definitions.length) {
    const inflectionRe = /(?:plural|singular|present participle|past participle|past tense|gerund|comparative|superlative|inflection|diminutive)\s+of\s+([\p{L}'’-]+)/iu;
    let base = null;
    let allMatched = true;
    for (const sec of definitions) {
      for (const def of sec.defs) {
        const m = def.match(inflectionRe);
        if (!m) { allMatched = false; break; }
        const cand = m[1].toLowerCase();
        if (base && base !== cand) { allMatched = false; break; }
        base = cand;
      }
      if (!allMatched) break;
    }
    if (allMatched && base) return base;
  }
  return null;
}

// Best-effort parse: split on linking phrases ("from X", "alteration of X",
// "itself from X", etc.) into a flat chain. Words can be in any script
// (Latin, Greek, Arabic, Cyrillic, CJK) — \p{L}+\p{M} covers letters plus
// combining diacritics that appear in scripts like Arabic and Devanagari.
function parseEtymologyChain(text) {
  if (!text) return [];
  const chain = [];
  const re = /(?:\b[Ff]rom\s+|\b[Aa]lterations?\s+of\s+|\b[Mm]odifications?\s+of\s+|\b[Bb]orrowings?\s+of\s+|\b[Cc]lippings?\s+of\s+|\b[Ss]hortenings?\s+of\s+|\bitself\s+from\s+|\bultimately\s+from\s+|\b[Vv]ia\s+|\b[Tt]hrough\s+|\b[Aa]phetic\s+form\s+of\s+|\b[Cc]lipped\s+form\s+of\s+|\b[Vv]ariants?\s+of\s+|\b[Dd]iminutives?\s+of\s+|\b[Aa]bbreviations?\s+of\s+|\b[Cc]ontractions?\s+of\s+)([A-Z][a-zA-Z]+(?:[-\s][A-Z][a-zA-Z]+)*)?\s*([\p{L}\p{M}*'’-]+(?:\s+[\p{L}\p{M}*'’-]+)*?)\s*(?:\(['"]?([^'")]+?)['"]?\))?(?=[,.;]|\s+(?:from|itself|ultimately|alteration|via|through|form|variant)\b|\s+\+|$)/gu;
  let m;
  while ((m = re.exec(text)) !== null) {
    const word = (m[2] || '').trim();
    if (!word) continue;
    chain.push({ language: (m[1] || '').trim() || null, word, gloss: m[3]?.trim() || null });
    if (chain.length >= 10) break;
  }
  return chain;
}

async function fetchWiktionary(term, depth = 0) {
  const key = term.toLowerCase();
  if (depth === 0 && wiktionaryCache.has(key)) return wiktionaryCache.get(key);

  const candidates = depth === 0 ? [key, term] : [key];
  let payload = null;

  for (const word of candidates) {
    try {
      const defUrl = `https://en.wiktionary.org/api/rest_v1/page/definition/${encodeURIComponent(word)}`;
      const defResp = await fetch(defUrl, { headers: { 'User-Agent': WIKI_USER_AGENT } });
      if (!defResp.ok) continue;
      const defData = await defResp.json();
      const english = defData.en || defData[Object.keys(defData).find(k => defData[k]?.length) || ''];
      if (!english || !english.length) continue;

      const definitions = english.slice(0, 3).map(section => ({
        partOfSpeech: section.partOfSpeech || '',
        defs: (section.definitions || []).slice(0, 2)
          .map(d => String(d.definition || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 240))
          .filter(Boolean),
      })).filter(s => s.defs.length > 0);

      if (!definitions.length) continue;

      // Fetch wikitext for etymology + root-form detection + tree building.
      let etymology = null;
      let ipa = null;
      let rawWikitext = await fetchPageWikitext(word) || '';
      if (rawWikitext) {
        const ety = extractEtymologyForLanguage(rawWikitext, 'English');
        if (ety) {
          // Build a recursive tree by following the deepest ancestor through
          // its own Wiktionary page. maxDepth=5 gives ~10–12 levels for words
          // with deep chains (salmon, tuna, etc.) which approaches what
          // dedicated etymology graph DBs (etymology-explorer.com) show. Cold-
          // cache cost is ~5 Wiktionary fetches per click; warm cache hits
          // dominate at scale since common ancestors (Latin imperare, PIE
          // *gʰel-, etc.) repeat across many words.
          const tree = await buildEtymTree(
            { language: 'English', word, gloss: null },
            0, 5, new Set()
          );
          etymology = {
            text: ety.text,
            chain: parseEtymologyChain(ety.text),
            tree: tree.children.length ? tree : null,
          };
        }
        ipa = extractIPA(rawWikitext);
      }

      // Lemmatization: "fishing" → "fish" (inflection), "cuteness" → "cute"
      // (suffix derivation). Follow the redirect up to 2 levels deep.
      if (depth < 2) {
        const root = detectRootForm(rawWikitext, definitions);
        if (root && root.toLowerCase() !== word.toLowerCase()) {
          const rootData = await fetchWiktionary(root, depth + 1);
          if (rootData) {
            payload = { ...rootData, lookedUpFrom: term };
            break;
          }
        }
      }

      payload = { word, definitions, etymology, ipa };
      break;
    } catch { /* try next candidate */ }
  }

  if (depth === 0) wiktionaryCache.set(key, payload);
  return payload;
}

// ---------- Summary generation (Claude) ----------

const SYSTEM_PROMPT = `You are a Wikipedia editor writing a short, context-aware summary of the linked text, complete with hyperlinked words. Output only the summary HTML, no preamble.`;

// Maps the language codes the popup sends to human-readable names that
// go into the prompt directive. 'auto' (or any unknown code) returns
// null — the prompt stays unmodified and the model picks language from
// source content / its default.
const LANGUAGE_NAMES = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', pl: 'Polish', ru: 'Russian', tr: 'Turkish',
  ar: 'Arabic', hi: 'Hindi', ja: 'Japanese', ko: 'Korean',
  'zh-CN': 'Simplified Chinese', 'zh-TW': 'Traditional Chinese',
};

// Builds the language directive appended to the system prompt. Wikilink
// tag attributes (t="...", u="...") MUST stay as the canonical English
// identifiers — they're used by verifyLinks to confirm Wikipedia articles
// exist. Phrased with explicit do/don't lists + an example because the
// terse v1 directive was being interpreted too aggressively by some
// model paths (translating t="..." values, breaking the verify step,
// resulting in stripped links).
function languageDirective(lang) {
  const name = LANGUAGE_NAMES[lang];
  if (!name) return '';
  return `\n\n=== LANGUAGE ===
Write all user-facing text in ${name}.

TRANSLATE:
- The body prose
- The <h3> title text
- The visible text INSIDE <w>…</w> and <e>…</e> tags

DO NOT TRANSLATE OR MODIFY:
- The t="…" attribute of <w> tags — must always be the exact English Wikipedia article title (these are identifiers, not user-facing text, and are used to verify the link points to a real article)
- The u="…" attribute of <e> tags — must always be the original URL exactly

Example (output in Spanish): <w t="Mona Lisa">la Mona Lisa</w>
- Visible text "la Mona Lisa" is translated to Spanish ✓
- t="Mona Lisa" stays in English ✓

If you cannot identify a confident English Wikipedia title for a concept, omit the link rather than guess a translated title.`;
}
function withLang(systemPrompt, lang) {
  return systemPrompt + languageDirective(lang);
}

function buildPrompt(target, targetLead, context) {
  const hasContext = !!(context?.title && context.title.toLowerCase() !== target.toLowerCase());
  const dontLink = [target];
  if (hasContext) dontLink.push(context.title);

  const lead = (context?.lead || '').trim();

  const intro = hasContext
    ? `The reader is currently reading "${context.title}":\n\n${lead || '(content unavailable)'}\n\nThey've hovered a link to "${target}".`
    : `The reader has hovered a link to "${target}".`;

  const direction = hasContext
    ? `Structure: the first sentence identifies "${target}" plainly — who, what, when, where, the load-bearing facts the reader needs to know. The next sentence makes the connection to what the reader is currently engaged with, framing why "${target}" matters in this specific context.`
    : `Summarize "${target}" clearly and accurately, focusing on what a curious reader most wants to know.`;

  return `${intro}

Here is the lead section of "${target}":

${targetLead}

Your job: write a 2 sentence, single paragraph summary of "${target}" that gives the reader exactly what they want to know. Hard cap: ≤70 words total across all sentences.

${direction}

Wrap as many wikilinks as the summary warrants — be LIBERAL. Aim for at least 5–8, more if the summary touches multiple notable entities. Anything that has its own Wikipedia article should become a wikilink.

Wrap them as <w t="Exact Wikipedia Title">…</w>. STRICT rules:

- The t value must be the Wikipedia article for the SPECIFIC concept named by the linked phrase, not a parent topic, era, or related concept.
- Examples of correct t selection:
  • Link text "his concept of imperium" → t "Imperium" (NOT "Roman Empire")
  • Link text "the printing press" → t "Printing press" (NOT "Johannes Gutenberg")
- Use exact Wikipedia article titles in t, including capitalization. The displayed text can differ in casing/wording; the t value must be the canonical title.
- Do NOT link any of: ${dontLink.map(t => `"${t}"`).join(', ')}.
- Tags must have only the t attribute — no class, no href, no id.

Output ONLY the summary HTML — no preamble, no markdown, no surrounding tags.`;
}

function ensureWikilinkClass(html) {
  // If Claude omitted the class, add it. Idempotent — does nothing if class is already present.
  return html.replace(/<a\s+data-term=/gi, '<a class="wikilink" data-term=');
}

// Defensive fallback: some models (notably Qwen3 on Together) occasionally
// emit plain <a href> markup instead of the prompted <w t> / <e u> shorthand.
// Convert based on href shape so the link still renders as a hoverable
// wikilink/extlink with the right class. Skips anchors that already carry a
// wikilink/extlink class or a data-term/data-url attribute (those are handled
// by expandShortLinks / ensureWikilinkClass and shouldn't be touched).
function normalizeRawAnchors(html) {
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (match, attrs, text) => {
    if (/\bclass=["'][^"']*\b(wikilink|extlink)\b/i.test(attrs)) return match;
    if (/\bdata-term=/i.test(attrs) || /\bdata-url=/i.test(attrs)) return match;
    const hrefMatch = attrs.match(/\bhref=["']([^"']+)["']/i);
    if (!hrefMatch) return text; // bare <a> with no href — keep text only
    const href = hrefMatch[1];
    const wikiMatch = href.match(/(?:^|\/\/)(?:[a-z]{2,3}\.)?wikipedia\.org\/wiki\/([^?#]+)/i);
    if (wikiMatch) {
      const term = decodeURIComponent(wikiMatch[1]).replace(/_/g, ' ').replace(/"/g, '&quot;');
      return `<a class="wikilink" data-term="${term}">${text}</a>`;
    }
    if (/^https?:\/\//i.test(href)) {
      const safeUrl = href.replace(/"/g, '&quot;');
      return `<a class="extlink" data-url="${safeUrl}">${text}</a>`;
    }
    return text; // relative / non-http href — strip to plain text
  });
}

// stop_sequences: ['</p>'] cuts the stream BEFORE the closing tag is
// emitted, saving the trailing-token padding Haiku occasionally adds
// after the paragraph body. Restore the close-tag for clean HTML.
function closeStrippedParagraph(html) {
  if (html.includes('<p>') && !html.endsWith('</p>')) return html + '</p>';
  return html;
}

// The prompts instruct Claude to emit shorthand <w t="…">…</w> and
// <e u="…">…</e> instead of full <a class="wikilink"|"extlink"> markup —
// each anchor saves ~5 output tokens, which adds up at 8–12 links per
// tooltip. We expand to canonical anchors here before the rest of the
// pipeline (ensureWikilinkClass, verifyLinks, addAnchorHrefs) runs.
function expandShortLinks(html) {
  let out = html.replace(
    /<w\s+t="([^"]+)"\s*>([\s\S]*?)<\/w>/gi,
    (_, term, text) => `<a class="wikilink" data-term="${term}">${text}</a>`
  );
  out = out.replace(
    /<e\s+u="([^"]+)"\s*>([\s\S]*?)<\/e>/gi,
    (_, url, text) => `<a class="extlink" data-url="${url}">${text}</a>`
  );
  return out;
}

function wikiUrl(term) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(term.replace(/ /g, '_'))}`;
}

// Adds sensible href attributes to wikilink/extlink anchors so the engine emits
// real hyperlinks. Adopters who haven't wired their own click handler get native
// click behavior — clicking a wikilink in a tooltip navigates to Wikipedia,
// clicking an extlink follows the URL. Hosts that intercept (like the demo's
// renderArticle) still preventDefault before native nav fires.
// If the LM led with an <h3>...</h3>, return its text and the html with that
// element stripped — used by the art demo so Claude's identified painting title
// shows up as the tooltip header instead of being duplicated in the body.
function extractLeadingTitle(html) {
  const m = html.match(/^\s*<h3[^>]*>([\s\S]*?)<\/h3>\s*/i);
  if (!m) return { title: null, html };
  const title = m[1].replace(/<[^>]+>/g, '').trim();
  if (!title) return { title: null, html };
  return { title, html: html.slice(m[0].length).trimStart() };
}

function addAnchorHrefs(html) {
  // Wrap in a known container before parsing — linkedom's parseHTML puts a
  // bare fragment at documentElement, leaving document.body empty. The wrapper
  // gives us a deterministic root to read innerHTML back from.
  const { document } = parseHTML(`<div id="_pt_root_">${html}</div>`);
  for (const a of document.querySelectorAll('a.wikilink')) {
    if (a.getAttribute('href')) continue;
    const term = a.getAttribute('data-term');
    if (term) a.setAttribute('href', wikiUrl(term));
  }
  for (const a of document.querySelectorAll('a.extlink')) {
    if (a.getAttribute('href')) continue;
    const url = a.getAttribute('data-url');
    if (url) a.setAttribute('href', url);
  }
  return document.getElementById('_pt_root_').innerHTML;
}

// Final-HTML sanitizer — the last step before tooltip HTML goes over the
// wire. The model's output is restricted by prompt, but prompts aren't a
// security boundary: a hostile page fed through the external-summary path
// can steer the model into emitting event-handler attributes or unexpected
// tags. The extension re-sanitizes with DOMPurify (same allowlist), but the
// demo client and any future embedder assign this HTML to innerHTML
// directly, so the server must never ship executable markup.
//   - Tags outside the allowlist are unwrapped (children kept) so stray
//     <div>/<section> wrappers degrade gracefully...
//   - ...except script-ish containers, which are dropped with their content.
//   - Attributes outside the allowlist (all on* handlers included) are
//     stripped; href/data-url must be http(s)/mailto.
const SANITIZE_ALLOWED_TAGS = new Set(['A', 'EM', 'STRONG', 'I', 'B', 'P', 'BR', 'H3', 'UL', 'OL', 'LI', 'SPAN']);
const SANITIZE_ALLOWED_ATTRS = new Set(['class', 'href', 'data-term', 'data-url', 'title']);
const SANITIZE_DROP_WITH_CONTENT = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'TEMPLATE', 'NOSCRIPT', 'TITLE', 'HEAD']);
function sanitizeFinalHtml(html) {
  const { document } = parseHTML(`<div id="_pt_root_">${html}</div>`);
  const root = document.getElementById('_pt_root_');
  // Snapshot before mutating — unwraps/removals reshape the tree underfoot.
  for (const el of [...root.querySelectorAll('*')]) {
    if (!root.contains(el)) continue; // removed along with a dropped ancestor
    const tag = el.tagName.toUpperCase();
    if (SANITIZE_DROP_WITH_CONTENT.has(tag)) { el.remove(); continue; }
    if (!SANITIZE_ALLOWED_TAGS.has(tag)) {
      el.replaceWith(...el.childNodes); // unwrap: keep text + child elements
      continue;
    }
    for (const attr of [...el.attributes]) {
      const name = String(attr.name || '').toLowerCase();
      if (!SANITIZE_ALLOWED_ATTRS.has(name)) {
        el.removeAttribute(attr.name);
        continue;
      }
      if ((name === 'href' || name === 'data-url') && !/^(?:https?:|mailto:)/i.test(String(attr.value).trim())) {
        el.removeAttribute(attr.name);
      }
    }
  }
  return root.innerHTML;
}

// A tooltip must never link back to itself — "Apple" linking the word
// "apple" to Apple spawns a recursive child that regenerates the same
// summary (the child's context differs, so it misses the cache and burns
// tokens on a duplicate). The prompts already say don't (dontLink), but
// models disobey often enough that we unwrap self-references
// deterministically: any anchor whose data-term matches one of the
// tooltip's own titles, or whose data-url points at the page being
// summarized, collapses to plain text.
function stripSelfLinks(html, { titles = [], url } = {}) {
  const normTitles = new Set(titles.filter(Boolean).map(t => String(t).trim().toLowerCase()));
  const normUrl = (url || '').replace(/\/+$/, '').toLowerCase();
  if (normTitles.size === 0 && !normUrl) return html;
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi, (match, attrs, text) => {
    const term = attrs.match(/\bdata-term="([^"]*)"/i)?.[1];
    if (term && normTitles.has(term.trim().toLowerCase())) return text;
    const target = attrs.match(/\bdata-url="([^"]*)"/i)?.[1];
    if (normUrl && target && target.replace(/\/+$/, '').toLowerCase() === normUrl) return text;
    return match;
  });
}

function extractAnchors(html) {
  const anchors = [];
  const re = /<a([^>]*?)>([^<]*)<\/a>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1];
    const tm = attrs.match(/data-term="([^"]+)"/i);
    if (tm) anchors.push({ fullMatch: m[0], attrs, term: tm[1], text: m[2] });
  }
  return anchors;
}

const linkExistsCache = lru(5000); // term -> boolean (tiny entries, very hot — biggest cap)
async function verifyTermExists(term) {
  if (linkExistsCache.has(term)) return linkExistsCache.get(term);
  try {
    const url = `https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(term.replace(/ /g, '_'))}`;
    const resp = await wikiFetch(url, { method: 'HEAD', allowNonOk: true });
    if (resp.status === 429) {
      // Even after one retry we got 429 — trust Claude rather than strip what's
      // probably a real link. Don't cache; let a future request try again.
      return true;
    }
    const ok = resp.ok;
    linkExistsCache.set(term, ok);
    return ok;
  } catch {
    // Network error — same logic. Don't poison the cache; trust Claude this round.
    return true;
  }
}

async function verifyLinks(html) {
  const anchors = extractAnchors(html);
  if (anchors.length === 0) return html;
  const results = await Promise.all(anchors.map(async (a) => ({
    ...a, valid: await verifyTermExists(a.term)
  })));
  let processed = html;
  for (const a of results) {
    if (!a.valid) processed = processed.split(a.fullMatch).join(a.text);
  }
  return processed;
}

function sseWrite(res, payload) {
  // No-op after the response is closed. Guards against the streamSummary →
  // streamExternalSummary handoff: the outer try/finally still fires after
  // the handoff completes and would otherwise try to sseWrite('[DONE]') on
  // an already-ended response, emitting ERR_STREAM_WRITE_AFTER_END as an
  // unhandled 'error' event and crashing the process.
  if (res.writableEnded || res.destroyed) return;
  if (payload === '[DONE]') res.write('data: [DONE]\n\n');
  else res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

// ---------- External page summaries ----------

const EXTERNAL_FETCH_TIMEOUT_MS = 5000;

// Hosts where Readability extraction reliably fails because content is auth-walled,
// JS-rendered, or bot-blocked at the edge. Surfaced to the runtime with a
// recognizable "Unsupported source: <host>" message so the UI can show a
// host-specific note instead of a generic "Couldn't read this page".
// Twitter/X are NOT here — they're handled by the syndication fast-path in
// fetchAndExtract. Instagram pages are login-walled SPAs with no server-
// rendered content and no public API, so a fetch only ever yields a generic
// login wall; declining with a clear message beats a wrong or empty summary.
// (Image hovers on Instagram still work via the cdninstagram.com proxy.)
const UNSUPPORTED_HOSTS = new Set([
  'instagram.com',
]);

function checkSupportedHost(url) {
  let u;
  try { u = new URL(url); } catch { return; }
  const host = u.hostname.replace(/^www\./, '').toLowerCase();
  if (UNSUPPORTED_HOSTS.has(host)) {
    throw new Error(`Unsupported source: ${host}`);
  }
}
const EXTERNAL_CONTENT_CHAR_CAP = 2000;

// Returns true if the given IP literal is private, loopback, link-local,
// multicast, broadcast, or otherwise non-routable. Used both for hostnames
// that are IP literals and for the IPs we resolve via DNS.
function isPrivateIp(addr) {
  if (!addr) return true;
  const fam = net.isIP(addr);
  if (fam === 4) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 10 || a === 127 || a === 0 || a >= 224) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
    return false;
  }
  if (fam === 6) {
    const v = addr.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80:') || v.startsWith('fc') || v.startsWith('fd')) return true;
    // IPv4-mapped IPv6 (::ffff:a.b.c.d) — extract the v4 portion and recurse.
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

// Validate a user-provided URL. Two layers of SSRF defense:
//   1. Literal-hostname checks (block IP literals in private ranges, localhost,
//      .local etc.) — cheap and catches naive attacks before any DNS lookup.
//   2. DNS resolution + IP re-check — defeats DNS rebinding where the literal
//      hostname is benign (evil.com) but resolves to a private/internal IP.
// There's still a small race window between our resolution and the fetch's
// own resolution; closing that fully would require pinning the fetch to the
// resolved IP via a custom undici Agent. Acceptable trade-off for now.
async function validateExternalUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error('Invalid URL'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http(s) URLs allowed');
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.localhost')) {
    throw new Error('Cannot fetch local hosts');
  }

  // Strip IPv6 brackets if present before checking literal form.
  const rawHost = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (net.isIP(rawHost)) {
    if (isPrivateIp(rawHost)) throw new Error('Cannot fetch private IPs');
  } else {
    // Resolve the hostname and verify every returned address is public. dns.lookup
    // with all:true gives us every A/AAAA record so an attacker can't slip a
    // private IP through alongside a public one.
    let addrs;
    try {
      addrs = await dns.lookup(rawHost, { all: true, verbatim: true });
    } catch (err) {
      if (err.code === 'ENOTFOUND' || err.code === 'EAI_AGAIN') {
        throw new Error("Couldn't find this site.");
      }
      throw new Error("Couldn't resolve this host.");
    }
    for (const { address } of addrs) {
      if (isPrivateIp(address)) throw new Error('Cannot fetch private IPs');
    }
  }

  return u.toString();
}

// Some image CDNs aggressively block datacenter IPs / non-browser TLS
// fingerprints regardless of headers (Reddit's i.redd.it 307s us to a
// /media viewer page from Render, no header tweak gets past it). Route
// those through images.weserv.nl — a free public image proxy that fetches
// from a residential-feeling network and returns the bytes cleanly cached
// at Cloudflare. Returns the URL to actually fetch, or null to use original.
function proxyImageUrlIfNeeded(host) {
  const h = host.toLowerCase().replace(/^www\./, '');
  // Reddit image hosts: 307'd to /media viewer for datacenter IPs.
  // Meta image CDNs (cdninstagram.com, fbcdn.net): aggressively block hot-
  // linking. Both wildcard subdomains since each region uses a different
  // shard like scontent-iad3-1.cdninstagram.com.
  const proxy = h === 'i.redd.it'
    || h === 'preview.redd.it'
    || h === 'external-preview.redd.it'
    || h.endsWith('.cdninstagram.com')
    || h === 'cdninstagram.com'
    || h.endsWith('.fbcdn.net')
    || h === 'fbcdn.net';
  if (proxy) {
    // weserv accepts the URL with or without the https:// prefix
    return (origUrl) => `https://images.weserv.nl/?url=${encodeURIComponent(origUrl.replace(/^https?:\/\//, ''))}&n=-1`;
  }
  return null;
}

// Opaque shorteners that return an HTML interstitial (not an HTTP redirect).
// t.co is the headline case: HTTP/2 200 with a body containing
//   <meta http-equiv="refresh" content="0;URL=...">
//   <script>location.replace("...")</script>
// — neither of which fetch's redirect:'follow' will follow. We detect those
// hosts after the fetch and recurse on the extracted destination.
const SHORTENER_HOSTS = new Set(['t.co']);

// YouTube fast-path: skip the giant SSR HTML fetch and pull title + author
// from the oEmbed endpoint instead. The HTML's og:description is contaminated
// with text from recommended-but-unrelated videos (a "Me at the zoo" page
// has an og:description about microplastics from another channel) so it's
// actively misleading; oEmbed gives clean canonical data in ~500 bytes.
function isYouTubeVideoUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const h = u.hostname.toLowerCase();
  if (h === 'youtu.be') return true;
  if (h === 'youtube.com' || h === 'www.youtube.com' || h === 'm.youtube.com') {
    return /^\/(watch|shorts|embed|live|v)(\/|\?|$)/.test(u.pathname);
  }
  return false;
}

async function fetchYouTubeOEmbed(url) {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`;
  const resp = await fetch(oembedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' },
    signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS)
  }).catch(() => null);
  if (!resp || !resp.ok) return null;
  try { return await resp.json(); } catch { return null; }
}

// Normalize any reddit post URL to its .json equivalent at www.reddit.com.
// Reddit's JSON read API works without auth, returns structured post +
// comment data, and is far less aggressive about bot-blocking than the
// HTML page — which silently serves a captcha interstitial to datacenter
// IPs much of the time. Old.reddit.com URLs also work after host
// normalization to www.reddit.com.
function redditJsonUrl(safeUrl) {
  try {
    const u = new URL(safeUrl);
    u.hostname = 'www.reddit.com';
    u.search = '';
    u.hash = '';
    if (!u.pathname.endsWith('/')) u.pathname += '/';
    u.pathname += '.json';
    return u.toString();
  } catch { return null; }
}

// Fetches a reddit post via the JSON read API and reshapes it into the
// {title, content, excerpt} payload the summary prompt expects. Returns
// null on any failure so the caller can fall through to the HTML path.
async function fetchRedditPostJson(safeUrl) {
  const jsonUrl = redditJsonUrl(safeUrl);
  if (!jsonUrl) return null;
  let data;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
    const resp = await fetch(jsonUrl, {
      headers: { 'User-Agent': WIKI_USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    data = await resp.json();
  } catch { return null; }

  // Reddit's JSON envelope: [post_listing, comments_listing]. Each listing
  // is { data: { children: [...] } }. Comment permalinks return the same
  // shape with the focused post still in data[0].
  if (!Array.isArray(data) || !data[0]?.data?.children?.length) return null;
  const postNode = data[0].data.children[0];
  if (postNode.kind !== 't3') return null;
  const p = postNode.data;

  const title = (p.title || '').trim();
  if (!title) return null;
  const subreddit = p.subreddit_name_prefixed || (p.subreddit ? `r/${p.subreddit}` : '');
  const author = p.author && p.author !== '[deleted]' ? `u/${p.author}` : '';
  const body = (p.selftext || '').replace(/\s+/g, ' ').trim();

  const header = [title, subreddit, author].filter(Boolean).join(' — ');
  const sections = [header];
  if (body) sections.push(`\n\nPost body:\n${body.slice(0, 3000)}`);

  const commentNodes = (data[1]?.data?.children || []).filter(c => c.kind === 't1');
  for (const c of commentNodes.slice(0, 6)) {
    const cAuthor = c.data.author && c.data.author !== '[deleted]' ? `u/${c.data.author}` : 'anon';
    const cBody = (c.data.body || '').replace(/\s+/g, ' ').trim();
    if (cBody.length < 30) continue;
    sections.push(`${cAuthor}: ${cBody.slice(0, 600)}`);
  }

  return {
    title: title.slice(0, 200),
    content: sections.join(' ').slice(0, EXTERNAL_CONTENT_CHAR_CAP),
    excerpt: (body.slice(0, 200) || (commentNodes[0]?.data?.body || '').slice(0, 200))
  };
}

// Reddit post URL detector. Matches /r/<sub>/comments/<id>/<slug?> on
// any reddit.com host (www, old, sh, m, np, etc.). Used to gate the
// Reddit-specific HTML extractor below.
function isRedditPostUrl(url) {
  let u;
  try { u = new URL(url); } catch { return false; }
  const h = u.hostname.toLowerCase();
  if (h !== 'reddit.com' && h !== 'www.reddit.com' && !h.endsWith('.reddit.com')) return false;
  return /^\/(?:r\/[^/]+\/)?comments\//.test(u.pathname);
}

// Reddit-specific HTML scrape. Reddit SSRs the post + first batch of
// comments inside <shreddit-post> / <shreddit-comment> custom elements
// (with canonical metadata on attributes) before the client hydrates.
// Readability misses most of this because the visible body is mostly
// engagement-bar chrome; the og:description is often empty for video /
// link / gallery posts. So we read the SSR payload directly.
//
// Brittle to Reddit markup changes — same brittleness as the YouTube
// PREFER_OG_HOSTS branch — but no API call, no auth, no rate limits.
function extractRedditPostFromHtml(doc, safeUrl) {
  // URL-derived baseline: subreddit name + slug fall out of the path. Even
  // if Reddit returned a fully client-rendered shell (no shreddit-post in
  // SSR, sparse meta tags), we still surface "this is a Reddit post in
  // r/<sub> about <slug>" instead of bouncing to "couldn't read this page".
  let subFromUrl = '', slugFromUrl = '';
  try {
    const path = new URL(safeUrl).pathname;
    const m = path.match(/^\/r\/([^/]+)\/comments\/[^/]+(?:\/([^/]+))?/);
    if (m) {
      subFromUrl = `r/${m[1]}`;
      if (m[2]) slugFromUrl = m[2].replace(/[-_]+/g, ' ').trim();
    }
  } catch { /* path parse — ignore */ }

  const og = (prop) => doc.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute('content') || '';

  // Bail on Reddit's bot-block interstitial. Reddit serves a "please wait
  // for verification" page to datacenter IPs occasionally; it parses fine
  // but the og:title is dead-obvious and we don't want it cached as if it
  // were the post. Throw rather than return null so no extractor downstream
  // serves the captcha shell as a summary either.
  const titleProbe = (og('og:title') || doc.title || '').toLowerCase();
  if (/please wait for verification|verify you are human|just a moment|access denied/.test(titleProbe)) {
    throw new Error('Reddit blocked this fetch (bot-detection). Try again in a moment.');
  }

  const post = doc.querySelector('shreddit-post');
  let title = '', subreddit = subFromUrl, author = '', score = '';
  let commentCount = '', postType = '', body = '';
  const comments = [];

  if (post) {
    title = (post.getAttribute('post-title') || '').trim();
    subreddit = post.getAttribute('subreddit-prefixed-name')
      || (post.getAttribute('subreddit-name') ? `r/${post.getAttribute('subreddit-name')}` : subFromUrl);
    author = post.getAttribute('author') ? `u/${post.getAttribute('author')}` : '';
    score = post.getAttribute('score') || '';
    commentCount = post.getAttribute('comment-count') || '';
    postType = post.getAttribute('post-type') || '';

    // Text-post body (selftext) lives in a slot; gallery / link / video
    // posts omit this. Selector covers both shadow-slot projection and the
    // raw markdown container some pages use.
    const bodyEl = post.querySelector('[slot="text-body"], .post-rtjson-content, .md');
    body = (bodyEl?.textContent || '').replace(/\s+/g, ' ').trim();

    // Top SSR'd comments. shreddit-comment elements carry author + score
    // attributes; their textContent includes the rendered body. Top-level
    // only — depth="0" filter strips nested replies.
    for (const c of doc.querySelectorAll('shreddit-comment')) {
      if (comments.length >= 8) break;
      if ((c.getAttribute('depth') || '0') !== '0') continue;
      const cAuthor = c.getAttribute('author') ? `u/${c.getAttribute('author')}` : 'u/anon';
      const cScore = c.getAttribute('score') || '';
      const cText = (c.textContent || '').replace(/\s+/g, ' ').trim();
      if (cText.length < 10) continue;
      const tag = cScore ? `${cAuthor} (${cScore} pts)` : cAuthor;
      comments.push(`${tag}: ${cText.slice(0, 600)}`);
    }
  }

  // Fallback chain for title: og:title (Reddit formats it as
  // "Post Title : r/Subreddit") → <title> → URL slug. Strip the trailing
  // " : r/Sub" / " | r/Sub" suffix Reddit appends.
  if (!title) {
    const ogTitle = og('og:title') || doc.title || '';
    title = ogTitle.replace(/\s*[:|]\s*r\/\w+\s*$/i, '').trim();
  }
  if (!title && slugFromUrl) title = slugFromUrl;
  if (!title) return null;

  // Fallback for body: og:description. Reddit usually writes a short
  // synopsis here even for video / link posts.
  if (!body) body = (og('og:description') || og('description') || '').trim();

  const headline = [
    `Reddit post in ${subreddit || 'unknown subreddit'}`,
    author ? `by ${author}` : '',
    `titled "${title}".`,
    postType && postType !== 'text' ? `(${postType} post)` : '',
    score ? `Score: ${score}.` : '',
    commentCount ? `Comments: ${commentCount}.` : ''
  ].filter(Boolean).join(' ');

  const sections = [headline];
  if (body) sections.push(`\n\nPost body:\n${body.slice(0, 3000)}`);
  if (comments.length > 0) sections.push(`\n\nTop comments:\n${comments.join('\n\n')}`);

  return {
    title: title.slice(0, 200),
    content: sections.join(' ').slice(0, EXTERNAL_CONTENT_CHAR_CAP),
    excerpt: body.slice(0, 200) || (comments[0] || '').slice(0, 200)
  };
}

function extractShortenerDestination(html) {
  if (!html) return null;
  // Prefer <meta http-equiv="refresh"> — the URL is unescaped there.
  let m = html.match(/<meta[^>]+http-equiv=["']?refresh["']?[^>]+content=["']?\d+;\s*url=([^"'\s>]+)/i);
  if (m) return m[1];
  // Fall back to JS location.replace("..."). Strip the JS escaping on slashes.
  m = html.match(/location\.replace\(["']([^"']+)["']\)/i);
  if (m) return m[1].replace(/\\\//g, '/');
  return null;
}

// Fetch a user-controlled URL following redirects MANUALLY, re-running
// validateExternalUrl on every hop. With redirect:'follow' the validation
// only covers the first URL — a public site can 302 to
// http://169.254.169.254/... or an internal service and fetch would happily
// follow it, handing internal content to the summarizer (SSRF). Capped hop
// count; the caller's AbortSignal spans all hops so the total time budget
// is unchanged.
const REDIRECT_HOP_CAP = 5;
async function fetchExternalValidated(startUrl, fetchOpts) {
  let current = startUrl;
  for (let hop = 0; hop <= REDIRECT_HOP_CAP; hop++) {
    const resp = await fetch(current, { ...fetchOpts, redirect: 'manual' });
    if (![301, 302, 303, 307, 308].includes(resp.status)) return resp;
    const loc = resp.headers.get('location');
    if (!loc) return resp; // 3xx with no Location — let the caller see it
    try { await resp.body?.cancel(); } catch { /* redirect bodies are noise */ }
    let next;
    try { next = new URL(loc, current).toString(); } catch {
      throw new Error('Page redirected to an invalid URL');
    }
    current = await validateExternalUrl(next);
  }
  throw new Error('Page redirected too many times');
}

// ----- Twitter / X structured fetch -----
// x.com and twitter.com serve a JS shell with no readable content to a
// server-side fetch — Readability and OG both come up empty, which is why
// these used to be declined outright. The syndication endpoint
// (cdn.syndication.twimg.com) is Twitter's own embed backend: it returns
// full tweet JSON (text, author, quoted tweet, media alt-text) with no auth.
// Same shape as the Reddit JSON / YouTube oEmbed fast-paths.
function tweetIdFrom(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const h = u.hostname.replace(/^www\./, '').toLowerCase();
  if (!/(^|\.)(twitter|x)\.com$/.test(h)) return null;
  const m = u.pathname.match(/\/status(?:es)?\/(\d+)/);
  return m ? m[1] : null;
}
// Token the syndication endpoint expects — the same lossy derivation
// react-tweet uses. Validation is loose (a constant works too), but
// deriving it matches the official embed client and is cheap insurance.
function tweetSyndToken(id) {
  return ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '') || '0';
}
async function fetchTweet(url) {
  const id = tweetIdFrom(url);
  if (!id) return null;
  const endpoint = `https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${tweetSyndToken(id)}&lang=en`;
  let data;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
    const resp = await fetch(endpoint, {
      headers: { 'User-Agent': WIKI_USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    // A deleted/protected/nonexistent tweet returns an HTML error page
    // instead of JSON — bail so we don't try to parse it.
    if (!/json/i.test(resp.headers.get('content-type') || '')) return null;
    data = await resp.json();
  } catch { return null; }
  if (!data || data.__typename !== 'Tweet' || !data.text) return null;

  const name = (data.user?.name || '').trim();
  const handle = data.user?.screen_name ? `@${data.user.screen_name}` : '';
  const byline = [name, handle].filter(Boolean).join(' ');
  const text = data.text.replace(/\s+/g, ' ').trim();

  let quoted = '';
  if (data.quoted_tweet?.text) {
    const qBy = [data.quoted_tweet.user?.name, data.quoted_tweet.user?.screen_name && `@${data.quoted_tweet.user.screen_name}`]
      .filter(Boolean).join(' ');
    quoted = `\n\nQuoting ${qBy || 'another post'}: "${data.quoted_tweet.text.replace(/\s+/g, ' ').trim()}"`;
  }
  // Alt-text / accessibility labels on attached media give vision-grade
  // detail without a vision call.
  const media = (data.mediaDetails || data.photos || [])
    .map(m => (m.ext_alt_text || m.accessibilityLabel || '').trim())
    .filter(Boolean);
  const mediaNote = media.length ? `\n\nAttached media: ${media.join('; ')}` : '';

  const header = byline ? `Post on X by ${byline}` : 'Post on X';
  const content = `${header}:\n\n"${text}"${quoted}${mediaNote}`.slice(0, EXTERNAL_CONTENT_CHAR_CAP);
  return {
    title: (byline || 'Post on X').slice(0, 200),
    content,
    excerpt: text.slice(0, 200),
  };
}

// X profile fast-path. Profile pages (x.com/<handle>) are a JS shell with
// no JSON-LD or readable content, but FixTweet's public API (the service
// behind Discord's fixed embeds) returns the display name, bio, location,
// and counts unauthenticated. Third-party dependency — on any failure we
// return null and fall through to the generic fetch, which produces the
// usual graceful "couldn't read this page" rather than a wrong answer.
const X_RESERVED_PATHS = new Set([
  'home', 'explore', 'search', 'notifications', 'messages', 'settings',
  'i', 'intent', 'share', 'hashtag', 'login', 'signup', 'logout', 'tos',
  'privacy', 'about', 'download', 'jobs', 'compose',
]);
function xProfileHandleFrom(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  const h = u.hostname.replace(/^www\./, '').toLowerCase();
  if (!/(^|\.)(twitter|x)\.com$/.test(h)) return null;
  // Exactly one path segment = a profile. Deeper paths (statuses, lists,
  // /media tabs) are someone else's problem — statuses never reach here
  // anyway because the tweet fast-path runs first.
  const segs = u.pathname.split('/').filter(Boolean);
  if (segs.length !== 1) return null;
  const handle = segs[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(handle)) return null;
  if (X_RESERVED_PATHS.has(handle.toLowerCase())) return null;
  return handle;
}

async function fetchXProfile(url) {
  const handle = xProfileHandleFrom(url);
  if (!handle) return null;
  let data;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
    const resp = await fetch(`https://api.fxtwitter.com/${encodeURIComponent(handle)}`, {
      headers: { 'User-Agent': WIKI_USER_AGENT, 'Accept': 'application/json' },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    if (!/json/i.test(resp.headers.get('content-type') || '')) return null;
    data = await resp.json();
  } catch { return null; }
  const user = data?.user;
  if (data?.code !== 200 || !user?.screen_name) return null;

  const name = (user.name || '').trim();
  const byline = [name, `@${user.screen_name}`].filter(Boolean).join(' ');
  const bio = (user.description || '').replace(/\s+/g, ' ').trim();
  const num = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : null);
  const joinedYear = user.joined ? new Date(user.joined).getFullYear() : null;
  const facts = [
    user.location && `Location: ${user.location}`,
    user.website?.url && `Website: ${user.website.display_url || user.website.url}`,
    num(user.followers) && `Followers: ${num(user.followers)}`,
    num(user.tweets) && `Posts: ${num(user.tweets)}`,
    joinedYear && `Joined: ${joinedYear}`,
  ].filter(Boolean).join('. ');

  const content = [
    `X (Twitter) profile of ${byline}.`,
    bio && `Bio: "${bio}"`,
    facts,
  ].filter(Boolean).join('\n\n').slice(0, EXTERNAL_CONTENT_CHAR_CAP);
  return {
    title: byline.slice(0, 200),
    content,
    excerpt: bio.slice(0, 200),
  };
}

// ----- Schema.org JSON-LD extraction -----
// A large share of the modern web (news, blogs, products, recipes, videos,
// scholarly pages) embeds <script type="application/ld+json"> with a clean
// headline + description + body that survives the SPA shells and bot walls
// that defeat Readability. This is the single widest-coverage fallback we
// have, so it sits between Readability and the bare-meta fallback.
function jsonLdValue(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  if (Array.isArray(v)) return v.map(jsonLdValue).filter(Boolean).join(', ');
  if (typeof v === 'object') return jsonLdValue(v.name || v['@value'] || '');
  return String(v);
}
function extractJsonLd(doc) {
  const blocks = doc.querySelectorAll('script[type="application/ld+json"]');
  if (!blocks.length) return null;
  // Flatten every node across all blocks, unwrapping @graph containers and
  // top-level arrays.
  const nodes = [];
  for (const b of blocks) {
    let parsed;
    try { parsed = JSON.parse(b.textContent); } catch { continue; }
    for (const item of (Array.isArray(parsed) ? parsed : [parsed])) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item['@graph'])) nodes.push(...item['@graph']);
      else nodes.push(item);
    }
  }
  const PREFERRED = /Article|NewsArticle|BlogPosting|Report|VideoObject|Product|Recipe|Book|Movie|Event|Question|TechArticle|ScholarlyArticle|WebPage/i;
  // Prefer a content-bearing node of a known type; fall back to any node
  // that carries a headline/description.
  let best = null, bestPreferred = false;
  for (const n of nodes) {
    if (!n || typeof n !== 'object') continue;
    if (!(n.headline || n.name || n.description || n.articleBody)) continue;
    const types = [].concat(n['@type'] || []).map(String);
    const preferred = types.some(t => PREFERRED.test(t));
    if (!best || (preferred && !bestPreferred)) { best = n; bestPreferred = preferred; }
    if (preferred) break;
  }
  if (!best) return null;

  const title = jsonLdValue(best.headline || best.name).trim();
  const body = jsonLdValue(best.articleBody).trim();
  const desc = jsonLdValue(best.description).trim();
  const author = jsonLdValue(best.author).trim();
  if (!title && !body && !desc) return null;
  const content = [title, author && `By ${author}`, body || desc]
    .filter(Boolean).join('. ').replace(/\s+/g, ' ').trim().slice(0, EXTERNAL_CONTENT_CHAR_CAP);
  return {
    title: (title || '').slice(0, 200),
    content,
    excerpt: (desc || body).slice(0, 200),
  };
}

async function fetchAndExtract(url, opts = {}) {
  if (externalPageCache.has(url)) return externalPageCache.get(url);

  const safeUrl = await validateExternalUrl(url);

  // YouTube fast-path: oEmbed gives clean canonical title + author for any
  // /watch, /shorts, /embed, /live, or youtu.be URL — much better signal
  // than scraping the SSR HTML's contaminated og:description, AND it skips
  // the multi-MB watch-page download entirely.
  if (isYouTubeVideoUrl(safeUrl)) {
    const yt = await fetchYouTubeOEmbed(safeUrl);
    if (yt && yt.title) {
      const author = (yt.author_name || '').trim();
      const result = {
        title: yt.title.trim(),
        content: author ? `Video: "${yt.title.trim()}" by ${author}` : `Video: "${yt.title.trim()}"`,
        excerpt: author ? `by ${author}` : ''
      };
      externalPageCache.set(url, result);
      return result;
    }
    // Fall through to the regular fetch on oEmbed failure (rare — 404 for
    // private/removed videos, etc.). The tooltip still gets *something*.
  }

  // Reddit fast-path: use the JSON read API instead of the HTML page.
  // Reddit's HTML gets bot-blocked on a meaningful fraction of
  // server-side fetches (datacenter IPs catch the captcha interstitial),
  // but the .json endpoint is their canonical read API and accepts
  // any-host reddit URLs (old.reddit.com, www.reddit.com, np.reddit.com,
  // etc.) after host normalization. Falls through to the HTML path on
  // any JSON failure.
  if (isRedditPostUrl(safeUrl)) {
    const reddit = await fetchRedditPostJson(safeUrl);
    if (reddit) {
      externalPageCache.set(url, reddit);
      return reddit;
    }
  }

  // Twitter / X fast-path: the syndication endpoint returns full tweet JSON
  // without auth. x.com's own HTML is an empty JS shell, so there's no point
  // falling through to a normal fetch — if syndication fails (deleted /
  // protected tweet) we let it drop to the generic path, which will produce
  // a graceful "couldn't read" rather than a wrong summary.
  if (tweetIdFrom(safeUrl)) {
    const tweet = await fetchTweet(safeUrl);
    if (tweet) {
      externalPageCache.set(url, tweet);
      return tweet;
    }
  }

  // X profile fast-path — same rationale as tweets: the profile page HTML
  // is an empty shell, so FixTweet's API is the only readable source.
  if (xProfileHandleFrom(safeUrl)) {
    const profile = await fetchXProfile(safeUrl);
    if (profile) {
      externalPageCache.set(url, profile);
      return profile;
    }
  }

  // Browser-shaped User-Agent for arbitrary outbound fetches. The previous
  // "Mozilla/5.0 (compatible; portaltext-prototype/0.1)" got fingerprinted
  // as a bot by some CDNs. Wiki/Wikisource fetches still use the attributed
  // bot UA via wikiFetch — that path wants identification for rate-limit
  // accounting; arbitrary fetches need to blend in.
  // For hosts known to block our datacenter origin entirely (Reddit's
  // i.redd.it), route through an image proxy. The cache key + downstream
  // metadata still use the original URL.
  const safeHost = new URL(safeUrl).hostname;
  const proxify = proxyImageUrlIfNeeded(safeHost);
  const fetchUrl = proxify ? proxify(safeUrl) : safeUrl;

  const resp = await fetchExternalValidated(fetchUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    signal: AbortSignal.timeout(EXTERNAL_FETCH_TIMEOUT_MS)
  }).catch(err => {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') {
      throw new Error('Page took too long to respond');
    }
    // Re-throw validation errors ("Cannot fetch private IPs" etc.) verbatim
    // so the redirect-hop rejection reads the same as a first-URL rejection.
    if (/^(Cannot fetch|Only http|Invalid URL|Page redirected|Couldn't)/.test(err.message)) throw err;
    throw new Error(`Could not fetch page: ${err.message}`);
  });

  if (!resp.ok) throw new Error(`Page returned ${resp.status}`);
  const ct = resp.headers.get('content-type') || '';

  // Read the body once into a buffer so we can probe it both ways without
  // re-fetching. Some CDNs return image bytes with a non-image content-type
  // (or vice versa for HTML error pages on image URLs) — content-type alone
  // isn't reliable, we have to look at the bytes.
  const rawBuf = Buffer.from(await resp.arrayBuffer());

  // Opaque-shortener resolution: if the host is t.co (or similar), parse the
  // HTML interstitial for its real destination and recurse. opts.skipShortener
  // prevents infinite recursion if a destination ever ends up being another
  // shortener (extremely rare, but cheap to guard against).
  const reqHost = new URL(safeUrl).hostname.toLowerCase();
  if (!opts.skipShortener && SHORTENER_HOSTS.has(reqHost)) {
    const dest = extractShortenerDestination(rawBuf.toString('utf8'));
    if (dest && dest !== safeUrl) {
      const result = await fetchAndExtract(dest, { skipShortener: true });
      // Cache the result under the original shortened URL too so the next
      // hover on the same t.co/... can short-circuit without re-resolving.
      externalPageCache.set(url, result);
      return result;
    }
  }

  // Image path: hand bytes to Claude via the vision API instead of running
  // Readability. Triggered when (a) content-type is image/*, or (b) the URL
  // pathname hints image and sharp can actually decode the bytes. Large
  // images get downscaled before send — both to stay under Anthropic's
  // per-image size limit and because Claude vision auto-scales anything past
  // 1568px on the long edge anyway.
  const ctIsImage = /^image\/(jpeg|png|gif|webp)/i.test(ct);
  const urlLooksImage = /\.(jpe?g|png|gif|webp)(\?|#|$)/i.test(new URL(safeUrl).pathname);
  if (ctIsImage || urlLooksImage) {
    try {
      const meta = await sharp(rawBuf).metadata();
      if (meta.format && ['jpeg', 'png', 'gif', 'webp'].includes(meta.format)) {
        const { buf, mediaType } = await shrinkImageForVision(rawBuf, `image/${meta.format}`);
        const result = {
          isImage: true,
          mediaType,
          base64: buf.toString('base64'),
          title: new URL(safeUrl).hostname,
          excerpt: ''
        };
        externalPageCache.set(url, result);
        return result;
      }
    } catch {
      // sharp couldn't decode — the URL hinted image but the bytes weren't.
      // Probably an HTML error/captcha page from the CDN. Fall through to
      // HTML extraction below if the content-type allows it.
    }
  }

  // PDF path: hand bytes to Claude via the document content block. Native
  // PDF support on Claude 3.5+ models means we don't need to extract text
  // ourselves — the model reads the document directly (text + figures +
  // layout). Triggered when content-type is application/pdf OR the URL
  // pathname ends in .pdf and the bytes look like PDF (%PDF magic).
  // Cap at 10 MB — Anthropic accepts up to 32 MB but bandwidth + token
  // cost grows linearly with PDF size, and most useful documents are well
  // under 10 MB. Refusing oversize PDFs gives a clean error.
  const ctIsPdf = /^application\/pdf/i.test(ct);
  const urlLooksPdf = /\.pdf(\?|#|$)/i.test(new URL(safeUrl).pathname);
  const bytesLookPdf = rawBuf.length >= 4 && rawBuf.slice(0, 4).toString('utf8') === '%PDF';
  if (ctIsPdf || (urlLooksPdf && bytesLookPdf)) {
    if (rawBuf.length > PDF_MAX_BYTES) {
      throw new Error(`PDF too large to summarize (${(rawBuf.length / 1024 / 1024).toFixed(1)} MB; cap is ${PDF_MAX_BYTES / 1024 / 1024} MB)`);
    }
    if (!bytesLookPdf) {
      // Server says PDF but bytes don't start with %PDF magic — probably
      // an HTML error page served with wrong content-type. Fall through.
    } else {
      // Fallback title is just the filename (Claude usually overrides via
      // an <h3> in the response, which extractLeadingTitle picks up).
      let pdfTitle;
      try {
        const fn = decodeURIComponent(new URL(safeUrl).pathname.split('/').pop()) || '';
        pdfTitle = fn.replace(/\.pdf$/i, '') || new URL(safeUrl).hostname;
      } catch {
        pdfTitle = new URL(safeUrl).hostname;
      }
      const result = {
        isPdf: true,
        mediaType: 'application/pdf',
        base64: rawBuf.toString('base64'),
        title: pdfTitle,
        excerpt: ''
      };
      externalPageCache.set(url, result);
      return result;
    }
  }

  if (!/^text\/html|application\/xhtml/i.test(ct)) {
    throw new Error(`Cannot summarize content type "${ct.split(';')[0]}"`);
  }

  const html = rawBuf.toString('utf8');
  const dom = new JSDOM(html, { url: safeUrl });
  const doc = dom.window.document;

  const og = (prop) => doc.querySelector(`meta[property="${prop}"], meta[name="${prop}"]`)?.getAttribute('content') || '';

  // Reddit fast-path: SSR'd <shreddit-post> + <shreddit-comment> carry the
  // post title, subreddit, author, body, and top comments — everything we
  // need for a useful summary, including for video / link / gallery posts
  // where Readability comes up empty and og:description is bare. Skipped
  // and falls through to Readability if the markup ever changes shape and
  // the extractor returns null.
  if (isRedditPostUrl(safeUrl)) {
    const reddit = extractRedditPostFromHtml(doc, safeUrl);
    if (reddit) {
      externalPageCache.set(url, reddit);
      return reddit;
    }
  }

  // Hosts where the SSR'd OG meta tags carry the actual page identity but
  // Readability extracts garbage from the SPA shell. Skip Readability and
  // go straight to og:title + og:description for these.
  const PREFER_OG_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be']);
  if (PREFER_OG_HOSTS.has(reqHost)) {
    const ogTitle = og('og:title') || doc.title || '';
    const ogDesc = og('og:description') || og('description') || '';
    if (ogTitle || ogDesc) {
      const result = {
        title: ogTitle.trim() || new URL(safeUrl).hostname,
        content: ogDesc.trim() || ogTitle.trim(),
        excerpt: ogDesc.trim()
      };
      externalPageCache.set(url, result);
      return result;
    }
  }

  // Tier 1 — Readability. Best for genuine articles (full body text).
  try {
    const reader = new Readability(doc.cloneNode(true));
    const article = reader.parse();
    if (article && article.textContent && article.textContent.trim().length > 200) {
      const result = {
        title: (article.title || og('og:title') || doc.title || safeUrl).trim(),
        content: article.textContent.replace(/\s+/g, ' ').trim().slice(0, EXTERNAL_CONTENT_CHAR_CAP),
        excerpt: (article.excerpt || og('og:description') || '').trim()
      };
      externalPageCache.set(url, result);
      return result;
    }
  } catch { /* fall through */ }

  // Tier 2 — Schema.org JSON-LD. Survives SPA shells and bot walls that
  // Readability can't read; covers news, products, recipes, videos, etc.
  const ld = extractJsonLd(doc);
  if (ld && (ld.content || ld.title)) {
    externalPageCache.set(url, ld);
    return ld;
  }

  // Tier 3 — universal bare-meta fallback. Almost anything that returned
  // HTML has at least a <title> and usually an og/twitter description or a
  // first paragraph. Assemble whatever's there rather than declining.
  const metaTitle = (og('og:title') || og('twitter:title') || doc.title || '').trim();
  const metaDesc = (og('og:description') || og('twitter:description') || og('description') || '').trim();
  let firstPara = '';
  for (const p of doc.querySelectorAll('article p, main p, [role="main"] p, p')) {
    const t = (p.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length >= 80) { firstPara = t; break; }
  }
  if (metaTitle || metaDesc || firstPara) {
    const content = [metaTitle, metaDesc, firstPara]
      .filter(Boolean).join('. ').replace(/\s+/g, ' ').trim().slice(0, EXTERNAL_CONTENT_CHAR_CAP);
    const result = {
      title: (metaTitle || new URL(safeUrl).hostname).slice(0, 200),
      content: content || metaTitle,
      excerpt: (metaDesc || firstPara).slice(0, 200),
    };
    externalPageCache.set(url, result);
    return result;
  }

  throw new Error('Could not extract readable content from this page');
}

// Pulls (text, url) pairs from in-content anchors that match a host filter.
// Used by reference-doc destinations (rustdoc) so the summary prompt can list
// real, available cross-references for Claude to wrap as extlinks — gives the
// reader a recursive path through the docs themselves rather than always
// pivoting out to Wikipedia.
function extractCrossRefs(doc, baseUrl, hostMatch, limit = 25) {
  const refs = new Map(); // url -> text (dedupe by url; prefer first occurrence)
  for (const a of doc.querySelectorAll('a[href]')) {
    if (refs.size >= limit) break;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#')) continue;
    let abs;
    try { abs = new URL(href, baseUrl).toString(); } catch { continue; }
    if (abs === baseUrl) continue; // skip self-references
    if (!hostMatch(abs)) continue;
    const text = a.textContent.replace(/\s+/g, ' ').trim();
    if (!text || text.length > 80 || text.length < 2) continue;
    if (!refs.has(abs)) refs.set(abs, text);
  }
  return Array.from(refs.entries()).map(([url, text]) => ({ text, url }));
}

const IMAGE_SYSTEM_PROMPT = `You are a Wikipedia editor writing a short, context-aware summary of the given image, complete with hyperlinked words. Output only the summary HTML, no preamble.`;

function buildImagePrompt(context, linkPage) {
  const hasContext = !!(context?.title);
  const lead = (context?.lead || '').trim();
  const intro = hasContext
    ? `The reader is currently on "${context.title}":\n\n${lead || '(content unavailable)'}\n\nThey've hovered an image.`
    : `The reader has hovered an image.`;

  // When the image is wrapped in a link to an external source page (Pinterest
  // pins, gallery thumbnails linking to the source blog, Flickr photo pages
  // with full title/EXIF/tags, etc.), the linked page's content is
  // SUPPLEMENTAL context only. The image itself is the primary subject —
  // describe what's visually IN the picture. Use the linked page only to
  // resolve specific identification questions (species name, location,
  // artist) that vision alone can't pin down. Reduced cap (1500 chars vs
  // earlier 3000) so the page text can't drown out vision in the prompt.
  const linkBlock = linkPage
    ? `\n\nThe image is linked from a source page titled "${linkPage.title || '(untitled)'}". Some text from that page (use as supplemental ONLY — your primary job is describing the image visually):\n\n${(linkPage.content || '').slice(0, 600)}\n\n`
    : '';

  return `${intro}${linkBlock}

Skip framings like "An Instagram post showing…" or "On Pinterest, this pin features…" and just describe what's IN the image.

Output format:
<h3>Subject name</h3>
<p>Two sentences (single paragraph) on what this specific thing is and what's most interesting about it. Lead with the load-bearing fact a curious reader would want first; don't pad with clichés. Don't repeat the subject name verbatim in the body — the header already has it.</p>

Translation: if the image contains visible text in a language other than English, include a brief English translation as part of the description. Quote the original (transliterate where it helps) and gloss it in one short clause per piece of text, not a full transcription.

Wrap as many wikilinks as the summary warrants — be LIBERAL. Aim for at least 5–8, more if the summary touches multiple notable entities. Anything that has its own Wikipedia article should become a wikilink.

Wrap them as <w t="Exact Wikipedia Title">…</w>. STRICT rules:
- The phrase you wrap must LITERALLY name the article subject. Direct names, proper nouns, technical terms, and standard alternate spellings are allowed.
- Use the exact canonical Wikipedia article title in t, including disambiguation suffix when needed.
- Tags must have only the t attribute — no class, no href, no id.

Output ONLY the HTML — no preamble, no markdown, no surrounding tags.`;
}

const PDF_SYSTEM_PROMPT = `You write hover tooltips for someone who's hovered a PDF link on the web. The PDF is provided directly — read it natively (text, figures, layout). Output is rendered as the tooltip body — output only the summary HTML, no preamble, no markdown.`;

function buildPdfPrompt(url, context) {
  const hasContext = !!(context?.title);
  const lead = (context?.lead || '').trim();
  const filename = (() => {
    try { return decodeURIComponent(new URL(url).pathname.split('/').pop()) || 'document.pdf'; }
    catch { return 'document.pdf'; }
  })();
  const intro = hasContext
    ? `The reader is currently on "${context.title}":\n\n${lead || '(content unavailable)'}\n\nThey've hovered a link to a PDF (${filename}).`
    : `The reader has hovered a link to a PDF (${filename}).`;

  return `${intro}

Read the PDF. Identify what kind of document it is (academic paper, technical spec, government report, manual, slide deck, court filing, marketing whitepaper, etc.) and write a short summary.

Output format, when the PDF has a clear identifiable subject (paper title, named report, etc.):

<h3>Document title — author / publisher (year if known)</h3>
<p>Two sentences (single paragraph) on what the document is and what's most useful to know about it. Lead with the load-bearing fact a curious reader would want first — the central finding, the scope, the period covered, the methodology, what makes it distinctive. If the page the reader is on connects in a non-obvious way, tie it in briefly; otherwise stay focused on the document itself. Don't restate the title verbatim in the body.</p>

Output format, when no clear title or subject is identifiable (a generic form, a screenshot-PDF, a partial document):

<p>Describe what the PDF actually contains in 2 concrete sentences — document type, scope, what it shows. Be specific and observational, not vague.</p>

Don't waste sentences explaining what a PDF is or what platform hosts it. Skip framings like "This PDF document discusses…" — just say what the document IS and what's in it.

Wikilinks: wrap proper nouns (real authors, institutions, people, places, organizations, named theories or methods, named events, products) and complex named concepts (formal terms, named techniques, dynasties, historical periods) as <w t="Exact Wikipedia Title">…</w>. Be AGGRESSIVE — aim for 8–12 wikilinks. If you write a sentence with zero links, you're under-linking; go back and find named entities or formal concepts in it. Treat every named entity and every formal/technical concept as a candidate. STRICT rules:
- The phrase you wrap must LITERALLY name the article subject. Direct names, proper nouns, technical terms only. No thematic mappings ("loss" → "Grief" is wrong).
- Use the exact canonical Wikipedia article title in t, including disambiguation suffix when needed.
- Tags must have only the t attribute — no class, no href, no id.

Output ONLY the HTML — no preamble, no markdown, no surrounding tags.`;
}

function buildExternalPrompt(url, page, context) {
  const hasContext = !!(context?.title);
  const lead = (context?.lead || '').trim();

  const intro = hasContext
    ? `The reader is currently reading "${context.title}":\n\n${lead || '(content unavailable)'}\n\nThey've hovered an outbound link to ${url}.`
    : `The reader has hovered an outbound link to ${url}.`;

  const direction = hasContext
    ? `Structure: the first sentence identifies this page plainly — what it is, who made it, what it argues or covers. The next one or two sentences make the connection to what the reader is currently engaged with, framing why it matters in this specific context. Don't open with the connection at the expense of identification, and don't just paraphrase the page text and stop there. Both, in that order.`
    : `Summarize this page clearly and accurately, focusing on what a curious reader most wants to know.`;

  const crossRefsBlock = (page.crossRefs && page.crossRefs.length > 0)
    ? `

Available cross-references from this same site — if your summary mentions any of these, wrap them as <e u="EXACT_URL">…</e> using the URL verbatim. This lets the reader recurse through the documentation itself instead of always pivoting out to Wikipedia.

${page.crossRefs.map(r => `- "${r.text}" → ${r.url}`).join('\n')}`
    : '';

  return `${intro}

Title of the linked page: "${page.title}"

Here is the readable content extracted from the page (may be truncated):

${page.content}${crossRefsBlock}

Your job: write a 2 sentence, single paragraph Wikipedia style summary of this page. Hard cap: ≤70 words total across all sentences.

Treat the host site as invisible scaffolding and describe its underlying content directly.

Metacommentary is banned, for example:
- Naming the structure: "thread", "post", "discussion", etc
- Naming the platform: "On Reddit…", "A tweet by…", "GitHub repository for…"
- Verbs that describe the page acting on the reader: "shows", "showcases", "displays"
- Phrases like "the original post", "the OP", "users discuss"

${direction}

Wrap as many anchors as you can fit — be AGGRESSIVE. Aim for 8–12 minimum, Wikipedia level density and selection. Two kinds, used together:
- <e u="EXACT_URL">…</e> — for items linked from this same site (use URLs from the cross-references list above when applicable, verbatim).
- <w t="Exact Wikipedia Title">…</w> — for proper nouns (people, places, organizations, named works, events) and complex concepts (theories, technologies, algorithms, formal terms) that have Wikipedia articles.

Match the SPECIFIC concept named by the linked phrase (e.g., "the printing press" → "Printing press", not "Johannes Gutenberg"). Tags must have only the specified attribute — no class, no href, no id.

${hasContext ? `Do NOT link "${context.title}" — the reader is already there.` : ''}

Output ONLY the summary HTML — no preamble, no markdown, no surrounding tags.`;
}

async function streamExternalSummary(url, context, res, opts = {}) {
  const { linkUrl, modelKey, prefetched, tester, abortToken, lang, skipHeaders } = opts; // tester: authenticated user id (or null) for usage logging; abortToken: shared flag set when Claude is invoked (gates the early-abort refund in the handler); lang: user's preferred output language ('en','es',...; 'auto' if unset); skipHeaders: caller already wrote SSE headers (used when streamSummary hands off mid-stream after its own writeHead).
  if (!skipHeaders) {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no'
    });
  }

  // Cache flow: skip BOTH read and write when content came from a client-
  // side credentialed fetch. The prefetched body is the user's logged-in
  // view of the page (NYT etc.) — we don't want a stale anonymous teaser-
  // summary to win the cache hit, and we don't want to write authenticated
  // content into a cache other users might hit. Paying for fresh inference
  // each hover is acceptable since paywall hosts are rare.
  const cacheKey = `${url}|${linkUrl || ''}|${context?.title || ''}|${modelKey || DEFAULT_MODEL_KEY}|${lang || ''}`;
  if (!prefetched && externalSummaryCache.has(cacheKey)) {
    // Cache hit — send only the final so the client snaps instead of typewritering
    const cached = externalSummaryCache.get(cacheKey);
    sseWrite(res, { type: 'final', ...cached });
    sseWrite(res, '[DONE]');
    res.end();
    return;
  }

  // PDF surcharge bookkeeping for the catch block: if we charged a
  // surcharge but the model errored before streaming anything, give the
  // surcharge back (the gate's 1 credit stays consumed, matching the
  // pre-existing error contract for plain summaries).
  let pdfSurcharge = 0;
  let sentDelta = false;
  try {
    checkSupportedHost(url);
    // Image+link case: fetch the linked page in parallel with the image so
    // Claude sees both. If the link fetch fails (unsupported host, bot block,
    // 404), we silently degrade to image-only — the image alone is still useful.
    const linkFetch = linkUrl ? fetchAndExtract(linkUrl).catch(() => null) : Promise.resolve(null);
    // When prefetched is provided, skip our own fetch — we couldn't have
    // gotten past the paywall anyway. Build a minimal page object that
    // matches the shape fetchAndExtract returns for the HTML branch.
    const pageFetch = prefetched && prefetched.content
      ? Promise.resolve({
          title: String(prefetched.title || '').slice(0, 300),
          content: String(prefetched.content).slice(0, EXTERNAL_CONTENT_CHAR_CAP),
          excerpt: String(prefetched.excerpt || '').slice(0, 500)
        })
      : fetchAndExtract(url);
    const [page, linkPage] = await Promise.all([pageFetch, linkFetch]);

    // Client may have disconnected during the fetch phase — the handler's
    // close listener already refunded the gate credits, so bail before
    // charging any PDF surcharge or starting a paid model call.
    if (abortToken?.closed) return;

    // PDFs are the one surface where a single request can cost orders of
    // magnitude more than a tooltip (document blocks tokenize per page), so
    // they carry a size-scaled credit surcharge on top of the 1 credit the
    // gate already took, and non-funded tiers get byte + per-day caps.
    if (page.isPdf) {
      const pdfBytes = Math.floor((page.base64?.length || 0) * 0.75);
      if (!opts.user) {
        // Anonymous demo has no credit balance to charge against.
        sseWrite(res, {
          type: 'error',
          message: 'PDF previews need the portaltext extension installed.',
          reason: 'auth_required',
        });
        sseWrite(res, '[DONE]');
        res.end();
        return;
      }
      if (!opts.isPaid) {
        // Roll the day first so yesterday's counter doesn't gate today.
        refillUserQuota(opts.user);
        if (pdfBytes > FREE_PDF_MAX_BYTES) {
          sseWrite(res, {
            type: 'error',
            message: `This PDF is ${(pdfBytes / 1024 / 1024).toFixed(1)} MB — the free tier covers PDFs up to ${FREE_PDF_MAX_BYTES / 1024 / 1024} MB.`,
            reason: 'pdf_too_large',
          });
          sseWrite(res, '[DONE]');
          res.end();
          return;
        }
        if ((opts.user.pdf_daily_used || 0) >= FREE_PDF_DAILY_CAP) {
          sseWrite(res, {
            type: 'error',
            message: `You've used today's ${FREE_PDF_DAILY_CAP} PDF previews. More tomorrow!`,
            reason: 'pdf_quota_exceeded',
          });
          sseWrite(res, '[DONE]');
          res.end();
          return;
        }
      }
      const surcharge = pdfCreditCost(pdfBytes) - CREDIT_COSTS.summary;
      const charged = consumeQuota(opts.user, surcharge);
      if (!charged.ok) {
        sseWrite(res, {
          type: 'error',
          message: `Not enough credits left today for this PDF (needs ${surcharge + CREDIT_COSTS.summary}). Credits refill tomorrow.`,
          reason: 'quota_exceeded',
        });
        sseWrite(res, '[DONE]');
        res.end();
        return;
      }
      pdfSurcharge = surcharge;
      notePdfUse(opts.user);
    }

    // Three branches based on what the URL turned out to be:
    //   - image → vision API with image content block
    //   - PDF   → document content block (Claude reads the PDF natively)
    //   - HTML  → text-only with the page content embedded in the prompt
    // All three converge on the same SSE delta/final shape so the runtime
    // doesn't care which path ran.
    let messages, systemPrompt;
    if (page.isImage) {
      systemPrompt = withLang(IMAGE_SYSTEM_PROMPT, lang);
      const usableLinkPage = linkPage && !linkPage.isImage && !linkPage.isPdf ? linkPage : null;
      messages = [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: page.mediaType, data: page.base64 } },
          { type: 'text', text: buildImagePrompt(context, usableLinkPage) }
        ]
      }];
    } else if (page.isPdf) {
      systemPrompt = withLang(PDF_SYSTEM_PROMPT, lang);
      messages = [{
        role: 'user',
        content: [
          { type: 'document', source: { type: 'base64', media_type: page.mediaType, data: page.base64 } },
          { type: 'text', text: buildPdfPrompt(url, context) }
        ]
      }];
    } else {
      systemPrompt = withLang(SYSTEM_PROMPT, lang);
      messages = [{ role: 'user', content: buildExternalPrompt(url, page, context) }];
    }

    let accumulated = '';
    const modelId = resolveModel(modelKey);
    // SKU tag for usage logging: distinguishes image (vision) vs pdf
    // (document) vs html (text) tooltip costs so per-type spend tracks
    // separately. Different SKUs have very different per-call costs.
    const kind = page.isImage ? 'summary.image' : page.isPdf ? 'summary.pdf' : 'summary.html';
    // Commit point — past this we've started paying Anthropic, so the
    // handler's req-close listener won't refund the quota slot anymore.
    if (abortToken) abortToken.claudeStarted = true;
    const stream = getModelStream({
      model: modelId,
      max_tokens: 350,
      stop_sequences: ['</p>'],
      system: systemPrompt,
      messages
    }, { signal: opts.signal });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        accumulated += text;
        sentDelta = true;
        sseWrite(res, { type: 'delta', text });
      }
    }
    try {
      const finalMsg = await stream.finalMessage();
      recordTokenUsage({ tester, endpoint: kind, model: actualModel(modelId), usage: finalMsg.usage });
    } catch (e) { /* finalMessage rejected — usage not logged */ }

    const ensured = ensureWikilinkClass(normalizeRawAnchors(expandShortLinks(closeStrippedParagraph(accumulated.trim()))));
    let verified = sanitizeFinalHtml(addAnchorHrefs(await verifyLinks(ensured)));
    let title = page.title;
    if (page.isImage || page.isPdf) {
      const extracted = extractLeadingTitle(verified);
      if (extracted.title) {
        title = extracted.title;
        verified = extracted.html;
      } else if (page.isImage && linkPage?.title) {
        // No AI-emitted <h3> (generic image case) — use the linked source
        // page's title rather than the image CDN hostname.
        title = linkPage.title;
      }
    }

    const result = {
      title,
      description: page.excerpt || new URL(url).hostname,
      // Unwrap anchors pointing back at this tooltip's own subject — by
      // title (wikilinks) or by URL (an extlink to the very page being
      // summarized).
      html: stripSelfLinks(verified, { titles: [title, page.title, context?.title], url }),
      isExternal: true,
      url
    };
    if (!prefetched) externalSummaryCache.set(cacheKey, result);
    sseWrite(res, { type: 'final', ...result });
  } catch (err) {
    // Model died before producing anything the user saw — return the PDF
    // surcharge so a flaky API call doesn't eat 10+ credits.
    if (pdfSurcharge > 0 && !sentDelta) refundQuota(opts.user, pdfSurcharge);
    let message = err.message;
    if (err.status === 429) message = 'Rate limited by the API. Wait a few seconds and try again.';
    else if (err.status >= 500) message = 'Anthropic API is having trouble. Try again in a moment.';
    console.error(`External summary error:`, err.message);
    sseWrite(res, { type: 'error', message });
  } finally {
    sseWrite(res, '[DONE]');
    res.end();
  }
}

// ---------- Image downscaling for the vision path ----------
// Anthropic auto-scales any image > 1568 px on the long edge, but we go
// well below that on purpose: vision token cost scales with pixel count
// (~width × height / 750). 768 px on the long edge cuts per-image input
// tokens roughly 76% vs 1568 (and ~44% vs 1024) while testing showed no
// noticeable degradation on typical subjects — photos, paintings,
// screenshots, product shots, memes, diagrams. Drop further only if a
// specific category visibly suffers. 4 MB post-encoding cap stays the
// same (Anthropic's hard limit is 5 MB; base64 inflates by ~33%).
//
// Re-encode as JPEG q85 unless the source is small + small enough that the
// original bytes already pass both checks. Flatten alpha to white so PNGs
// with transparency don't end up with black backgrounds in the JPEG.
const VISION_MAX_DIM = 600;
const VISION_MAX_BYTES = 4_000_000;
// PDF bytes are sent to Claude unchanged (the model handles parsing).
// Anthropic's per-request limit is 32 MB but cost + latency scale linearly
// with size — capping at 10 MB covers most academic papers, datasheets,
// reports, and gives a clean error for anything larger rather than blowing
// up the request budget on a 200-page government PDF someone happened to hover.
const PDF_MAX_BYTES = 10 * 1024 * 1024;
// Non-funded tiers (anon/free) get tighter PDF bounds: 4 MB covers almost
// every paper/doc a person hovers, and the per-day count bounds the single
// most expensive endpoint independently of the credit ledger.
const FREE_PDF_MAX_BYTES = 4 * 1024 * 1024;
const FREE_PDF_DAILY_CAP = 3;

async function shrinkImageForVision(buf, mediaType) {
  // Fast path: original already passes both checks. Re-encoding would just
  // waste CPU + degrade quality.
  if (buf.length <= VISION_MAX_BYTES) {
    try {
      const meta = await sharp(buf).metadata();
      const long = Math.max(meta.width || 0, meta.height || 0);
      if (long > 0 && long <= VISION_MAX_DIM) return { buf, mediaType };
    } catch {
      // Couldn't read metadata. Fall through to re-encode attempt.
    }
  }

  try {
    const out = await sharp(buf, { animated: false }) // first frame for animated GIFs
      .resize({ width: VISION_MAX_DIM, height: VISION_MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .flatten({ background: '#ffffff' })
      .jpeg({ quality: 85, mozjpeg: true })
      .toBuffer();
    if (out.length > VISION_MAX_BYTES) {
      // Still too big after q85 (very rare for 1568-capped jpegs). Try q70.
      const lower = await sharp(buf, { animated: false })
        .resize({ width: VISION_MAX_DIM, height: VISION_MAX_DIM, fit: 'inside', withoutEnlargement: true })
        .flatten({ background: '#ffffff' })
        .jpeg({ quality: 70, mozjpeg: true })
        .toBuffer();
      if (lower.length > VISION_MAX_BYTES) {
        throw new Error('Image too large to identify');
      }
      return { buf: lower, mediaType: 'image/jpeg' };
    }
    return { buf: out, mediaType: 'image/jpeg' };
  } catch (err) {
    if (err.message === 'Image too large to identify') throw err;
    // sharp failed to decode — bail with a friendly error rather than
    // sending unprocessable bytes to Claude.
    throw new Error("Couldn't process this image");
  }
}

// ---------- Generic page annotation (extension's "Annotate this page" button) ----------
// Same shape as the literature annotation passes — Claude scans plain text,
// returns {phrase, term} pairs that the client wraps into wikilinks. The
// client is responsible for extracting clean text (Readability) and for the
// DOM walk that wraps matched phrases. Server is stateless: cache by URL +
// content hash so re-annotating the same article doesn't re-pay Claude.
//
// Cap input at ~25 KB plain text — that's roughly a long-form blog post or
// a Wikipedia article body. Beyond that we'd be paying for diminishing
// returns and risking 4xx output truncation.
const PAGE_ANNOTATION_MAX_CHARS = 25000;
const pageAnnotationCache = lru(100); // `${url}|${contentHash}|${modelKey}` → annotations (large entries, low cap)

function quickHash(s) {
  // 32-bit FNV-ish — collision-resistant enough to cache-key by content,
  // not cryptographic. Stays small for a Map key.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h.toString(16);
}

// Annotation always runs on the fast model regardless of the user's tooltip
// preference. Phrase extraction is structured/recall-bound work — Sonnet
// doesn't produce meaningfully better picks here, just costlier ones.
async function getPageAnnotations(text, pageTitle, tester, signal) {
  const trimmed = text.length > PAGE_ANNOTATION_MAX_CHARS ? text.slice(0, PAGE_ANNOTATION_MAX_CHARS) : text;
  const titleLine = pageTitle ? `Page title: "${pageTitle}".\n\n` : '';

  const prompt = `You are annotating a webpage for a curious reader who clicked "Annotate this page" in a browser extension. Identify proper nouns and complex concepts in the text below that have Wikipedia articles. Be AGGRESSIVE — aim for 30–60 annotations on a typical article-length page (more if the text is long, fewer only if it's very short). If a paragraph has zero annotations, you're under-annotating — go back and find named entities or formal concepts in it.

${titleLine}The text:

${trimmed}

Output ONLY a JSON array (no preamble, no markdown fences). Each item: {"phrase": "exact substring from the text", "term": "Exact Wikipedia article title"}.

STRICT NAMING RULE — read carefully before producing output:
The phrase you wrap MUST literally name the Wikipedia subject. Direct names, proper nouns, technical terms, and standard alternate spellings are allowed. Thematic, metaphorical, paraphrastic, or interpretive mappings are FORBIDDEN.
- WRONG: "those who govern" → "Government" (vague)
- WRONG: "the old order" → "Ancien Régime" (interpretive — only annotate if "ancien régime" is literally in the text)
- WRONG: "feeling sad" → "Sadness" (thematic)
- RIGHT: "Napoleon" → "Napoleon"
- RIGHT: "the French Revolution" → "French Revolution"
- RIGHT: "kubernetes" → "Kubernetes"
If you'd have to interpret to make the connection, do NOT annotate it.

What to annotate (be liberal — treat every named entity and every formal/technical concept as a candidate):
- Real people (every name, including ones mentioned in passing).
- Places (every city, region, country, neighborhood, landmark, institution by name).
- Organizations, companies, agencies, schools, teams, bands.
- Named works (books, films, paintings, albums, plays, songs, games, products).
- Events, eras, dynasties, wars, movements, treaties, court cases.
- Technologies, techniques, algorithms, formal terms, theories, philosophies, schools of thought.
- Specialized vocabulary a curious reader might want a one-hover gloss on (medical terms, scientific terms, legal terms, jargon, foreign-language words used in their domain sense, named species, named materials, named processes).
- Job/role titles only when they are proper-noun-y enough to have their own Wikipedia article ("Praetorian Guard" yes, "soldier" no).

What NOT to annotate:
- Generic common nouns ("the company", "the team", "people") with no named referent.
- Pronouns or bare titles ("she said", "the president" with no name attached).
- Things internal to the page that don't have a Wikipedia article.
- Phrases you'd have to interpret to map (see strict naming rule above).

Format rules:
- Phrase must appear verbatim in the text (we string-search for the first occurrence).
- term must be the exact canonical Wikipedia article title.
- One entry per concept (we wrap only the first occurrence).
- Strict JSON only. No commentary.`;

  const modelId = resolveModel('fast');
  const response = await claude.messages.create({
    model: modelId,
    max_tokens: 4000,
    messages: [{ role: 'user', content: prompt }]
  }, { signal });
  recordTokenUsage({ tester, endpoint: 'annotate.page', model: modelId, usage: response.usage });
  const text2 = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  const match = text2.match(/\[[\s\S]*\]/);
  if (!match) return [];
  try { return JSON.parse(match[0]); } catch { return []; }
}

async function getPageAnnotationsCached(url, text, pageTitle, tester, signal) {
  const key = `${url}|${quickHash(text)}`;
  // `cached` lets the /annotate handler refund the credits it charged
  // optimistically — a cache hit costs no inference.
  if (pageAnnotationCache.has(key)) {
    return { annotations: pageAnnotationCache.get(key), cached: true };
  }

  const annotations = await getPageAnnotations(text, pageTitle, tester, signal);
  // Verify each term resolves to a real Wikipedia article — same defensive
  // step the literature annotation passes use. Drops Claude's hallucinated
  // article titles before they reach the client.
  const verified = (await Promise.all(annotations.map(async (a) => {
    if (!a || !a.phrase || !a.term) return null;
    return (await verifyTermExists(a.term)) ? a : null;
  }))).filter(Boolean);

  pageAnnotationCache.set(key, verified);
  return { annotations: verified, cached: false };
}

async function streamSummary(target, context, res, opts = {}) {
  const { modelKey, tester, abortToken, lang, isPaid, user, signal } = opts;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    // no-transform tells Cloudflare not to compress/gzip the response, which
    // forces it out of buffering mode for SSE. no-cache + no-transform is the
    // canonical CF combo for streaming.
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
    // Explicitly disable any further encoding negotiation downstream.
    'Content-Encoding': 'identity'
  });
  // Disable Nagle's algorithm so each write hits the wire without waiting
  // to coalesce with the next one.
  if (res.socket) res.socket.setNoDelay(true);
  // 16KB initial padding — defeats any reasonable proxy buffer. 2KB wasn't
  // enough on Cloudflare; 16KB pushes well past their threshold. Also
  // immediately forces flushHeaders so the response is "live" from t=0
  // rather than sitting in the proxy's pending pool.
  res.write(': ' + 'x'.repeat(16384) + '\n\n');
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
  // Pair the comment with a real SSE data event the client safely ignores
  // (worker forwards it; client's port listener only matches delta/final/
  // done/error). Establishes the response as a stream of events rather
  // than a blob of comment padding.
  res.write('data: {"type":"pending"}\n\n');
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write('data: {"type":"pending"}\n\n');
  }, 1500);
  res.on('close', () => clearInterval(heartbeat));

  // Include lang in the cache key — same target requested in English and
  // Spanish would otherwise return identical cached output.
  const cacheKey = `${target}|${context?.title || ''}|${modelKey || DEFAULT_MODEL_KEY}|${lang || ''}`;
  if (summaryCache.has(cacheKey)) {
    // Cache hit — send only the final so the client snaps instead of typewritering
    const cached = summaryCache.get(cacheKey);
    sseWrite(res, { type: 'final', ...cached });
    sseWrite(res, '[DONE]');
    clearInterval(heartbeat);
    res.end();
    return;
  }

  try {
    // Three-tier resolution chain:
    //   1. Title verbatim — fast path, hits for known titles and Wikipedia
    //      redirect cases ("the nile" → Nile).
    //   2. Wikipedia OpenSearch — catches multi-word selections that don't
    //      match a title or redirect ("the egyptian river" → Nile).
    //   3. OpenRouter `:online` web search — for queries with no Wikipedia
    //      article at all (research paper titles, chemical compounds, niche
    //      people/places). Top result URL hands off to the external-summary
    //      pipeline so the tooltip reuses fetch/Readability/summarize.
    let resolvedTarget = target;
    let summary;
    try {
      summary = await fetchWikiSummary(target);
    } catch (err) {
      if (!/Wikipedia 404/.test(err.message)) throw err;
      const found = await searchWikiTitle(target);
      if (found) {
        resolvedTarget = found;
        summary = await fetchWikiSummary(found);
      } else {
        const url = await searchWebUrl(target);
        if (!url) throw new Error(`No source found for "${target}"`);
        // Hand off to the external pipeline. Critical: AWAIT here rather
        // than `return streamExternalSummary(...)`. The latter exits the try
        // synchronously which fires the outer finally — sseWrite('[DONE]')
        // + res.end() — *before* streamExternalSummary has done any work,
        // killing the response. Subsequent SES writes then hit the
        // writableEnded guard and silently no-op (the LLM completes but its
        // output never reaches the client; the externalSummaryCache fill is
        // what made the re-hover appear to "work"). The await blocks the
        // try block from exiting until SES finishes writing its final +
        // [DONE] + res.end(). The finally still runs after, but by then
        // writableEnded=true so the guard cleanly absorbs both writes.
        await streamExternalSummary(url, context, res, {
          modelKey, tester, abortToken, lang, isPaid, user, signal, skipHeaders: true
        });
        return;
      }
    }
    const targetLead = (summary.extract || '').slice(0, 1500);
    if (!targetLead) throw new Error(`No Wikipedia content found for "${resolvedTarget}"`);

    const prompt = buildPrompt(resolvedTarget, targetLead, context);

    let accumulated = '';
    const modelId = resolveModel(modelKey);
    // Client disconnected during the wiki-resolution awaits — the handler's
    // close listener already refunded; don't start a paid call into the void.
    if (abortToken?.closed) return;
    // Commit point — see streamExternalSummary for the same pattern.
    if (abortToken) abortToken.claudeStarted = true;
    const stream = getModelStream({
      model: modelId,
      max_tokens: 350,
      stop_sequences: ['</p>'],
      system: withLang(SYSTEM_PROMPT, lang),
      messages: [{ role: 'user', content: prompt }]
    }, { signal });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        const text = event.delta.text;
        accumulated += text;
        sseWrite(res, { type: 'delta', text });
      }
    }
    try {
      const finalMsg = await stream.finalMessage();
      recordTokenUsage({ tester, endpoint: 'summary.wiki', model: actualModel(modelId), usage: finalMsg.usage });
    } catch (e) { /* finalMessage rejected — usage not logged */ }

    const ensured = ensureWikilinkClass(normalizeRawAnchors(expandShortLinks(closeStrippedParagraph(accumulated.trim()))));
    const verified = sanitizeFinalHtml(addAnchorHrefs(await verifyLinks(ensured)));

    const result = {
      title: summary.title || resolvedTarget,
      description: summary.description || '',
      // Unwrap any anchor pointing back at this tooltip's own subject —
      // the original hover term, the resolved title, the canonical article
      // title, and the page the reader is already on all count as "self".
      html: stripSelfLinks(verified, { titles: [summary.title, resolvedTarget, target, context?.title] })
    };
    summaryCache.set(cacheKey, result);

    sseWrite(res, { type: 'final', ...result });
  } catch (err) {
    let message = err.message;
    if (err.status === 429) message = 'Rate limited by the API. Wait a few seconds and try again.';
    else if (err.status >= 500) message = 'Anthropic API is having trouble. Try again in a moment.';
    console.error(`Summary stream error (status=${err.status}):`, err.message);
    sseWrite(res, { type: 'error', message });
  } finally {
    sseWrite(res, '[DONE]');
    res.end();
  }
}

// ---------- HTTP server ----------

// Cap any single POST body. Legit /summary payloads ship Readability output
// (typically <100KB) and /annotate ships page text capped at 50K chars
// server-side — 2MB leaves comfortable headroom while preventing a single
// client from concatenating an unbounded string in memory.
const MAX_BODY_BYTES = 2_000_000;

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error('Request body too large');
      err.statusCode = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

// ---------- Identities ----------
// portaltext is account-less: the extension registers a silent anonymous
// identity on install (POST /auth/anon below) and authenticates every AI
// request with the returned opaque bearer token. Sessions live in SQLite.
// The schema retains email/password columns from the pre-launch email-auth
// era — kept for DB compatibility; anon rows fill them with synthetic
// values, and any leftover email-era rows simply age out.
//
// Storage: SQLite at portaltext.db in the working directory. On hosts with
// ephemeral filesystems (Render free tier, etc.) attach a persistent disk and
// point AUTH_DB_PATH at it — losing this DB loses all identities and quota.
const AUTH_DB_PATH = process.env.AUTH_DB_PATH || path.join(__dirname, 'portaltext.db');
const authDb = new Database(AUTH_DB_PATH);
authDb.pragma('journal_mode = WAL');
authDb.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    email_confirmed_at INTEGER,
    confirmation_token TEXT,
    confirmation_sent_at INTEGER,
    created_at INTEGER NOT NULL,
    plan_tier TEXT NOT NULL DEFAULT 'free',
    stripe_customer_id TEXT,
    usage_count INTEGER NOT NULL DEFAULT 0,
    usage_period_start INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_users_confirmation ON users(confirmation_token);

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

  -- Supporter claim codes. One row per completed Stripe checkout (keyed by
  -- the session id for idempotency). The code is the durable supporter
  -- credential: a donor pastes it into the popup to upgrade an install, and
  -- can re-paste it after a reinstall or on another device — up to
  -- max_redemptions distinct upgrades, which bounds a publicly-shared code.
  CREATE TABLE IF NOT EXISTS supporter_codes (
    code TEXT PRIMARY KEY,
    stripe_session_id TEXT UNIQUE,
    amount_cents INTEGER,
    currency TEXT,
    created_at INTEGER NOT NULL,
    redemptions INTEGER NOT NULL DEFAULT 0,
    max_redemptions INTEGER NOT NULL DEFAULT 5
  );
  CREATE INDEX IF NOT EXISTS idx_supporter_session ON supporter_codes(stripe_session_id);
`);

// Migration: rolling-bucket quota fields. Wrapped in try/catch so it's safe
// to run on every boot — ALTER TABLE throws if the column already exists.
try { authDb.exec('ALTER TABLE users ADD COLUMN quota_remaining INTEGER NOT NULL DEFAULT 0'); } catch {}
try { authDb.exec('ALTER TABLE users ADD COLUMN last_refill_at INTEGER NOT NULL DEFAULT 0'); } catch {}
// daily_used: per-day counter that resets at the same UTC midnight as the
// bucket refill. Independent of the rolling bank so the popup's ring can
// show today's usage at meaningful resolution (instead of the bank ratio,
// which barely budges day-to-day because the bank holds 7 days of credit).
try { authDb.exec('ALTER TABLE users ADD COLUMN daily_used INTEGER NOT NULL DEFAULT 0'); } catch {}

// Migration: password reset fields. reset_token is the single-use opaque
// token sent by email; reset_sent_at gates the 24-hour expiry window.
try { authDb.exec('ALTER TABLE users ADD COLUMN reset_token TEXT'); } catch {}
try { authDb.exec('ALTER TABLE users ADD COLUMN reset_sent_at INTEGER'); } catch {}
try { authDb.exec('CREATE INDEX IF NOT EXISTS idx_users_reset_token ON users(reset_token)'); } catch {}

// Migration: silent anonymous identities. Anon rows reuse the users table
// (synthetic unique email, random unusable password hash) so sessions,
// quotas, and tier grants all work unchanged; is_anon distinguishes them
// for display. pdf_daily_used is the per-day PDF counter behind the
// free-tier PDF cap — reset alongside daily_used at refill time.
try { authDb.exec('ALTER TABLE users ADD COLUMN is_anon INTEGER NOT NULL DEFAULT 0'); } catch {}
try { authDb.exec('ALTER TABLE users ADD COLUMN pdf_daily_used INTEGER NOT NULL DEFAULT 0'); } catch {}

// Plan caps as rolling daily-refill credit buckets. Each tier refills `daily`
// new credits each calendar day (UTC); unused credits bank up to `bank` max.
// Replaces the prior monthly hard-reset model — it's friendlier to casual
// users (a quiet week translates into a full bank for a binge weekend) and
// smoother on the cost curve (no monthly usage spikes). `beta` stays
// unlimited for the friend-testing tier.
const PLAN_LIMITS = {
  // anon: the silent install-time identity — the default tier for everyone.
  // Same numbers as free (email accounts) so the two are interchangeable.
  anon:  { daily: 40,  bank: 280  },   // 7-day rollover
  free:  { daily: 40,  bank: 280  },   // 7-day rollover
  plus:  { daily: 150, bank: 1050 },   // legacy $7/mo tier — kept for granted accounts
  // supporter: donation tier (Stripe link + claim code) — unlimited.
  supporter: { daily: Infinity, bank: Infinity },
  beta:  { daily: Infinity, bank: Infinity },
};

// Credit weights per surface — proportional to real inference cost so the
// daily allowance is one currency across features. A plain tooltip ≈
// $0.001; a 50K-char annotation pass ≈ 15-30× that; a PDF document block
// tokenizes per page and lands 1-2 orders of magnitude above a tooltip.
// PDF cost scales with file size (10 base + 1/MB, charged as a surcharge
// on top of the 1 credit the /summary gate already took).
const CREDIT_COSTS = {
  summary: 1,
  annotate: 8,
  pdfBase: 10,
};
function pdfCreditCost(bytes) {
  return CREDIT_COSTS.pdfBase + Math.ceil((bytes || 0) / (1024 * 1024));
}

// Paid-access gating. Historically gated annotation/PDF entirely; now that
// those are credit-priced for everyone, this only lifts the PDF size/count
// caps and the spend breaker for tiers that are funded (or trusted).
function userHasPaidAccess(user) {
  if (!user) return false;
  return user.plan_tier === 'plus' || user.plan_tier === 'beta' || user.plan_tier === 'supporter';
}

function generateToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

// The email/password columns in the insert are legacy schema shape — anon
// identities fill them with a synthetic address and an unusable random hash.
// (Email auth was removed pre-launch; rows from the email era may still
// exist in older databases and simply age out with their sessions.)
const userStmts = {
  insert: authDb.prepare(`
    INSERT INTO users (id, email, password_hash, password_salt, confirmation_token, confirmation_sent_at, created_at, usage_period_start)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `),
  findById: authDb.prepare('SELECT * FROM users WHERE id = ?'),
};
const sessionStmts = {
  create: authDb.prepare('INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)'),
  find: authDb.prepare('SELECT * FROM sessions WHERE token = ? AND expires_at > ?'),
};
const supporterStmts = {
  insert: authDb.prepare('INSERT OR IGNORE INTO supporter_codes (code, stripe_session_id, amount_cents, currency, created_at, max_redemptions) VALUES (?, ?, ?, ?, ?, ?)'),
  findByCode: authDb.prepare('SELECT * FROM supporter_codes WHERE code = ?'),
  findBySession: authDb.prepare('SELECT * FROM supporter_codes WHERE stripe_session_id = ?'),
  bumpRedemptions: authDb.prepare('UPDATE supporter_codes SET redemptions = redemptions + 1 WHERE code = ?'),
};

function publicUserFields(u) {
  const limits = PLAN_LIMITS[u.plan_tier] || PLAN_LIMITS.free;
  // Infinity (beta tier) serializes as null in JSON — the popup treats null
  // as "unlimited" and hides the usage indicator.
  const bank = Number.isFinite(limits.bank) ? limits.bank : null;
  const daily = Number.isFinite(limits.daily) ? limits.daily : null;
  return {
    id: u.id,
    // Anon identities carry a synthetic placeholder email — never show it.
    email: u.is_anon ? null : u.email,
    is_anon: !!u.is_anon,
    email_confirmed: !!u.email_confirmed_at,
    plan_tier: u.plan_tier,
    created_at: u.created_at,
    // Rolling-bucket fields — kept for downstream consumers + the dead-
    // pattern cache. The ring uses daily_* instead now.
    quota_remaining: bank === null ? null : Math.min(u.quota_remaining ?? 0, bank),
    quota_bank: bank,
    // Per-day usage and the daily refill amount. The popup ring's fill
    // ratio is daily_used / daily_limit (capped at 1) — gives meaningful
    // day-to-day movement instead of the bank ratio which barely budges
    // because the bank holds 7 days of credit.
    daily_used: daily === null ? null : (u.daily_used ?? 0),
    daily_limit: daily,
    // Lifetime call count, kept for the digest. Not used for gating anymore.
    usage_count: u.usage_count,
  };
}

// Per-user quota state machine — rolling daily-refill credit bucket.
// On each authenticated AI call:
//   1. Compute days elapsed since last refill (UTC day boundaries).
//   2. Credit (daysElapsed * daily) credits, capped at the tier's bank max.
//   3. If quota_remaining < 1, reject with quota_exceeded.
//   4. Otherwise decrement and let the call through.
// Increments optimistically — refunds happen on cache hits / aborts via
// refundQuota below.
const DAY_MS = 24 * 60 * 60 * 1000;
const updateQuotaStmt = authDb.prepare(
  'UPDATE users SET quota_remaining = ?, last_refill_at = ?, daily_used = 0, pdf_daily_used = 0 WHERE id = ?'
);
const consumeQuotaStmt = authDb.prepare(
  'UPDATE users SET quota_remaining = quota_remaining - ?, usage_count = usage_count + 1, daily_used = daily_used + ? WHERE id = ?'
);
const refundQuotaStmt = authDb.prepare(
  'UPDATE users SET quota_remaining = MIN(?, quota_remaining + ?), usage_count = MAX(0, usage_count - 1), daily_used = MAX(0, daily_used - ?) WHERE id = ?'
);

// Refill the user's bucket based on time elapsed since the last refill.
// Mutates the user object in place and writes the new values to the DB
// when a refill actually occurs. Also resets daily_used to 0 — the popup
// ring displays daily_used / daily_limit, so it should snap to empty
// at the same moment the bucket gets its new credit.
function refillUserQuota(user) {
  const limits = PLAN_LIMITS[user.plan_tier] || PLAN_LIMITS.free;
  if (!Number.isFinite(limits.daily)) return; // beta tier: skip
  const now = Date.now();
  const lastDay  = Math.floor((user.last_refill_at || 0) / DAY_MS);
  const todayDay = Math.floor(now / DAY_MS);
  // First-time / migrating users get a full bank credit; explicit cap on
  // catch-up days prevents a stale row from racking up huge credit later.
  const daysElapsed = user.last_refill_at === 0
    ? Math.ceil(limits.bank / limits.daily)
    : Math.max(0, todayDay - lastDay);
  if (daysElapsed === 0) return;
  const credited = Math.min(limits.bank, (user.quota_remaining || 0) + daysElapsed * limits.daily);
  updateQuotaStmt.run(credited, now, user.id);
  user.quota_remaining = credited;
  user.last_refill_at = now;
  user.daily_used = 0;
  user.pdf_daily_used = 0;
}

// Refund previously-consumed credits when the underlying call never
// actually happened (cache hit, client disconnect, etc). Clamped at the
// tier's bank in SQL so concurrent refunds can't push past the cap.
function refundQuota(user, cost = 1) {
  if (!user) return;
  const limits = PLAN_LIMITS[user.plan_tier] || PLAN_LIMITS.free;
  if (!Number.isFinite(limits.bank)) return; // unlimited tiers: nothing to refund
  refundQuotaStmt.run(limits.bank, cost, cost, user.id);
  user.quota_remaining = Math.min(limits.bank, (user.quota_remaining || 0) + cost);
  user.usage_count = Math.max(0, (user.usage_count || 1) - 1);
  user.daily_used = Math.max(0, (user.daily_used || cost) - cost);
}

function consumeQuota(user, cost = 1) {
  const limits = PLAN_LIMITS[user.plan_tier] || PLAN_LIMITS.free;
  // Unlimited tiers (supporter/beta): no decrement, but still bump
  // usage_count for the digest.
  if (!Number.isFinite(limits.bank)) {
    authDb.prepare('UPDATE users SET usage_count = usage_count + 1 WHERE id = ?').run(user.id);
    user.usage_count = (user.usage_count || 0) + 1;
    return { ok: true, user, limit: null, used: user.usage_count };
  }
  refillUserQuota(user);
  if ((user.quota_remaining || 0) < cost) {
    return { ok: false, reason: 'quota_exceeded', limit: limits.bank, used: 0, needed: cost };
  }
  consumeQuotaStmt.run(cost, cost, user.id);
  user.quota_remaining -= cost;
  user.usage_count = (user.usage_count || 0) + 1;
  user.daily_used = (user.daily_used || 0) + cost;
  return { ok: true, user, limit: limits.bank, used: limits.bank - user.quota_remaining };
}

// Per-day PDF counter — see FREE_PDF_DAILY_CAP. Reset happens alongside the
// daily credit refill (updateQuotaStmt zeroes it).
const bumpPdfDailyStmt = authDb.prepare('UPDATE users SET pdf_daily_used = pdf_daily_used + 1 WHERE id = ?');
function notePdfUse(user) {
  if (!user) return;
  bumpPdfDailyStmt.run(user.id);
  user.pdf_daily_used = (user.pdf_daily_used || 0) + 1;
}

// Marketing-site origins that may hit the AI endpoints anonymously as a
// try-before-install demo. Anything else (the extension's chrome-extension://
// origin included) must carry an auth token.
const DEMO_ALLOWED_ORIGINS = new Set([
  'https://portaltext.com',
  'https://www.portaltext.com',
  'http://localhost:3000',
  'http://127.0.0.1:3000',
]);
const DEMO_DAILY_CAP = 20;
const demoIpBuckets = new Map(); // ip -> { count, day }

function demoToday() {
  return new Date().toISOString().slice(0, 10);
}

function consumeDemoQuota(ip) {
  const today = demoToday();
  let bucket = demoIpBuckets.get(ip);
  if (!bucket || bucket.day !== today) {
    bucket = { count: 0, day: today };
    demoIpBuckets.set(ip, bucket);
  }
  if (bucket.count >= DEMO_DAILY_CAP) {
    return { ok: false, used: bucket.count, limit: DEMO_DAILY_CAP };
  }
  bucket.count += 1;
  return { ok: true, used: bucket.count, limit: DEMO_DAILY_CAP };
}

function originIsDemoAllowed(req) {
  const origin = (req.headers.origin || '').toLowerCase();
  if (origin && DEMO_ALLOWED_ORIGINS.has(origin)) return true;
  // Fall back to Referer for the rare case a UA strips Origin on
  // same-origin POST. Parse and compare the origin component only.
  const referer = (req.headers.referer || '').toLowerCase();
  if (referer) {
    try {
      const ro = new URL(referer).origin;
      if (DEMO_ALLOWED_ORIGINS.has(ro)) return true;
    } catch {}
  }
  return false;
}

// Daily cleanup — drop yesterday's IP buckets so the map doesn't accrue
// stale entries from one-off visitors. unref() keeps the timer from
// pinning the event loop open during shutdown.
setInterval(() => {
  const today = demoToday();
  for (const [ip, bucket] of demoIpBuckets.entries()) {
    if (bucket.day !== today) demoIpBuckets.delete(ip);
  }
}, 60 * 60 * 1000).unref();

// Wraps the auth/quota check used by every AI endpoint. Returns
//   - { user, cost }          : authenticated, `cost` credits consumed
//   - { user: null, isDemo }  : anonymous demo (marketing origin only, capped)
//   - null                    : rejected, response already sent
// opts.cost: credits to charge (default 1 — the plain-summary weight).
// Heavier surfaces (annotation, PDF) pass their own weight; refunds must
// pass the same amount back.
function gateAiRequest(req, res, opts = {}) {
  const cost = opts.cost || CREDIT_COSTS.summary;
  const user = authenticateRequest(req);
  // Global spend breaker: once today's model spend hits the cap, server-paid
  // inference pauses for everyone except funded tiers. Checked before any
  // quota is consumed so nothing needs refunding on this path.
  if (spendBreakerTripped() && !userHasPaidAccess(user)) {
    sendJson(res, 429, {
      error: "portaltext has hit its daily budget and is resting until tomorrow (UTC). Thanks for understanding!",
      reason: 'spend_cap',
    });
    return null;
  }
  if (!user) {
    if (!originIsDemoAllowed(req)) {
      sendJson(res, 401, {
        error: 'Sign in to use portaltext.',
        reason: 'auth_required',
      });
      return null;
    }
    const dq = consumeDemoQuota(clientIp(req));
    if (!dq.ok) {
      sendJson(res, 429, {
        error: `Demo limit reached (${dq.limit}/day). Install the extension to keep going.`,
        reason: 'demo_quota_exceeded',
        limit: dq.limit,
        used: dq.used,
      });
      return null;
    }
    return { user: null, isDemo: true };
  }
  if (!user.email_confirmed_at) {
    sendJson(res, 403, { error: 'Confirm your email before using portaltext.' });
    return null;
  }
  const q = consumeQuota(user, cost);
  if (!q.ok) {
    sendJson(res, 429, {
      error: cost > 1
        ? `Not enough credits left today for this (needs ${cost}). Credits refill tomorrow.`
        : `You've used today's free credits. They refill tomorrow.`,
      reason: 'quota_exceeded',
      limit: q.limit,
      used: q.used,
      needed: cost,
      // Echo the plan so the client can choose between supporter-prompt
      // copy (anon/free) and come-back-tomorrow copy (plus).
      plan: user.plan_tier || 'free',
    });
    return null;
  }
  return { user, cost };
}

// Pull the bearer token from the Authorization header (or X-Portaltext-Token
// as a fallback for hosts that strip Authorization). Returns the user row or
// null. Doesn't enforce email_confirmed — that's the caller's call.
function authenticateRequest(req) {
  const auth = req.headers['authorization'] || '';
  let token = '';
  const m = auth.match(/^Bearer\s+([A-Za-z0-9]+)$/);
  if (m) token = m[1];
  else token = (req.headers['x-portaltext-token'] || '').toString().trim();
  if (!token) return null;
  const session = sessionStmts.find.get(token, Date.now());
  if (!session) return null;
  return userStmts.findById.get(session.user_id) || null;
}

async function handleAuthMe(req, res) {
  const user = authenticateRequest(req);
  if (!user) return sendJson(res, 401, { error: 'Not signed in' });
  // Roll the daily refill before serializing so the popup's usage ring
  // reflects today's credits even if the user hasn't hovered yet.
  refillUserQuota(user);
  return sendJson(res, 200, { user: publicUserFields(user) });
}

// ---------- Silent anonymous identity ----------
// The extension registers itself on install — no email, no password, no
// user-visible signup. The returned bearer token is the install's identity;
// quotas hang off the user row exactly like email accounts. Clearing
// extension storage mints a fresh identity (and a fresh bank), which is an
// accepted soft spot: the per-IP registration cap below plus the global
// spend breaker bound what identity-churn can extract.
//
// Long TTL: the token IS the account. Expiring it would silently orphan the
// install's quota state, so anon sessions live for a year and the extension
// re-registers if the server ever stops honoring one.
const ANON_SESSION_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const ANON_REG_DAILY_CAP = 10;
const anonRegBuckets = new Map(); // ip -> { count, day }

setInterval(() => {
  const today = demoToday();
  for (const [ip, bucket] of anonRegBuckets.entries()) {
    if (bucket.day !== today) anonRegBuckets.delete(ip);
  }
}, 60 * 60 * 1000).unref();

async function handleAuthAnon(req, res) {
  const ip = clientIp(req);
  const today = demoToday();
  let bucket = anonRegBuckets.get(ip);
  if (!bucket || bucket.day !== today) {
    bucket = { count: 0, day: today };
    anonRegBuckets.set(ip, bucket);
  }
  if (bucket.count >= ANON_REG_DAILY_CAP) {
    return sendJson(res, 429, { error: 'Too many new installs from this network today. Try again tomorrow.' });
  }
  bucket.count += 1;

  const id = crypto.randomUUID();
  const now = Date.now();
  // Synthetic placeholder email satisfies the UNIQUE NOT NULL column;
  // .invalid is reserved (RFC 2606) so it can never collide with a real
  // address. Random password hash means no credential can ever log in as
  // this row — the session token is the only key.
  const placeholderEmail = `anon-${id}@anon.invalid`;
  const saltHex = crypto.randomBytes(16).toString('hex');
  const passwordHashHex = crypto.randomBytes(64).toString('hex');
  userStmts.insert.run(id, placeholderEmail, passwordHashHex, saltHex, null, null, now, now);
  // Confirmed at creation — there's no email to confirm, and the AI gate
  // requires email_confirmed_at. Tier + anon flag set post-insert to keep
  // the shared insert statement untouched.
  authDb.prepare('UPDATE users SET email_confirmed_at = ?, plan_tier = ?, is_anon = 1 WHERE id = ?')
    .run(now, 'anon', id);

  const token = generateToken();
  sessionStmts.create.run(token, id, now, now + ANON_SESSION_TTL_MS);
  const user = userStmts.findById.get(id);
  // Credit the opening bank now so the first /auth/me (and the popup ring)
  // shows the real balance instead of 0-until-first-hover.
  refillUserQuota(user);
  console.log('[auth] anon identity created', id, 'ip', ip);
  return sendJson(res, 201, { token, user: publicUserFields(user), expires_at: now + ANON_SESSION_TTL_MS });
}

// ---------- Supporter tier (Stripe one-time donation → lifetime unlimited) ----------
// portaltext stays free for everyone; a one-time pay-what-you-want donation
// flips an install to the `supporter` tier (unlimited, breaker-exempt) as a
// thank-you. Account-less, so it hangs off the install id:
//   1. Popup opens /supporter/checkout?install=<id> → 302 to the Stripe
//      Payment Link with client_reference_id=<id>.
//   2. Stripe fires checkout.session.completed → /stripe/webhook creates a
//      durable claim code and (if the install id rode along) upgrades it now.
//   3. Stripe redirects to /supporter/thanks?session_id=… which shows the
//      code so the donor can re-redeem after a reinstall / on another device.
//   4. Popup's "redeem code" field → /supporter/redeem upgrades the install.
// No new dependency: webhook signatures are verified with a hand-rolled HMAC,
// and the one Stripe API call (session retrieve) is a plain fetch.
const STRIPE_SECRET_KEY   = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PAYMENT_LINK = process.env.STRIPE_PAYMENT_LINK || '';
const SUPPORTER_CODE_MAX_REDEMPTIONS = Number(process.env.SUPPORTER_CODE_MAX_REDEMPTIONS || 5);

// Human-friendly claim code: PT-XXXX-XXXX from a Crockford-ish base32 alphabet
// (no 0/O/1/I/L/U to avoid transcription errors). ~50 bits of entropy.
function generateClaimCode() {
  const alphabet = '23456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = crypto.randomBytes(10);
  let out = '';
  for (let i = 0; i < 8; i++) out += alphabet[bytes[i] % alphabet.length];
  return `PT-${out.slice(0, 4)}-${out.slice(4)}`;
}

// Verify a Stripe webhook signature without the SDK. The header looks like
// "t=<unix>,v1=<hex>,..."; the signed payload is `${t}.${rawBody}` HMAC'd
// with the endpoint secret. Returns the parsed event or null.
function verifyStripeWebhook(rawBody, sigHeader) {
  if (!STRIPE_WEBHOOK_SECRET || !sigHeader) return null;
  const parts = Object.fromEntries(
    sigHeader.split(',').map(kv => kv.split('=').map(s => s.trim()))
  );
  const t = parts.t, v1 = parts.v1;
  if (!t || !v1) return null;
  // Reject stale signatures (replay) — 5 minute tolerance.
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return null;
  const expected = crypto.createHmac('sha256', STRIPE_WEBHOOK_SECRET)
    .update(`${t}.${rawBody}`, 'utf8').digest('hex');
  const a = Buffer.from(expected, 'hex'), b = Buffer.from(v1, 'hex');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try { return JSON.parse(rawBody); } catch { return null; }
}

async function stripeSessionRetrieve(sessionId) {
  if (!STRIPE_SECRET_KEY) return null;
  const resp = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
    headers: { Authorization: `Bearer ${STRIPE_SECRET_KEY}` },
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);
  if (!resp || !resp.ok) return null;
  return resp.json().catch(() => null);
}

function upgradeInstallToSupporter(userId) {
  const u = userStmts.findById.get(userId);
  if (!u) return false;
  if (u.plan_tier === 'supporter' || u.plan_tier === 'beta') return false; // already unlimited — no-op, don't count
  authDb.prepare("UPDATE users SET plan_tier = 'supporter' WHERE id = ?").run(userId);
  console.log('[supporter] upgraded install', userId);
  return true;
}

// Idempotent on the Stripe session id: creates the claim code if absent,
// returns the existing row otherwise. Auto-upgrades client_reference_id when
// present. Shared by the webhook and the thanks-page lookup so either path
// alone is sufficient (the redirect can beat the webhook).
function recordCheckoutSession(session) {
  if (!session || session.payment_status !== 'paid') return null;
  const existing = supporterStmts.findBySession.get(session.id);
  let row = existing;
  if (!row) {
    const code = generateClaimCode();
    supporterStmts.insert.run(
      code, session.id, session.amount_total ?? null,
      session.currency ?? null, Date.now(), SUPPORTER_CODE_MAX_REDEMPTIONS
    );
    row = supporterStmts.findBySession.get(session.id);
  }
  // Auto-upgrade the install that initiated checkout (if any), counting it
  // against the code's redemption budget like any other redemption.
  const installId = session.client_reference_id;
  if (installId && row && row.redemptions < row.max_redemptions) {
    if (upgradeInstallToSupporter(installId)) supporterStmts.bumpRedemptions.run(row.code);
  }
  return row;
}

async function handleStripeWebhook(req, res) {
  const raw = await readBody(req);
  const event = verifyStripeWebhook(raw, req.headers['stripe-signature']);
  if (!event) return sendJson(res, 400, { error: 'Invalid signature' });
  if (event.type === 'checkout.session.completed') {
    try { recordCheckoutSession(event.data.object); }
    catch (e) { console.error('[supporter] webhook record failed:', e.message); }
  }
  // Always 200 so Stripe doesn't retry on unhandled event types.
  return sendJson(res, 200, { received: true });
}

// 302 to the Stripe Payment Link, threading the install id through as
// client_reference_id so the webhook can auto-upgrade the right install.
function handleSupporterCheckout(req, res, url) {
  if (!STRIPE_PAYMENT_LINK) return sendJson(res, 503, { error: 'Supporting is not configured yet.' });
  const install = (url.searchParams.get('install') || '').trim();
  let target = STRIPE_PAYMENT_LINK;
  if (/^[0-9a-f-]{16,40}$/i.test(install)) {
    target += (target.includes('?') ? '&' : '?') + 'client_reference_id=' + encodeURIComponent(install);
  }
  res.writeHead(302, { Location: target });
  res.end();
}

// Thanks page fetches this to display the code. Looks it up by session id;
// if the webhook hasn't landed yet, retrieves the session from Stripe and
// creates the code on the spot (both paths idempotent).
async function handleSupporterCode(req, res, url) {
  const sessionId = (url.searchParams.get('session_id') || '').trim();
  if (!sessionId) return sendJson(res, 400, { error: 'Missing session_id' });
  let row = supporterStmts.findBySession.get(sessionId);
  if (!row) {
    const session = await stripeSessionRetrieve(sessionId);
    if (!session) return sendJson(res, 404, { error: 'Payment not found yet — refresh in a moment.' });
    try { row = recordCheckoutSession(session); }
    catch (e) { console.error('[supporter] code create failed:', e.message); }
  }
  if (!row) return sendJson(res, 404, { error: 'Payment not completed.' });
  return sendJson(res, 200, { code: row.code });
}

async function handleSupporterRedeem(req, res) {
  const user = authenticateRequest(req);
  if (!user) return sendJson(res, 401, { error: 'Install portaltext first.' });
  let parsed;
  try { parsed = JSON.parse(await readBody(req)); }
  catch (err) {
    if (err?.statusCode === 413) return sendJson(res, 413, { error: 'Body too large' });
    return sendJson(res, 400, { error: 'Bad JSON' });
  }
  const code = String(parsed.code || '').trim().toUpperCase();
  if (!code) return sendJson(res, 400, { error: 'Enter a code.' });
  const row = supporterStmts.findByCode.get(code);
  if (!row) return sendJson(res, 404, { error: "That code isn't valid.", reason: 'invalid_code' });
  // Already-unlimited installs redeem idempotently (a double-click or a
  // re-redeem of the same code on the same install costs no budget).
  if (user.plan_tier === 'supporter' || user.plan_tier === 'beta') {
    return sendJson(res, 200, { ok: true, user: publicUserFields(user) });
  }
  if (row.redemptions >= row.max_redemptions) {
    return sendJson(res, 409, { error: 'This code has been used its maximum number of times.', reason: 'code_exhausted' });
  }
  if (upgradeInstallToSupporter(user.id)) supporterStmts.bumpRedemptions.run(row.code);
  const fresh = userStmts.findById.get(user.id);
  return sendJson(res, 200, { ok: true, user: publicUserFields(fresh) });
}

// ---------- Claude inference rate limiter (per-IP token bucket) ----------
// Generous burst window (50 tokens) so a user skimming a page can hover many
// links in seconds without hitting a wall. Slow refill (1 token / 6s = 10/min
// sustained, ~600/hour) caps long-running abuse — enough to deeply explore a
// session, far below the rate needed to seriously drain a Claude budget.
//
// Cache hits still consume a token; the bucket is sized so this doesn't affect
// realistic browsing (varied links = cache misses anyway). Trade-off chosen for
// implementation simplicity over per-cache-status accounting.
const RATE_BUCKET_SIZE = 50;
const RATE_REFILL_MS = 6_000;
const rateLimitBuckets = new Map(); // ip -> { tokens, lastRefill }

// X-Forwarded-For is attacker-appendable: a client can send its own XFF
// header and a naive leftmost read lets it mint a fresh rate-limit/quota
// bucket per request. Each trusted proxy in front of us appends exactly one
// entry, so the only trustworthy value is the one N-from-the-right, where N
// is the number of proxies we control (TRUSTED_PROXY_HOPS, default 1 — the
// host platform's reverse proxy). Hops=0 means direct exposure: ignore XFF
// entirely and use the socket address.
const TRUSTED_PROXY_HOPS = Math.max(0, parseInt(process.env.TRUSTED_PROXY_HOPS ?? '1', 10) || 0);
function clientIp(req) {
  if (TRUSTED_PROXY_HOPS > 0) {
    const xff = (req.headers['x-forwarded-for'] || '')
      .split(',').map(s => s.trim()).filter(Boolean);
    const idx = xff.length - TRUSTED_PROXY_HOPS;
    if (idx >= 0 && xff[idx]) return xff[idx];
  }
  return req.socket.remoteAddress || 'unknown';
}

function consumeRateToken(ip) {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(ip);
  if (!bucket) {
    bucket = { tokens: RATE_BUCKET_SIZE, lastRefill: now };
    rateLimitBuckets.set(ip, bucket);
  }
  const elapsed = now - bucket.lastRefill;
  const refill = Math.floor(elapsed / RATE_REFILL_MS);
  if (refill > 0) {
    bucket.tokens = Math.min(RATE_BUCKET_SIZE, bucket.tokens + refill);
    bucket.lastRefill += refill * RATE_REFILL_MS;
  }
  if (bucket.tokens <= 0) {
    const retryAfter = Math.ceil((RATE_REFILL_MS - (now - bucket.lastRefill)) / 1000);
    return { ok: false, retryAfter };
  }
  bucket.tokens -= 1;
  return { ok: true };
}

// Send a 429 with both the Retry-After header and an error message the client
// will recognize as a rate-limit (the portaltext runtime maps the string
// "rate limit" to its user-facing "Hit a rate limit." tooltip state).
function sendRateLimited(res, retryAfter) {
  res.writeHead(429, {
    'Content-Type': 'application/json',
    'Retry-After': String(retryAfter),
  });
  res.end(JSON.stringify({ error: `Rate limit reached, try again in ${retryAfter}s` }));
}

// Drop idle buckets every 10 minutes; anything not touched in 30 min is at
// full capacity anyway, no state to preserve. unref() keeps the timer from
// pinning the event loop open during shutdown.
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [ip, bucket] of rateLimitBuckets.entries()) {
    if (bucket.lastRefill < cutoff) rateLimitBuckets.delete(ip);
  }
}, 10 * 60 * 1000).unref();

// ---------- CORS ----------
// Set ALLOWED_ORIGINS=https://a.com,https://b.com to lock down. Default '*' is
// fine for the prototype since /summary holds no auth/cookies and the Anthropic
// key never leaves the server. Self-hosted adopters whose backend lives on a
// different origin from their site need this — without it, the browser blocks
// every cross-origin POST to /summary at the preflight stage.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*')
  .split(',').map(s => s.trim()).filter(Boolean);

function applyCors(req, res) {
  const reqOrigin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (reqOrigin && ALLOWED_ORIGINS.includes(reqOrigin)) {
    res.setHeader('Access-Control-Allow-Origin', reqOrigin);
    res.setHeader('Vary', 'Origin');
  } else {
    return; // origin not allowed → no CORS headers, browser will block
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Max-Age', '86400');
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');

    applyCors(req, res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      const html = await fs.readFile(path.join(__dirname, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // /staging was the pre-launch home of the redesigned site; it IS the
    // homepage now. Permanent redirect so old deep links (extension popup
    // builds before 0.3.0, shared URLs) land on the same content at /.
    if (req.method === 'GET' && (url.pathname === '/staging' || url.pathname === '/staging.html')) {
      // Fragments (#pricing) never reach the server; browsers re-attach
      // them to the redirect target automatically.
      res.writeHead(301, { Location: '/' });
      res.end();
      return;
    }

    if (req.method === 'GET' && url.pathname === '/robots.txt') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('User-agent: *\nAllow: /\n');
      return;
    }

    // Welcome page — opened by the extension popup the first time a user
    // signs in (popup.js tracks a welcome_shown flag in chrome.storage).
    // The page demonstrates each capability with real hoverable content;
    // the user's just-activated extension does the demonstrating.
    if (req.method === 'GET' && (url.pathname === '/welcome' || url.pathname === '/welcome.html')) {
      const html = await fs.readFile(path.join(__dirname, 'welcome.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Privacy policy — required by the Chrome Web Store for any extension
    // that handles user data. Referenced from the extension's listing.
    if (req.method === 'GET' && (url.pathname === '/privacy' || url.pathname === '/privacy.html')) {
      const html = await fs.readFile(path.join(__dirname, 'privacy.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && (url.pathname === '/supporter/thanks' || url.pathname === '/supporter/thanks.html')) {
      const html = await fs.readFile(path.join(__dirname, 'supporter-thanks.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    // The standalone runtime — drop-in `<script>` for any host page.
    if (req.method === 'GET' && url.pathname === '/portaltext.js') {
      try {
        const data = await fs.readFile(path.join(__dirname, 'portaltext.js'));
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-cache'
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    // Mozilla Readability shipped to the frontend so it can extract origin
    // context from the live document — same library the server uses for
    // destination extraction, so origin/destination go through one path.
    if (req.method === 'GET' && url.pathname === '/vendor/readability.js') {
      try {
        const data = await fs.readFile(path.join(__dirname, 'node_modules/@mozilla/readability/Readability.js'));
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'public, max-age=86400'
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    // Static images / icons living next to index.html
    if (req.method === 'GET' && /^\/(?:assets\/(?:[\w-]+\/)?)?[\w.-]+\.(png|jpg|jpeg|gif|svg|ico|webp)$/i.test(url.pathname)) {
      const filename = url.pathname.slice(1);
      try {
        const data = await fs.readFile(path.join(__dirname, filename));
        const ext = filename.split('.').pop().toLowerCase();
        const types = {
          png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
          gif: 'image/gif', svg: 'image/svg+xml',
          ico: 'image/x-icon', webp: 'image/webp'
        };
        res.writeHead(200, {
          'Content-Type': types[ext] || 'application/octet-stream',
          'Cache-Control': 'public, max-age=3600'
        });
        res.end(data);
      } catch {
        res.writeHead(404);
        res.end('Not found');
      }
      return;
    }

    // (Old demo-site routes — /article, /bible/*, /manifesto/*, /gutenberg/*,
    // /art/random, /code/std-doc — retired with the pre-launch demo page.)

    if (req.method === 'GET' && url.pathname === '/auth/me') {
      return handleAuthMe(req, res);
    }
    if (req.method === 'POST' && url.pathname === '/auth/anon') {
      const rate = consumeRateToken(clientIp(req));
      if (!rate.ok) return sendRateLimited(res, rate.retryAfter);
      return handleAuthAnon(req, res);
    }

    // ---- Supporter tier (Stripe) ----
    if (req.method === 'POST' && url.pathname === '/stripe/webhook') {
      return handleStripeWebhook(req, res);
    }
    if (req.method === 'GET' && url.pathname === '/supporter/checkout') {
      return handleSupporterCheckout(req, res, url);
    }
    if (req.method === 'GET' && url.pathname === '/supporter/code') {
      return handleSupporterCode(req, res, url);
    }
    if (req.method === 'POST' && url.pathname === '/supporter/redeem') {
      const rate = consumeRateToken(clientIp(req));
      if (!rate.ok) return sendRateLimited(res, rate.retryAfter);
      return handleSupporterRedeem(req, res);
    }

    if (req.method === 'GET' && url.pathname === '/etymology') {
      // No quota gate: Wiktionary is a free API and we cache aggressively,
      // so etymology calls don't cost us money. IP rate limit still applies
      // (shared bucket at the dispatcher level — see /summary, /annotate).
      const rate = consumeRateToken(clientIp(req));
      if (!rate.ok) return sendRateLimited(res, rate.retryAfter);
      const term = (url.searchParams.get('term') || '').trim();
      if (!term || term.length > 60 || /\s/.test(term)) {
        return sendJson(res, 400, { error: 'Single-word term required' });
      }
      try {
        const data = await fetchWiktionary(term);
        if (!data) return sendJson(res, 404, { error: 'No Wiktionary entry' });
        return sendJson(res, 200, data);
      } catch (err) {
        console.error('etymology fetch failed:', err.message);
        return sendJson(res, 502, { error: 'Wiktionary unreachable' });
      }
    }

    if (req.method === 'POST' && url.pathname === '/summary') {
      const rate = consumeRateToken(clientIp(req));
      if (!rate.ok) return sendRateLimited(res, rate.retryAfter);
      const gate = gateAiRequest(req, res);
      if (gate === null) return;
      let parsed;
      try {
        const body = await readBody(req);
        parsed = JSON.parse(body);
      } catch (err) {
        if (err?.statusCode === 413) return sendJson(res, 413, { error: 'Request body too large' });
        return sendJson(res, 400, { error: 'Bad JSON' });
      }
      const { target, url: outboundUrl, linkUrl, context, model: modelKey, prefetched, lang } = parsed;
      // tester is the usage-log label: authenticated user id, 'demo' for the
      // marketing-site try-before-install path, otherwise null (which would
      // log as 'anonymous' — that label is now reserved as an alarm bell for
      // genuine bypasses, since the gate rejects anonymous off-allowlist).
      const tester = gate.user?.id || (gate.isDemo ? 'demo' : null);
      // Refund the consumed credits if the model was never actually called.
      // res 'close' fires in every terminal state — cache hits (response
      // sent via res.end without invoking the model), aborts (client dropped
      // mid-fetch), and normal stream completion. The stream functions flip
      // abortToken.claudeStarted=true right before calling the model, so the
      // predicate cleanly distinguishes "we paid for AI" from "we didn't".
      // abortToken.closed marks the connection as gone — the stream
      // functions check it at the commit point so a disconnect during the
      // pre-model fetch phase doesn't refund AND then start a paid call.
      // The AbortController cancels an in-flight provider stream on
      // disconnect so we stop paying for tokens nobody will see.
      const abortToken = { claudeStarted: false, closed: false };
      const providerAbort = new AbortController();
      res.on('close', () => {
        abortToken.closed = true;
        if (!abortToken.claudeStarted) refundQuota(gate.user, gate.cost);
        providerAbort.abort();
      });
      if (outboundUrl) {
        await streamExternalSummary(outboundUrl, context, res, {
          linkUrl, modelKey, prefetched, tester, abortToken,
          user: gate.user,
          isPaid: userHasPaidAccess(gate.user),
          lang,
          signal: providerAbort.signal,
        });
        return;
      }
      if (!target) return sendJson(res, 400, { error: 'Missing target or url' });
      await streamSummary(target, context, res, {
        modelKey, tester, abortToken, lang,
        user: gate.user,
        isPaid: userHasPaidAccess(gate.user),
        signal: providerAbort.signal,
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/annotate') {
      const rate = consumeRateToken(clientIp(req));
      if (!rate.ok) return sendRateLimited(res, rate.retryAfter);
      // Annotation is open to every tier at a credit weight that reflects
      // its real cost (50K chars of input vs a tooltip's ~1K). Demo callers
      // (user null) don't have a credit balance to spend — keep them out.
      const gate = gateAiRequest(req, res, { cost: CREDIT_COSTS.annotate });
      if (gate === null) return;
      if (!gate.user) {
        refundQuota(gate.user, gate.cost); // no-op for null user; explicit for symmetry
        return sendJson(res, 401, { error: 'Install portaltext to annotate pages.', reason: 'auth_required' });
      }
      let parsed;
      try {
        const body = await readBody(req);
        parsed = JSON.parse(body);
      } catch (err) {
        if (err?.statusCode === 413) return sendJson(res, 413, { error: 'Request body too large' });
        return sendJson(res, 400, { error: 'Bad JSON' });
      }
      const { url: pageUrl, text, title: pageTitle } = parsed;
      if (!pageUrl || !text || typeof text !== 'string') {
        refundQuota(gate.user, gate.cost);
        return sendJson(res, 400, { error: 'Missing url or text' });
      }
      const tester = gate.user?.id || null;
      // Abort the provider call if the popup is dismissed mid-request.
      const providerAbort = new AbortController();
      res.on('close', () => providerAbort.abort());
      try {
        const { annotations, cached } = await getPageAnnotationsCached(
          pageUrl, text, pageTitle || '', tester, providerAbort.signal
        );
        // Cache hits cost nothing — give the credits back (same contract as
        // /summary's close-handler refund).
        if (cached) refundQuota(gate.user, gate.cost);
        return sendJson(res, 200, { annotations });
      } catch (err) {
        refundQuota(gate.user, gate.cost);
        console.error('Annotate error:', err.message);
        return sendJson(res, 502, { error: err.message });
      }
    }

    res.writeHead(404);
    res.end('Not found');
  } catch (err) {
    console.error('Server error:', err);
    res.writeHead(500);
    res.end('Server error');
  }
});

server.listen(PORT, () => {
  console.log(`portaltext running at http://localhost:${PORT}`);
});
