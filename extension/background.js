/*
 * background.js — service worker.
 *
 * Two responsibilities:
 *   1. On every page load check the disabled-domains list and inject the
 *      runtime if enabled. Disabled sites pay zero cost.
 *   2. Own all fetches to the /summary endpoint. Content scripts run in the
 *      page's origin (en.wikipedia.org, news.example.com, etc.) and would
 *      get blocked by CORS — the service worker has a chrome-extension://
 *      origin and uses host_permissions to bypass CORS entirely. The content
 *      script opens a long-lived port to ask for a summary; the worker fetches,
 *      parses the SSE stream, and forwards parsed events one by one.
 */

const DISABLED_KEY = 'disabledDomains';
// Single base for every backend call. Point at http://localhost:3000 to test
// the extension against a local server (keep popup.js's API_BASE in sync).
const API_BASE = 'https://portaltext.com';
const SUMMARY_ENDPOINT = `${API_BASE}/summary`;
const ANNOTATE_ENDPOINT = `${API_BASE}/annotate`;
const ETYMOLOGY_ENDPOINT = `${API_BASE}/etymology`;
const ANON_ENDPOINT = `${API_BASE}/auth/anon`;

// When the backend responds 401 (token revoked, session expired, password
// reset elsewhere), the cached auth blob in chrome.storage.local is dead.
// Clear it so the popup re-renders as signed-out next time it opens, rather
// than looping a "signed-in" UI behind a token the server won't honor.
// The next AI request self-heals: ensureAuthToken() registers a fresh
// anonymous identity when no token is present.
async function clearAuthIfUnauthorized(status) {
  if (status !== 401) return;
  try { await chrome.storage.local.remove(['authToken', 'authUser']); }
  catch { /* storage unavailable — popup will discover via /auth/me probe */ }
}

// Silent anonymous identity. portaltext is account-less by default: on
// install (and on any request that finds no token) the worker registers an
// anon identity with the backend and stores the returned bearer token. The
// token is the install's identity — quotas hang off it server-side exactly
// like an email account. Email sign-in (popup) simply overwrites authToken,
// and sign-out falls back to a fresh anon identity on next use.
//
// The in-flight promise dedupes concurrent callers (e.g. two hovers racing
// on a fresh install) so we don't mint two identities. Module-level state
// vanishes when the service worker idles — that's fine, the token lives in
// chrome.storage.
let anonRegInFlight = null;
async function ensureAuthToken() {
  const { authToken = '' } = await chrome.storage.local.get(['authToken']);
  if (authToken) return authToken;
  if (!anonRegInFlight) {
    anonRegInFlight = (async () => {
      try {
        const resp = await fetch(ANON_ENDPOINT, { method: 'POST' });
        if (!resp.ok) return '';
        const data = await resp.json().catch(() => null);
        if (!data?.token) return '';
        await chrome.storage.local.set({ authToken: data.token, authUser: data.user || null });
        console.log('[portaltext bg] anonymous identity registered');
        return data.token;
      } catch (err) {
        console.warn('[portaltext bg] anon registration failed:', err.message);
        return '';
      } finally {
        // Allow a retry on the next call if this attempt failed; on success
        // the storage read above short-circuits before we get here.
        anonRegInFlight = null;
      }
    })();
  }
  return anonRegInFlight;
}

// Hostnames we never inject on regardless of toggle state. These are either
// chrome's own pages (injection isn't allowed) or apps known to break or
// where link-preview tooltips are nonsensical (mail, video, music players,
// chatbots, login walls, adult content, etc.).
const ALWAYS_SKIP = new Set([
  // Chrome / extension store
  'chrome.google.com',
  'chromewebstore.google.com',
  // Chatbot / AI conversation UIs — hovers inside a chat thread don't make
  // sense; the conversation IS the content
  'chatgpt.com',
  'chat.openai.com',
  'gemini.google.com',
  'claude.ai',
  // Email / messaging — private content + login walls
  'mail.google.com',
  'outlook.live.com',
  'outlook.office.com',
  'live.com',
  'mail.ru',
  't.me',
  'web.telegram.org',
  'web.whatsapp.com',
  // Streaming UIs — title-only summaries aren't worth the noise
  'netflix.com',
  'www.netflix.com',
  'twitch.tv',
  'www.twitch.tv',
  'bilibili.com',
  'www.bilibili.com',
  // Cloud workspaces — auth-walled
  'm365.cloud.microsoft',
  'canva.com',
  'www.canva.com',
  // Shopping with patchwork DOM (Amazon-style problems)
  'temu.com',
  'www.temu.com',
  // Gambling
  'bet.br',
]);

// Hostname families we skip via pattern. Use these for sites with many
// regional TLDs / subdomains where listing them all in ALWAYS_SKIP would
// be tedious or incomplete.
const ALWAYS_SKIP_PATTERNS = [
  // Amazon: patchwork DOM across product / search / sponsored / widget
  // rails causes inconsistent tooltip behaviour. Matches every regional
  // TLD (amazon.com, amazon.co.uk, amazon.com.au, amazon.de, …) plus any
  // subdomain (www, m, smile, aws, …).
  /(^|\.)amazon\.[a-z]{2,3}(\.[a-z]{2,3})?$/i,
  // Adult content — tooltips inappropriate, source pages can surface
  // uncomfortable text in summaries.
  /(^|\.)pornhub\.com$/i,
  /(^|\.)xhamster\.com$/i,
  /(^|\.)xvideos\.com$/i,
  /(^|\.)xnxx\.com$/i,
  /(^|\.)stripchat\.com$/i,
];

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

function isInjectable(url) {
  if (!url) return false;
  return /^https?:/i.test(url);
}

async function getDisabledDomains() {
  const { [DISABLED_KEY]: list = [] } = await chrome.storage.local.get(DISABLED_KEY);
  return new Set(list);
}

async function maybeInject(tabId, url) {
  if (!isInjectable(url)) {
    console.log('[portaltext bg] skip (not http/s):', url);
    return;
  }
  const host = hostnameOf(url);
  if (!host || ALWAYS_SKIP.has(host) || ALWAYS_SKIP_PATTERNS.some(re => re.test(host))) {
    console.log('[portaltext bg] skip (always-skip):', host);
    return;
  }
  const disabled = await getDisabledDomains();
  if (disabled.has(host)) {
    console.log('[portaltext bg] skip (user-disabled):', host);
    return;
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['vendor/readability.js', 'vendor/purify.min.js', 'portaltext.js'],
    });
    console.log('[portaltext bg] injected into', host, 'tab', tabId);
  } catch (err) {
    console.warn('[portaltext bg] inject failed for', host, err.message);
  }
}

// Inject when a tab finishes loading. Also try on 'loading' as a fallback in
// case 'complete' never fires (some sites with long-tail subresource loads).
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status !== 'complete') return;
  console.log('[portaltext bg] onUpdated complete:', tab.url);
  maybeInject(tabId, tab.url);
});

// On install/update/startup, sweep already-open tabs so the user doesn't
// have to manually reload everything. tabs.onUpdated only fires on new
// navigations — without this, freshly-installed extensions appear inert
// on every tab the user already had open.
async function injectIntoAllOpenTabs(reason) {
  const tabs = await chrome.tabs.query({});
  console.log(`[portaltext bg] sweep on ${reason}: ${tabs.length} tabs`);
  for (const tab of tabs) {
    if (tab.id != null && tab.url) maybeInject(tab.id, tab.url);
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  injectIntoAllOpenTabs(`onInstalled (${details.reason})`);
  // Register the silent anon identity immediately so the first hover is
  // already authenticated. Fire-and-forget: if it fails (offline install),
  // the first AI request retries via ensureAuthToken.
  ensureAuthToken();
  // First-install welcome: open the welcome page in a new tab so users
  // immediately see the extension working. Only fires on reason === 'install'
  // — extension auto-updates pass reason === 'update' and we skip the
  // welcome tab to avoid hijacking the user's browser on every update.
  if (details.reason === 'install') {
    chrome.tabs.create({ url: 'https://portaltext.com/welcome' })
      // Mark welcome as seen so the popup's first-sign-in hook doesn't
      // open it a second time for users who later create an email account.
      .then(() => chrome.storage.local.set({ welcomeShown: true }))
      .catch(() => {});
  }
});
chrome.runtime.onStartup.addListener(() => {
  injectIntoAllOpenTabs('onStartup');
  ensureAuthToken();
});

console.log('[portaltext bg] service worker started');

// Context menu — appears only when there's a selection. On click we forward
// the selected text to the content script in the active tab, which wraps the
// live Range in a wikilink so the existing hover infrastructure picks it up.
function registerContextMenu() {
  try {
    chrome.contextMenus.removeAll(() => {
      chrome.contextMenus.create({
        id: 'portaltext-wrap-selection',
        title: 'Make hoverable with portaltext',
        contexts: ['selection']
      });
    });
  } catch (e) { /* contextMenus may be missing on first install before permissions resolve */ }
}
chrome.runtime.onInstalled.addListener(registerContextMenu);
chrome.runtime.onStartup.addListener(registerContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== 'portaltext-wrap-selection' || !tab?.id) return;
  chrome.tabs.sendMessage(tab.id, {
    type: 'pt-wrap-selection',
    text: info.selectionText || ''
  }).catch(() => { /* tab may have closed or content script not injected */ });
});

// Popup → worker messages: toggle current site, re-inject after enabling.
// 'ensure-auth' lets the popup route identity creation through the worker's
// deduped ensureAuthToken instead of racing it with its own fetch.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'reinject' && msg.tabId && msg.url) {
    maybeInject(msg.tabId, msg.url);
    sendResponse({ ok: true });
    return true;
  }
  if (msg?.type === 'ensure-auth') {
    ensureAuthToken().then((token) => sendResponse({ token })).catch(() => sendResponse({ token: '' }));
    return true;
  }
});

// Long-lived port for /summary streaming. Each port handles one summary
// request; the content script disconnects when the response is consumed
// (or the user dismisses the tooltip mid-stream).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pt-summary') return;
  let abortController = null;
  let disconnected = false;

  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (abortController) abortController.abort();
  });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'request') return;
    abortController = new AbortController();
    // Inject the user's chosen tooltip-model into every outgoing request.
    // Read from chrome.storage at request time so popup changes take effect
    // immediately without re-injecting any content scripts. authToken (if
    // present) goes on the Authorization header so the server can identify
    // the requester + enforce per-user quotas.
    const { modelPreference = 'fast' } =
      await chrome.storage.local.get(['modelPreference']);
    const authToken = await ensureAuthToken();
    const enrichedPayload = { ...msg.payload, model: modelPreference };
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const resp = await fetch(SUMMARY_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(enrichedPayload),
        signal: abortController.signal,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        await clearAuthIfUnauthorized(resp.status);
        if (!disconnected) port.postMessage({
          type: 'error',
          message: err.error || `Summary failed: ${resp.status}`,
          reason: err.reason || null,
          plan: err.plan || null,
        });
        try { port.disconnect(); } catch {}
        return;
      }
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (disconnected) { try { reader.cancel(); } catch {}; return; }
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n\n')) !== -1) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 2);
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6);
          if (data === '[DONE]') {
            if (!disconnected) port.postMessage({ type: 'done' });
            try { port.disconnect(); } catch {}
            return;
          }
          try {
            const event = JSON.parse(data);
            if (!disconnected) port.postMessage(event);
          } catch { /* skip malformed chunk */ }
        }
      }
      if (!disconnected) port.postMessage({ type: 'done' });
      try { port.disconnect(); } catch {}
    } catch (err) {
      if (err.name === 'AbortError') return; // user dismissed mid-stream, expected
      if (!disconnected) port.postMessage({ type: 'error', message: err.message || 'Summary fetch failed' });
      try { port.disconnect(); } catch {}
    }
  });
});

// One-shot port for credentialed page prefetch. Used by content script for
// paywall hosts (NYT etc.) where the server's anonymous fetch would only
// see the teaser. Service worker fetches with credentials:'include' attach
// the user's session cookies for the target host (regardless of which tab
// triggered the request — the SW has its own chrome-extension origin and
// uses the global cookie jar via host_permissions). We ship the raw HTML
// back to the content script, which runs Readability locally and includes
// the extracted text in the /summary request — so authenticated page
// content never crosses our servers.
const PREFETCH_MAX_BYTES = 1_500_000; // 1.5 MB upper bound; longer pages
                                       // would inflate Readability cost
                                       // and most articles are well under
const PREFETCH_TIMEOUT_MS = 8_000;
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pt-prefetch') return;
  let abortController = null;
  let disconnected = false;

  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (abortController) abortController.abort();
  });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'request' || !msg.url) return;
    abortController = new AbortController();
    const timeout = setTimeout(() => abortController.abort(), PREFETCH_TIMEOUT_MS);
    try {
      const resp = await fetch(msg.url, {
        method: 'GET',
        credentials: 'include',
        redirect: 'follow',
        signal: abortController.signal,
      });
      clearTimeout(timeout);
      if (!resp.ok) {
        if (!disconnected) port.postMessage({ type: 'error', message: `Fetch failed: ${resp.status}` });
        try { port.disconnect(); } catch {}
        return;
      }
      const ct = (resp.headers.get('content-type') || '').toLowerCase();
      if (!/^text\/html|application\/xhtml/.test(ct)) {
        if (!disconnected) port.postMessage({ type: 'error', message: `Non-HTML response (${ct})` });
        try { port.disconnect(); } catch {}
        return;
      }
      // Read with size cap. Reading the body as a buffer first lets us
      // truncate before utf-8 decode if the page is huge.
      const reader = resp.body.getReader();
      let total = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (disconnected) { try { reader.cancel(); } catch {}; return; }
        total += value.length;
        if (total > PREFETCH_MAX_BYTES) {
          try { reader.cancel(); } catch {}
          break;
        }
        chunks.push(value);
      }
      const merged = new Uint8Array(total > PREFETCH_MAX_BYTES ? PREFETCH_MAX_BYTES : total);
      let offset = 0;
      for (const c of chunks) {
        const room = merged.length - offset;
        if (room <= 0) break;
        const slice = c.length > room ? c.subarray(0, room) : c;
        merged.set(slice, offset);
        offset += slice.length;
      }
      const html = new TextDecoder('utf-8', { fatal: false }).decode(merged);
      if (!disconnected) port.postMessage({ type: 'html', html, finalUrl: resp.url });
    } catch (err) {
      clearTimeout(timeout);
      if (err.name === 'AbortError') {
        if (!disconnected) port.postMessage({ type: 'error', message: 'Prefetch timed out' });
      } else {
        if (!disconnected) port.postMessage({ type: 'error', message: err.message || 'Prefetch failed' });
      }
    }
    try { port.disconnect(); } catch {}
  });
});

// One-shot port for /annotate. Unlike /summary this isn't a stream — the
// server returns the full annotation list as a single JSON payload — but we
// still use a port so the user dismissing the popup mid-request aborts the
// fetch (and so we share the same chrome-extension origin / CORS bypass).
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pt-annotate') return;
  let abortController = null;
  let disconnected = false;

  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (abortController) abortController.abort();
  });

  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'request') return;
    abortController = new AbortController();
    const { modelPreference = 'fast' } =
      await chrome.storage.local.get(['modelPreference']);
    const authToken = await ensureAuthToken();
    const enrichedPayload = { ...msg.payload, model: modelPreference };
    const headers = { 'Content-Type': 'application/json' };
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const resp = await fetch(ANNOTATE_ENDPOINT, {
        method: 'POST',
        headers,
        body: JSON.stringify(enrichedPayload),
        signal: abortController.signal,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        await clearAuthIfUnauthorized(resp.status);
        if (!disconnected) port.postMessage({ type: 'error', message: err.error || `Annotate failed: ${resp.status}` });
      } else {
        const data = await resp.json().catch(() => ({}));
        if (!disconnected) port.postMessage({ type: 'annotations', annotations: data.annotations || [] });
      }
      try { port.disconnect(); } catch {}
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!disconnected) port.postMessage({ type: 'error', message: err.message || 'Annotate fetch failed' });
      try { port.disconnect(); } catch {}
    }
  });
});

// One-shot port for /etymology. Triggered only when the user clicks the
// etymology arrow on a single-word tooltip — never as part of normal hover.
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'pt-etymology') return;
  let abortController = null;
  let disconnected = false;
  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (abortController) abortController.abort();
  });
  port.onMessage.addListener(async (msg) => {
    if (msg?.type !== 'request' || !msg.term) return;
    abortController = new AbortController();
    const authToken = await ensureAuthToken();
    const headers = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    try {
      const resp = await fetch(`${ETYMOLOGY_ENDPOINT}?term=${encodeURIComponent(msg.term)}`, {
        signal: abortController.signal,
        headers,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}));
        await clearAuthIfUnauthorized(resp.status);
        if (!disconnected) port.postMessage({ type: 'error', message: err.error || `Etymology failed: ${resp.status}`, status: resp.status });
      } else {
        const data = await resp.json().catch(() => null);
        if (!disconnected) port.postMessage({ type: 'etymology', data });
      }
      try { port.disconnect(); } catch {}
    } catch (err) {
      if (err.name === 'AbortError') return;
      if (!disconnected) port.postMessage({ type: 'error', message: err.message || 'Etymology fetch failed' });
      try { port.disconnect(); } catch {}
    }
  });
});
