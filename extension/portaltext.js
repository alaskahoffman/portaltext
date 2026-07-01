/*
 * portaltext.js — extension build.
 *
 * Differences from the standalone runtime in /portaltext.js:
 *   1. /summary fetches go through the service worker via chrome.runtime.connect
 *      instead of direct fetch(). The worker has chrome-extension:// origin and
 *      bypasses CORS via host_permissions; content scripts run in the page's
 *      origin (en.wikipedia.org, etc.) and would be blocked. The worker also
 *      parses the SSE stream, forwarding typed events back over the port.
 *   2. PLAIN_ANCHORS is forced on so every <a href> on every site becomes
 *      hoverable. Pages opt individual anchors out with class="no-portaltext"
 *      or `data-portaltext="off"` on an ancestor.
 *   3. Re-injection guard at top — chrome.scripting.executeScript can re-fire
 *      on SPA navigations, and we don't want duplicate event listeners.
 */
(function () {
  'use strict';

  // Re-injection guard. The isolated-world `window` persists across script
  // injections within the same document, so this prevents duplicate listeners.
  if (window.__portaltextLoaded) {
    console.log('[portaltext] runtime already loaded, skipping');
    return;
  }
  // Embedded-runtime guard. Pages that ship the standalone runtime
  // (portaltext.com's own live demo) mark the document; the page script
  // runs in the main world so a window flag is invisible here, but the DOM
  // is shared. Without this, hovers on such pages get two tooltips.
  if (document.documentElement?.dataset?.portaltextEmbedded) {
    console.log('[portaltext] embedded runtime present, extension standing down');
    return;
  }
  window.__portaltextLoaded = true;
  console.log('[portaltext] runtime loaded on', location.href);

  // ----- Configuration -----
  // SUMMARY_ENDPOINT lives in background.js (the worker owns all fetches).
  const PLAIN_ANCHORS = true;
  let requireCtrlToActivate = false;

  chrome.storage.local.get('requireCtrlToActivate').then(({ requireCtrlToActivate: value }) => {
    requireCtrlToActivate = value === true;
  }).catch(() => { /* keep the default hover-only behavior */ });

  // ----- Live enable/disable -----
  // The popup writes to chrome.storage.local["disabledDomains"] when the
  // user toggles a site off. We mirror that state into a local flag and
  // listen for changes, so toggling takes effect immediately without
  // requiring a refresh. When disabled mid-session, any open tooltips are
  // torn down so the page returns to its plain reading state instantly.
  const PORTALTEXT_HOST = location.hostname.toLowerCase();
  let portaltextEnabled = true;
  chrome.storage.local.get('disabledDomains').then(({ disabledDomains = [] }) => {
    portaltextEnabled = !disabledDomains.includes(PORTALTEXT_HOST);
  }).catch(() => { /* keep default true */ });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.disabledDomains) {
      const next = !(changes.disabledDomains.newValue || []).includes(PORTALTEXT_HOST);
      if (next !== portaltextEnabled) {
        portaltextEnabled = next;
        if (!next && typeof closeAllTooltips === 'function') closeAllTooltips();
      }
    }
    if (changes.preferredLanguage) {
      preferredLanguage = changes.preferredLanguage.newValue || 'auto';
    }
    if (changes.requireCtrlToActivate) {
      requireCtrlToActivate = changes.requireCtrlToActivate.newValue === true;
      if (requireCtrlToActivate && !ctrlActivationHeld && openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
    }
  });

  // User's preferred language for tooltip output. Read from chrome.storage
  // .local; sent with every /summary request as `lang`. 'auto' (default)
  // means the server picks based on source content / English fallback.
  let preferredLanguage = 'auto';
  chrome.storage.local.get('preferredLanguage').then(({ preferredLanguage: pl }) => {
    if (pl) preferredLanguage = pl;
  }).catch(() => { /* keep default */ });

  // ----- Styles -----
  // Two style sheets:
  //   PAGE_STYLES — injected once into document.head. Targets in-page DOM:
  //     hover-active outlines on triggers, fade-in animations on annotations
  //     applied directly to host page anchors.
  //   TOOLTIP_STYLES — copied into each tooltip's shadow root. Page CSS can't
  //     reach inside a shadow DOM, so this style sheet is the ONLY thing
  //     styling the tooltip — fully isolated from whatever the host site
  //     does to <h3> / <p> / etc. globally.
  const PAGE_STYLES = `
@keyframes portaltext-linkFadeIn {
  from { color: inherit; }
  to   { color: var(--portaltext-link, #5a8a1f); }
}
a.wikilink, a.extlink {
  color: var(--portaltext-link, #5a8a1f);
  text-decoration: none;
  cursor: pointer;
}
a.wikilink:hover, a.extlink:hover {
  color: var(--portaltext-link-hover, #5a8a1f);
  text-decoration: underline;
}
a.wikilink.active, a.extlink.active {
  background: var(--portaltext-active-bg, rgba(6, 69, 173, 0.10));
  border-radius: 0;
}
a.extlink::after {
  content: ' ↗';
  font-size: 0.85em;
  color: var(--portaltext-muted, #54595d);
  text-decoration: none;
}
a.wikilink.portaltext-fade-in,
a.extlink.portaltext-fade-in {
  animation: portaltext-linkFadeIn 800ms ease-out;
}
img.active {
  outline: 2px solid var(--portaltext-link, #5a8a1f);
  outline-offset: 2px;
}
`;

  // Hand-drawn spinner SVGs live inside the extension bundle and must be
  // referenced via chrome-extension:// URLs from inside the page context.
  // Resolved once at module init; baked into TOOLTIP_STYLES below.
  const SPINNER_URLS = {
    small:  chrome.runtime.getURL('assets/handdrawn-34.svg'),
    medium: chrome.runtime.getURL('assets/handdrawn-31.svg'),
    big:    chrome.runtime.getURL('assets/handdrawn-29.svg'),
  };
  const LOCK_URL = chrome.runtime.getURL('assets/handdrawn-25.svg');

  const TOOLTIP_STYLES = `
:host { all: initial; }
.tooltip {
  position: fixed;
  z-index: 1000;
  width: 340px;
  max-width: 92vw;
  background: var(--portaltext-bg, #ffffff);
  color: var(--portaltext-fg, #202122);
  font-family: var(--portaltext-font, -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif);
  border: 1px solid var(--portaltext-border, #a2a9b1);
  border-radius: 0;
  box-shadow: var(--portaltext-shadow, 0 6px 24px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08));
  padding: 14px 16px 12px;
  font-size: 14px;
  line-height: 1.5;
  opacity: 0;
  transform: translateY(-4px);
  transition: opacity 200ms ease, transform 160ms ease;
  pointer-events: auto;
}
.tooltip.visible { opacity: 1; transform: translateY(0); }
.tooltip h3 {
  /* Reserve the right gutter for the absolutely-positioned action icons
     (lock at right:10, etym at right:36, save at right:36 or right:62
     when both are present — leftmost icon edge sits around 80px from the
     tooltip's right border). Padding here forces the title to wrap before
     it collides; the body below uses the full content width unchanged. */
  margin: 0 0 6px;
  padding-right: 80px;
  font-family: var(--portaltext-heading-font, "Linux Libertine", Georgia, serif);
  font-size: 17px;
  font-weight: 400;
  color: inherit;
  line-height: 1.25;
  word-wrap: break-word;
  overflow-wrap: break-word;
}
.tooltip .body { font-size: 13.5px; }
.tooltip .body p { margin: 0 0 14px; }
.tooltip .body p:last-child { margin-bottom: 0; }
.tooltip[data-depth="1"] { box-shadow: 0 8px 28px rgba(0,0,0,0.20), 0 3px 8px rgba(0,0,0,0.10); }
.tooltip[data-depth="2"] { box-shadow: 0 10px 32px rgba(0,0,0,0.22), 0 4px 10px rgba(0,0,0,0.12); }
.tooltip[data-depth="3"] { box-shadow: 0 12px 36px rgba(0,0,0,0.24), 0 5px 12px rgba(0,0,0,0.14); }
/* Locked state — a small hand-drawn lock icon pinned in the
   leftmost slot of the top-right icon row. Hidden until .locked is added. */
.tooltip::after {
  content: '';
  position: absolute;
  top: 10px;
  right: 62px;
  width: 22px;
  height: 22px;
  background-image: url('${LOCK_URL}');
  background-size: contain;
  background-repeat: no-repeat;
  background-position: center;
  opacity: 0;
  transition: opacity 180ms ease;
  pointer-events: none;
}
.tooltip.locked::after { opacity: 1; }
/* Etymology arrow button — shown only on single-word non-external tooltips.
   Rightmost slot in the top-right icon row. */
.pt-etym-btn {
  position: absolute;
  top: 10px;
  right: 10px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 160ms ease, color 160ms ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  color: inherit;
}
.pt-etym-btn:hover { opacity: 1; }
.pt-etym-btn svg { width: 20px; height: 20px; display: block; }
.pt-etym-btn.active { opacity: 1; color: var(--portaltext-link, #5a8a1f); }
/* Save (star) button — middle slot in the top-right icon row. Filled = saved. */
.pt-save-btn {
  position: absolute;
  top: 10px;
  right: 36px;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  background: transparent;
  cursor: pointer;
  opacity: 0.55;
  transition: opacity 160ms ease, transform 200ms ease;
  display: flex;
  align-items: center;
  justify-content: center;
  font: inherit;
  color: inherit;
}
.pt-save-btn:hover { opacity: 1; }
.pt-save-btn svg { width: 18px; height: 18px; display: block; }
.pt-save-btn.saved { opacity: 1; color: var(--portaltext-link, #5a8a1f); }
.pt-save-btn.saved svg { transform: scale(1.1); }
.pt-save-btn.flash { animation: pt-save-flash 320ms ease-out; }
@keyframes pt-save-flash {
  0%   { transform: scale(1); }
  40%  { transform: scale(1.4); }
  100% { transform: scale(1); }
}
/* Etymology view — definitions list + tree of ancestors. */
.tooltip .body.etymology .pt-etym-defs { margin: 0 0 14px; padding: 0; list-style: none; }
.tooltip .body.etymology .pt-etym-def { margin: 0 0 6px; }
.tooltip .body.etymology .pt-etym-pos {
  font-style: italic;
  color: var(--portaltext-muted, #54595d);
  margin-right: 6px;
  font-size: 12px;
}
.tooltip .body.etymology .pt-etym-tree-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--portaltext-muted, #54595d);
  margin: 0 0 8px;
}
.tooltip .body.etymology .pt-etym-tree {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0;
}
.tooltip .body.etymology .pt-etym-node {
  border: 1px solid var(--portaltext-border, #a2a9b1);
  padding: 6px 10px;
  background: var(--portaltext-bg-soft, #f8f9fa);
  text-align: center;
  font-size: 13px;
  max-width: 100%;
}
.tooltip .body.etymology .pt-etym-node .pt-etym-lang {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: var(--portaltext-muted, #54595d);
  margin-bottom: 2px;
}
.tooltip .body.etymology .pt-etym-node .pt-etym-word { font-weight: 500; }
.tooltip .body.etymology .pt-etym-header-ipa {
  font-family: -apple-system, BlinkMacSystemFont, sans-serif;
  font-size: 13px;
  color: var(--portaltext-muted, #54595d);
  margin: 0 0 8px;
}
.tooltip .body.etymology .pt-etym-node .pt-etym-gloss {
  font-style: italic;
  color: var(--portaltext-muted, #54595d);
  font-size: 12px;
  margin-top: 2px;
}
.tooltip .body.etymology .pt-etym-edge {
  width: 1px;
  height: 14px;
  background: var(--portaltext-border, #a2a9b1);
}
.tooltip .body.etymology .pt-etym-node-wrap {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.tooltip .body.etymology .pt-etym-children {
  display: flex;
  flex-direction: column;
  align-items: center;
}
.tooltip .body.etymology .pt-etym-children.branching {
  flex-direction: row;
  align-items: flex-start;
  justify-content: center;
  gap: 8px;
  position: relative;
  padding-top: 14px;
}
.tooltip .body.etymology .pt-etym-children.branching::before {
  content: '';
  position: absolute;
  top: 0;
  left: 25%;
  right: 25%;
  height: 1px;
  background: var(--portaltext-border, #a2a9b1);
}
.tooltip .body.etymology .pt-etym-children.branching > .pt-etym-node-wrap::before {
  content: '';
  display: block;
  width: 1px;
  height: 14px;
  background: var(--portaltext-border, #a2a9b1);
  margin: -14px auto 0;
}
.tooltip[data-theme="dark"] .body.etymology .pt-etym-children.branching::before,
.tooltip[data-theme="dark"] .body.etymology .pt-etym-children.branching > .pt-etym-node-wrap::before {
  background: #3a4a5a;
}
.tooltip .body.etymology .pt-etym-text {
  font-size: 12.5px;
  color: var(--portaltext-fg, #202122);
  line-height: 1.45;
}
.tooltip .body.etymology .pt-etym-from {
  font-size: 11px;
  color: var(--portaltext-muted, #54595d);
  margin: 0 0 10px;
  font-style: italic;
}
/* Dark theme overrides for the etymology view. */
.tooltip[data-theme="dark"] .body.etymology .pt-etym-pos,
.tooltip[data-theme="dark"] .body.etymology .pt-etym-tree-label,
.tooltip[data-theme="dark"] .body.etymology .pt-etym-from,
.tooltip[data-theme="dark"] .body.etymology .pt-etym-header-ipa,
.tooltip[data-theme="dark"] .body.etymology .pt-etym-node .pt-etym-lang,
.tooltip[data-theme="dark"] .body.etymology .pt-etym-node .pt-etym-gloss {
  color: #b8b09e;
}
.tooltip[data-theme="dark"] .body.etymology .pt-etym-node {
  background: rgba(255, 255, 255, 0.04);
  border-color: #3a4a5a;
  color: #f4ede0;
}
.tooltip[data-theme="dark"] .body.etymology .pt-etym-text {
  color: #f4ede0;
}
.tooltip[data-theme="dark"] .body.etymology .pt-etym-edge {
  background: #3a4a5a;
}
/* Hand-drawn three-circle spinner. Fills the tooltip body while we wait
   for the first stream delta, then fades out as text begins to flow. */
.tooltip .loading {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 88px;
  transition: opacity 220ms ease-out;
}
.tooltip .loading.fading-out { opacity: 0; }
.pt-spinner {
  position: relative;
  display: inline-block;
  width: 72px;
  height: 72px;
}
.pt-spinner-frame {
  position: absolute;
  left: 50%;
  top: 50%;
  transform: translate(-50%, -50%);
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
  opacity: 0;
  animation: pt-spinner-pulse 1.2s infinite;
}
.pt-spinner-small  { width: 26px; height: 26px; background-image: url('${SPINNER_URLS.small}');  animation-delay: 0s;   }
.pt-spinner-medium { width: 50px; height: 50px; background-image: url('${SPINNER_URLS.medium}'); animation-delay: 0.4s; }
.pt-spinner-big    { width: 72px; height: 72px; background-image: url('${SPINNER_URLS.big}');    animation-delay: 0.8s; }
@keyframes pt-spinner-pulse {
  0%, 33%   { opacity: 1; }
  34%, 100% { opacity: 0; }
}
.tooltip .error { color: var(--portaltext-error, #c00); font-size: 13px; }
/* Errors are styled as quiet footnotes rather than failure modals — italic,
   muted, smaller. Conveys "this link isn't summarizable" instead of
   "something broke, try again". */
.tooltip .tt-error {
  color: var(--portaltext-muted, #54595d);
  font-size: 12.5px;
  font-style: italic;
  line-height: 1.45;
}
/* Quota-exhausted state — replaces the generic error footnote with a
   warmer "come back tomorrow" page including the sleeping-cat asset. */
.tooltip .tt-quota-out {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 4px 0;
}
.tooltip .tt-quota-cat {
  width: 96px;
  height: 96px;
  color: var(--portaltext-link, #5a8a1f);
  margin-bottom: 10px;
}
.tooltip .tt-quota-cat svg { width: 100%; height: 100%; display: block; }
.tooltip .tt-quota-heading {
  margin: 0 0 6px;
  font-size: 14px;
  font-weight: 600;
  color: inherit;
}
.tooltip .tt-quota-body {
  margin: 0;
  font-size: 12.5px;
  color: var(--portaltext-muted, #54595d);
  line-height: 1.45;
}
.tooltip a.tt-quota-upgrade {
  color: var(--portaltext-link, #5a8a1f);
  text-decoration: none;
  border-bottom: 1px dotted rgba(90, 138, 31, 0.5);
}
.tooltip a.tt-quota-upgrade:hover { border-bottom-style: solid; }
.tooltip a.wikilink, .tooltip a.extlink {
  color: var(--portaltext-link, #5a8a1f);
  text-decoration: none;
  cursor: pointer;
}
.tooltip a.wikilink:hover, .tooltip a.extlink:hover {
  color: var(--portaltext-link-hover, #5a8a1f);
  text-decoration: underline;
}
.tooltip a.extlink::after {
  content: ' ↗';
  font-size: 0.85em;
  color: var(--portaltext-muted, #54595d);
  text-decoration: none;
}
@keyframes portaltext-linkFadeIn {
  from { color: inherit; }
  to   { color: var(--portaltext-link, #5a8a1f); }
}
.tooltip .body.just-finalized a.wikilink,
.tooltip .body.just-finalized a.extlink {
  animation: portaltext-linkFadeIn 500ms ease-out;
}
/* Dark theme override — only bg and text color, nothing else. */
.tooltip[data-theme="dark"] {
  background: #15202B;
  color: #f4ede0;
}
`;

  function injectPageStyles() {
    const style = document.createElement('style');
    style.setAttribute('data-portaltext', '');
    style.textContent = PAGE_STYLES;
    document.head.appendChild(style);
  }

  if (document.head) injectPageStyles();
  else document.addEventListener('DOMContentLoaded', injectPageStyles, { once: true });

  // ----- Theme tracking -----
  // The popup's dark/light setting is mirrored onto every tooltip
  // we open (data-theme attribute), so the tooltip background and
  // text invert when the user enables dark mode. Listens to storage
  // changes so an already-open tooltip swaps if the user toggles
  // while one is showing.
  let currentTheme = 'light';
  function applyThemeToOpenTooltips() {
    document.querySelectorAll('[data-portaltext-host]').forEach(host => {
      const tip = host.shadowRoot && host.shadowRoot.querySelector('.tooltip');
      if (tip) tip.dataset.theme = currentTheme;
    });
  }
  try {
    chrome.storage.local.get('theme').then(({ theme }) => {
      currentTheme = theme === 'dark' ? 'dark' : 'light';
      applyThemeToOpenTooltips();
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === 'local' && changes.theme) {
        currentTheme = changes.theme.newValue === 'dark' ? 'dark' : 'light';
        applyThemeToOpenTooltips();
      }
    });
  } catch {}

  // ----- Utilities (private) -----
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function hostnameOf(url) {
    try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
  }

  // Strip HTML tags (including a trailing partial tag) for text-only display
  // during streaming. We avoid rendering as HTML mid-stream because doing so
  // would constantly recreate <a> children — detaching their refs and breaking
  // trigger positioning when a child tooltip opens from one of them.
  function stripTagsForStream(html) {
    return html
      .replace(/<[^>]*>/g, '')   // complete tags
      .replace(/<[^>]*$/, '');   // partial tag at end of buffer
  }

  // Defense-in-depth: server returns AI-generated HTML which the prompt
  // restricts to a small vocabulary, but we still sanitize before injection
  // so a server compromise or model misbehaviour can't drop scripts /
  // event handlers / javascript: URLs into the user's pages. Allowlist
  // matches what buildPrompt emits: light prose tags plus our two anchor
  // classes carrying data-term / data-url.
  const PT_SANITIZE_CONFIG = {
    ALLOWED_TAGS: ['a', 'em', 'strong', 'i', 'b', 'p', 'br', 'h3', 'ul', 'ol', 'li', 'span'],
    ALLOWED_ATTR: ['class', 'href', 'data-term', 'data-url', 'title'],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:)/i,
  };
  function sanitizeTooltipHtml(html) {
    if (typeof DOMPurify === 'undefined' || !DOMPurify.sanitize) {
      // Fail closed: if the sanitizer didn't load, render escaped text
      // rather than raw HTML.
      return escapeHtml(html);
    }
    return DOMPurify.sanitize(html, PT_SANITIZE_CONFIG);
  }

  // ----- Anchor classification -----
  // Two-step process: findHoverable() decides whether a click target activates
  // the runtime at all (explicit classes always; plain <a href> only in plain mode
  // and not opted out). classify() decides whether to send {target} (Wikipedia
  // path) or {url} (Readability path) to /summary.
  const WIKI_NAMESPACES = /^(Special|File|Category|Help|Wikipedia|Portal|Talk|User|Template|MediaWiki):/i;

  function isHoverableImage(img) {
    if (!img || img.tagName !== 'IMG') return false;
    if (img.classList.contains('no-portaltext')) return false;
    if (img.closest('[data-portaltext="off"]')) return false;
    // currentSrc reflects what the browser actually loaded (handles srcset/picture).
    const raw = img.currentSrc || img.getAttribute('src');
    if (!raw) return false;
    if (/^(data|blob):/i.test(raw)) return false;
    let u;
    try { u = new URL(raw, location.href); } catch { return false; }
    if (!/^https?:/i.test(u.protocol)) return false;
    // Server's vision path only accepts jpeg/png/gif/webp.
    if (/\.svg(\?|#|$)/i.test(u.pathname)) return false;
    // Skip likely UI chrome — favicons, spacer GIFs, icon strips. 80px on either
    // side is a rough cutoff between "decorative" and "actually a picture".
    const r = img.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) return false;
    return true;
  }

  // Some sites (Instagram feed posts, Pinterest, news mosaic layouts) render
  // hero images as CSS background-image on a <div> rather than <img>. Returns
  // the absolute URL if the element has a usable background-image, else null.
  // The URL is associated with the element via WeakMap so classify() can find
  // it without mutating the DOM.
  const bgUrlForEl = new WeakMap();
  // When findHoverable resolves an image-inside-a-link, remember the link's
  // destination URL so the /summary request can carry it along. Server fetches
  // the linked page in parallel and feeds its text to the vision prompt as
  // supplemental context (Pinterest pin → source blog post, etc.).
  const linkUrlForImage = new WeakMap();

  // Unwrap known link-wrapper / redirector URLs to the real destination.
  // Instagram, Facebook, Google search results, etc. wrap outbound links in
  // their own tracking redirector — the visible href is to e.g.
  // l.instagram.com/?u=<encoded> rather than the actual destination. We
  // unwrap so:
  //   1. The external-only filter sees the real destination's hostname.
  //   2. The server fetches the real destination's content for the tooltip,
  //      not the redirector's empty interstitial page.
  // Opaque shorteners (t.co, lnkd.in, bit.ly) need an HTTP HEAD to resolve
  // and are out of scope here — they pass through unchanged.
  function unwrapRedirector(href) {
    let u;
    try { u = new URL(href, location.href); } catch { return href; }
    const host = u.hostname.toLowerCase();
    // Meta family: ?u=<encoded>
    if (host === 'l.instagram.com' || host === 'l.facebook.com' || host === 'lm.facebook.com') {
      const inner = u.searchParams.get('u');
      if (inner) return inner;
    }
    // Google search redirect: /url?q=<encoded> or /url?url=<encoded>
    if (host === 'www.google.com' && u.pathname === '/url') {
      return u.searchParams.get('q') || u.searchParams.get('url') || href;
    }
    // YouTube external link: /redirect?q=<encoded>
    if ((host === 'www.youtube.com' || host === 'youtube.com') && u.pathname === '/redirect') {
      return u.searchParams.get('q') || href;
    }
    return href;
  }

  // Hosts whose URLs are "wrappers" — the link target is the real content
  // and any inner image is auxiliary (an auto-generated thumbnail). When one
  // of these wraps an inner image, the user wants a summary of what the link
  // goes TO, not a description of the thumbnail.
  //
  // Two flavors here:
  //   - Opaque shorteners (t.co): the destination is hidden behind a redirect.
  //     Server-side SHORTENER_HOSTS resolves the t.co interstitial.
  //   - Video / preview platforms (YouTube): the destination is in the URL,
  //     but the inner image is a generated thumbnail for the linked video,
  //     not standalone content. The user's intent on hovering a recommended-
  //     video card is "what's that video about?", not "describe the image".
  const SHORTENER_HOSTS = new Set(['t.co']);
  const VIDEO_PLATFORM_HOSTS = new Set([
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'
  ]);
  function linkIsShortener(absoluteUrl) {
    try {
      return SHORTENER_HOSTS.has(new URL(absoluteUrl).hostname.toLowerCase());
    } catch { return false; }
  }
  function linkPrefersImageDeferral(absoluteUrl) {
    let h;
    try { h = new URL(absoluteUrl).hostname.toLowerCase(); } catch { return false; }
    return SHORTENER_HOSTS.has(h) || VIDEO_PLATFORM_HOSTS.has(h);
  }

  // True when the element has a same-tree <a> ancestor whose href resolves to
  // a wrapper host (shortener or video platform). Used to defer image-pass
  // matches to the link branch — Twitter card previews (t.co), YouTube
  // recommended-video sidebars (youtube.com/watch?v=...), etc.
  function imageHasDeferralLinkAncestor(el) {
    const anchor = el?.closest?.('a[href]');
    if (!anchor) return false;
    let u;
    try { u = new URL(anchor.getAttribute('href'), location.href); } catch { return false; }
    return linkPrefersImageDeferral(u.toString());
  }

  // Per-host external-only filter. On these sites, only fire tooltips for
  // destinations that leave the site — the user is already looking at the
  // internal content directly, hover-previewing it would be noise. Failures
  // are silent (no tooltip, no error message), distinct from UNSUPPORTED_HOSTS
  // which surfaces a "doesn't allow link previews" tooltip on the destination.
  //
  // Add entries here as needed. `internal` covers both the site itself and
  // its known CDN aliases (image hosts, asset domains).
  // appliesTo controls which trigger types the filter blocks:
  //   'all'   — both link and image triggers (Instagram: silent for everything
  //              internal, since the user is directly viewing the feed)
  //   'links' — only link triggers; images stay hoverable regardless of
  //              source (Twitter: tweet permalinks/profiles silent, but tweet
  //              photo hovers still produce vision-based identification)
  const EXTERNAL_ONLY_HOSTS = [
    {
      appliesTo: 'all',
      isCurrentSite: (h) => h === 'instagram.com' || h.endsWith('.instagram.com'),
      isInternal: (h) =>
        h === 'instagram.com' || h.endsWith('.instagram.com') ||
        h === 'cdninstagram.com' || h.endsWith('.cdninstagram.com') ||
        h === 'fbcdn.net' || h.endsWith('.fbcdn.net'),
    },
    {
      // Twitter / X. Filter LINKS only — tweet-permalink links and in-site nav
      // are silent, but image hovers (tweet photos, embedded media on
      // pbs.twimg.com) still fire the vision identifier. t.co is intentionally
      // NOT internal so tweet-text external links keep producing tooltips
      // (server resolves the t.co interstitial to its real destination).
      appliesTo: 'links',
      isCurrentSite: (h) =>
        h === 'twitter.com' || h.endsWith('.twitter.com') ||
        h === 'x.com' || h.endsWith('.x.com'),
      isInternal: (h) =>
        h === 'twitter.com' || h.endsWith('.twitter.com') ||
        h === 'x.com' || h.endsWith('.x.com'),
    },
  ];

  function destinationIsInternalToCurrentSite(destUrl) {
    const currentHost = location.hostname.toLowerCase();
    const filter = EXTERNAL_ONLY_HOSTS.find(f => f.isCurrentSite(currentHost));
    if (!filter) return false;
    let destHost;
    try { destHost = new URL(destUrl, location.href).hostname.toLowerCase(); } catch { return false; }
    return filter.isInternal(destHost);
  }

  // Resolves the "effective destination" of a hover candidate so the per-host
  // filter has one URL to test against. For image-inside-a-link, the LINK
  // destination wins (an external recipe-blog link wrapping an internal
  // CDN image should still preview — the user is asking about the link).
  function destinationUrlOf(candidate) {
    // For image-shaped triggers (IMG or bg-image div), use the image's own URL
    // for filter purposes — the image itself is the "destination" being
    // identified, regardless of any wrapping link. linkUrlForImage stays
    // around as supplemental context for the server, just not for filtering.
    if (candidate?.tagName === 'IMG') {
      return candidate.currentSrc || candidate.getAttribute('src') || null;
    }
    const bg = bgUrlForEl.get(candidate);
    if (bg) return bg;
    if (candidate?.tagName === 'A') {
      const href = candidate.getAttribute('href');
      return href ? unwrapRedirector(href) : null;
    }
    return null;
  }
  // Tags that commonly carry decorative page-level background-images (themed
  // wikis, marketing sites). Treating these as image triggers makes every
  // mouseover match the same page-wide element — tooltip pops up in the
  // upper-left covering the whole page, re-opens after every Esc, and
  // describes the entire page as if it were a single image.
  const BG_IGNORE_TAGS = new Set(['BODY', 'HTML', 'MAIN', 'ARTICLE', 'SECTION', 'HEADER', 'FOOTER', 'ASIDE', 'NAV']);
  function getBackgroundImageUrl(el) {
    if (!el || el.nodeType !== 1) return null;
    if (BG_IGNORE_TAGS.has(el.tagName)) return null;
    if (el.classList?.contains('no-portaltext')) return null;
    if (el.closest?.('[data-portaltext="off"]')) return null;
    let cs;
    try { cs = getComputedStyle(el); } catch { return null; }
    const bg = cs?.backgroundImage;
    if (!bg || bg === 'none') return null;
    // backgroundImage may stack multiple values + gradients; pick the first url(...)
    const m = bg.match(/url\(["']?([^"')]+)["']?\)/);
    if (!m) return null;
    const raw = m[1];
    if (/^(data|blob):/i.test(raw)) return null;
    let u;
    try { u = new URL(raw, location.href); } catch { return null; }
    if (!/^https?:/i.test(u.protocol)) return null;
    if (/\.svg(\?|#|$)/i.test(u.pathname)) return null;
    const r = el.getBoundingClientRect();
    if (r.width < 80 || r.height < 80) return null;
    // Reject elements that fill most of the viewport — almost certainly a
    // page-level decorative background (themed wiki backdrop, hero banner),
    // not a hoverable content image. Catches generic <div> wrappers that
    // semantic-tag filtering above would miss.
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (vw > 0 && vh > 0 && r.width > vw * 0.8 && r.height > vh * 0.8) return null;
    return u.toString();
  }

  // Public entry point. Resolves the inner candidate, then runs three filters:
  //   1. Page-chrome filter (universal): skip links/images inside semantic
  //      site chrome — <header>/<footer>/<nav>/<aside> or their ARIA roles.
  //      The reader rarely wants a tooltip on a "Home" / "Contact" / search
  //      / language-switcher / cookie-policy link.
  //   2. Unsummarizable-URL filter (universal): skip URL patterns that have
  //      no useful summary signal — YouTube Shorts (clickbait titles, no
  //      descriptions). Easy to extend per-pattern.
  //   3. Per-host external-only filter (Instagram, Twitter): silent for
  //      content that's internal to the current site, scope per-site:
  //        appliesTo='all'   — link AND image triggers
  //        appliesTo='links' — only link triggers; image hovers always pass
  function findHoverable(eventOrEl) {
    const candidate = findHoverableInner(eventOrEl);
    if (!candidate) return null;
    // Anchors we wrapped ourselves bypass the heuristic filters below.
    // These are intentional, not page-author UI — heuristics like
    // "ignore numeric-only anchor text" (matching pagination) or
    // "ignore links inside <header>" would otherwise reject legitimate
    // citation/user wraps. Includes both portaltext-user-marked (manual
    // selection wraps) and portaltext-citation (auto-detected arXiv,
    // DOI, PMID, RFC, ISBN). Pure-digit citations like PMID:32233995
    // would otherwise be rejected as "pagination" by SKIP_LINK_TEXT_PATTERNS.
    const cls = candidate.classList;
    if (cls?.contains?.('portaltext-user-marked') || cls?.contains?.('portaltext-citation')) {
      return candidate;
    }
    if (isInsidePageChrome(candidate)) return null;
    // Skip hovers on overlay UI like Reddit's media lightbox or any modal
    // <dialog> — the user is engaged with that overlay (viewing the image),
    // not browsing, and our tooltip just gets in the way. Also avoids the
    // lightbox-IMG-with-huge-rect bug that would otherwise resolve every
    // post hover to whatever image is currently lightboxed.
    if (candidate.closest?.('shreddit-media-lightbox, [role="dialog"], dialog')) return null;
    const dest = destinationUrlOf(candidate);
    if (dest && shouldSkipUrl(dest)) return null;
    if (dest && isUnsummarizableUrl(dest)) return null;
    if (dest && deadPatternCache.has(urlPatternKey(dest))) return null;
    if (shouldSkipAnchor(candidate)) return null;
    const filter = currentExternalOnlyFilter();
    if (filter) {
      const isImg = candidate.tagName === 'IMG' || bgUrlForEl.has(candidate);
      const filterApplies = filter.appliesTo === 'all' || (filter.appliesTo === 'links' && !isImg);
      if (filterApplies) {
        if (dest && destinationIsInternalToCurrentSite(dest)) return null;
      }
    }
    // Image-only sites: tooltips are useful on product photos (vision
    // summary) but link hovers give noisy / inconsistent results because
    // the listing pages are patchwork (eBay's many template variants are
    // the headliner). Bail unless the candidate is an image.
    if (currentSiteIsImageOnly()) {
      const isImg = candidate.tagName === 'IMG' || bgUrlForEl.has(candidate);
      if (!isImg) return null;
    }
    return candidate;
  }

  // Hosts where tooltips should fire ONLY on image hovers. Use for sites
  // where link summaries reliably misbehave (Amazon-style DOM patchwork)
  // but the images themselves are useful (product photos, listings, etc.).
  // Matches every regional TLD (ebay.com, ebay.co.uk, ebay.de, …) plus any
  // subdomain.
  const IMAGE_ONLY_HOSTS = [
    /(^|\.)ebay\.[a-z]{2,3}(\.[a-z]{2,3})?$/i,
  ];
  function currentSiteIsImageOnly() {
    const h = location.hostname.toLowerCase();
    return IMAGE_ONLY_HOSTS.some(re => re.test(h));
  }

  // ----- Pure-shape URL skips (cheapest filter, catches the most) -----
  // URLs whose scheme alone makes them un-summarizable (can't fetch a mailto).
  const SKIP_URL_SCHEMES = /^(mailto|tel|sms|javascript|ftp|file|magnet|data|blob|chrome|chrome-extension|about):/i;
  // File extensions for binaries / media we can't summarize as text or vision.
  // PDF is *not* here — the server handles those via document vision.
  const SKIP_FILE_EXT = /\.(zip|7z|rar|gz|tar|tgz|bz2|exe|dmg|iso|pkg|deb|rpm|apk|msi|mp3|mp4|mov|avi|mkv|webm|wav|flac|aac|ogg|wmv|m4a|m4v|torrent|csv|xls|xlsx|doc|docx|ppt|pptx)(\?|#|$)/i;
  // Affiliate / redirector domains — the URL itself is an interstitial that
  // bounces to the real product page. Opaque shorteners (t.co) are handled
  // separately by the server's SHORTENER_HOSTS resolution path.
  const SKIP_REDIRECTOR_HOSTS = new Set([
    'shareasale.com', 'anrdoezrs.net', 'awin1.com', 'awin.com',
    'linksynergy.com', 'clickbank.net', 'cj.dotomi.com', 'dpbolvw.net',
    'qksrv.net', 'tkqlhce.com', 'jdoqocy.com', 'kqzyfj.com',
    'prf.hn', 'rstyle.me', 'go.skimresources.com',
  ]);
  // ?format=<x> — accept formats the server can summarize (pdf, image variants);
  // skip anything else (json/xml/rss/atom/html-fragment APIs, etc.).
  const ACCEPTABLE_FORMAT_PARAM = /^(pdf|image|jpg|jpeg|png|webp|gif|svg|tiff?|bmp|heic|avif)$/i;
  // Tag / topic / category listing paths — destination is a list of links,
  // never standalone content. Matches path segments to avoid false-positives
  // on words like "categorical" in URLs.
  const LISTING_PATH_SEGMENT = /\/(tag|tags|topic|topics|category|categories)\//i;
  // Privacy-policy pages — the link-text blocklist already covers many, but
  // some sites link the policy with non-obvious text (e.g. "Your Data").
  const PRIVACY_PATH = /^\/(privacy|privacy-policy|privacy-notice|legal\/privacy|policies\/privacy)\/?$/i;

  function isGoogleMapsUrl(u) {
    const h = u.hostname.toLowerCase();
    const p = u.pathname;
    if (h === 'maps.app.goo.gl') return true;
    if (/^maps\.(google|googleapis|gstatic)\./i.test(h)) return true;
    if ((h === 'google.com' || h.endsWith('.google.com')) && /^\/maps(\/|$)/i.test(p)) return true;
    if (h === 'goo.gl' && /^\/maps?\//i.test(p)) return true;
    return false;
  }

  function shouldSkipUrl(urlStr) {
    if (!urlStr) return false;
    if (SKIP_URL_SCHEMES.test(urlStr)) return true;
    if (urlStr.startsWith('#')) return true; // hash-only / same-page anchor
    let u;
    try { u = new URL(urlStr, location.href); } catch { return false; }
    if (SKIP_FILE_EXT.test(u.pathname)) return true;
    if (SKIP_REDIRECTOR_HOSTS.has(u.hostname.toLowerCase())) return true;
    if (LISTING_PATH_SEGMENT.test(u.pathname)) return true;
    if (PRIVACY_PATH.test(u.pathname)) return true;
    if (isGoogleMapsUrl(u)) return true;
    const fmt = u.searchParams.get('format');
    if (fmt && !ACCEPTABLE_FORMAT_PARAM.test(fmt)) return true;
    return false;
  }

  // ----- Anchor-element skips (text, ARIA, attributes) -----
  // Exact anchor-text strings (lowercased + trimmed) that are functional UI,
  // never content references. Keep this list conservative — when in doubt,
  // leave the term out and let the hover proceed.
  const SKIP_LINK_TEXT_EXACT = new Set([
    'log in', 'login', 'sign in', 'signin', 'sign up', 'signup',
    'register', 'create account', 'create an account',
    'my account', 'account', 'profile', 'settings',
    'cart', 'checkout', 'basket', 'wishlist',
    'privacy', 'privacy policy', 'terms', 'terms of service', 'terms of use',
    'terms & conditions', 'terms and conditions', 'cookies', 'cookie policy',
    'cookie preferences', 'cookie settings', 'imprint', 'legal',
    'skip to content', 'skip to main content', 'skip navigation', 'skip to navigation',
    'download', 'get the app', 'submit',
    'share', 'tweet', 'pin it', 'email this', 'view email',
    'next', 'previous', 'prev', 'back', 'back to top', 'back to blog',
    'more', 'see all', 'view all', 'show all', 'show more', 'load more',
    'subscribe', 'unsubscribe', 'newsletter', 'feedback', 'get in touch',
    'menu', 'close', 'open menu', 'close menu',
    'home', 'about', 'about us', 'contact', 'contact us',
    'support', 'help', 'faq', 'careers', 'jobs',
  ]);
  // Anchor-text shape patterns: "Share on Twitter", "Buy on Amazon",
  // numeric-only pagination, arrow-only navigation, image credits.
  const SKIP_LINK_TEXT_PATTERNS = [
    /^share on /i,
    /^buy on /i,
    /^download (the |this )?/i,
    /^\d+$/,
    /^[\s›»→←‹⟶➔➜➤↑↓⇒⇐•·\-—–]+$/u,
    /^(photo|image|credit|illustration|photograph)s?\s*[:.]/i,  // "Photo: Reuters"
    /^(photo|image)s?\s+by\s/i,                                  // "Photo by Jane Smith"
  ];
  // ARIA labels that mark a link as a functional UI button rather than content.
  const SKIP_ARIA_LABEL = /^(close|open|menu|search|toggle|expand|collapse|previous|next|hide|show|dismiss|skip|copy|share|like|bookmark|save|subscribe)\b/i;

  function shouldSkipAnchor(link) {
    if (!link || link.tagName !== 'A') return false;
    // Explicit download intent: page itself says "click to download," not "read."
    if (link.hasAttribute('download')) return true;
    // ARIA tells us this is a UI button.
    if (link.getAttribute('role') === 'button') return true;
    const aria = link.getAttribute('aria-label');
    if (aria && SKIP_ARIA_LABEL.test(aria.trim())) return true;
    const text = (link.textContent || '').trim();
    const hasImg = !!link.querySelector('img');
    // Text-based filters only apply when the anchor isn't wrapping a real
    // image (img-wrapping anchors get resolved via the IMG-pass earlier).
    if (!hasImg) {
      // Empty / single-char / symbol-only — almost always an icon button.
      if (text.length < 2) return true;
      const tNorm = text.toLowerCase();
      if (SKIP_LINK_TEXT_EXACT.has(tNorm)) return true;
      if (SKIP_LINK_TEXT_PATTERNS.some(re => re.test(text))) return true;
      // Hashtag links (Twitter / Instagram / blog tags). The destination is a
      // tag-listing page, never content of substance.
      if (text.startsWith('#') && text.length < 40 && !/\s/.test(text)) return true;
    }
    return false;
  }

  // Per-pattern silent skip for URLs that have no useful summary signal.
  function isUnsummarizableUrl(url) {
    let u;
    try { u = new URL(url, location.href); } catch { return false; }
    const h = u.hostname.toLowerCase();
    // YouTube Shorts: titles are typically clickbait punctuation/emoji,
    // descriptions absent — no signal for Claude to write a real summary.
    if ((h === 'youtube.com' || h === 'www.youtube.com' || h === 'm.youtube.com') && u.pathname.startsWith('/shorts/')) {
      return true;
    }
    // TikTok in any form: app-first platform, web pages are essentially
    // login walls or empty SPA shells. Vision on the looping video preview
    // is meaningless; metadata APIs are auth-walled. Skip everywhere —
    // tiktok.com itself, vm.tiktok.com short links, embed iframes, and the
    // tiktokcdn.com / tiktokcdn-us.com / tiktokcdn-eu.com asset hosts
    // (covers video thumbnails on the site itself).
    if (h === 'tiktok.com' || h.endsWith('.tiktok.com')) return true;
    if (h.endsWith('.tiktokcdn.com') || h.endsWith('.tiktokcdn-us.com') || h.endsWith('.tiktokcdn-eu.com')) return true;
    // Reddit user profile links (/u/<name>, /user/<name>, and any deeper
    // path under either). These are accounts, not content — summarizing
    // them just yields "this is a user page", which is noise on hover.
    if ((h === 'reddit.com' || h.endsWith('.reddit.com')) && /^\/(u|user)\/[^/]+/.test(u.pathname)) {
      return true;
    }
    // Facebook navigation noise: hashtag pages and the per-profile section
    // tabs (posts / about / reels / photos / videos / friends / etc.) all
    // route to Facebook URLs but they're nav buttons, not content. Hovering
    // them just gives "an X's profile / a Facebook hashtag" — useless.
    if (h === 'facebook.com' || h === 'www.facebook.com' || h === 'm.facebook.com') {
      if (/^\/hashtag\//.test(u.pathname)) return true;
      if (/^\/[^/]+\/(posts|about|reels|photos|videos|friends|followers|following|groups|likes|reviews|events|notes)\/?$/.test(u.pathname)) return true;
    }
    return false;
  }

  // Universal page-chrome filter. Walks ancestors looking for the standard
  // HTML5 site-chrome tags or their ARIA equivalents. If any ancestor is
  // chrome, skip the hover — these elements wrap site nav, search, cookie
  // banners, footer link rows, language switchers, etc., and tooltips on
  // those have no value.
  const CHROME_TAGS = new Set(['HEADER', 'FOOTER', 'NAV', 'ASIDE']);
  const CHROME_ROLES = new Set(['banner', 'contentinfo', 'navigation', 'complementary', 'search']);
  function isInsidePageChrome(el) {
    for (let n = el?.parentElement; n; n = n.parentElement) {
      if (CHROME_TAGS.has(n.tagName)) return true;
      const role = n.getAttribute?.('role');
      if (role && CHROME_ROLES.has(role.toLowerCase())) return true;
    }
    return false;
  }

  function currentExternalOnlyFilter() {
    const h = location.hostname.toLowerCase();
    return EXTERNAL_ONLY_HOSTS.find(f => f.isCurrentSite(h)) || null;
  }

  // Walks event.composedPath() so we pierce open shadow DOM (Reddit's
  // <shreddit-post>, <shreddit-comment>, etc. — without this, document-level
  // mouseover sees event.target retargeted to the shadow host and closest()
  // never finds the inner <a>). Accepts either an Event or a bare Element
  // for backward compatibility.
  function findHoverableInner(eventOrEl) {
    const path = (eventOrEl && typeof eventOrEl.composedPath === 'function')
      ? eventOrEl.composedPath()
      : (eventOrEl ? [eventOrEl, ...ancestorChain(eventOrEl)] : []);

    // Pass 1: explicit class markers — used by tooltip-internal links.
    for (const node of path) {
      if (node?.nodeType !== 1) continue;
      if (node.classList?.contains('wikilink') || node.classList?.contains('extlink')) {
        if (node.tagName === 'A') return node;
      }
    }
    if (!PLAIN_ANCHORS) return null;

    // Pass 2: image hover. Precedence over parent links so a thumbnail inside
    // a card previews the IMAGE (vision) rather than the card's href.
    // EXCEPTION: when the image's parent <a> is an opaque shortener (t.co,
    // etc.), the image is almost always an auto-generated card thumbnail and
    // the link's destination is the real content — defer to Pass 3.
    for (const node of path) {
      if (node?.tagName === 'IMG' && isHoverableImage(node)) {
        if (imageHasDeferralLinkAncestor(node)) continue;
        return node;
      }
    }

    // Pass 2b: background-image hover (Instagram feed posts, Pinterest, etc.
    // — sites where the visible "picture" is actually a CSS background on a
    // <div>, with the only <a> in the path going to a UNSUPPORTED viewer
    // page like instagram.com/p/POSTID). Same shortener-link exception.
    for (const node of path) {
      const bgUrl = getBackgroundImageUrl(node);
      if (bgUrl) {
        if (imageHasDeferralLinkAncestor(node)) continue;
        bgUrlForEl.set(node, bgUrl);
        return node;
      }
    }

    // Pass 3: any <a href> with an http(s) URL.
    for (const node of path) {
      if (node?.tagName !== 'A') continue;
      if (!node.hasAttribute?.('href')) continue;
      if (node.classList?.contains('no-portaltext')) continue;
      if (node.closest?.('[data-portaltext="off"]')) continue;
      const href = node.getAttribute('href');
      if (!href) continue;
      if (href.startsWith('#') || /^(mailto|tel|javascript|data|blob):/i.test(href)) continue;
      let u;
      try { u = new URL(href, location.href); } catch { continue; }
      if (!/^https?:/i.test(u.protocol)) continue;
      // Image-wrapping link: Pinterest, gallery sites, and many card layouts
      // put pointer-events:none on the inner <img> so the wrapping <a>
      // catches hover events — defeating our IMG-pass above. If THIS link
      // wraps a real hoverable image, prefer that over the link target,
      // BUT remember the link URL so the server can fetch its source page
      // alongside the image — the linked source (recipe blog, artist page,
      // product detail) is meaningful supplemental context.
      const realLinkUrl = unwrapRedirector(u.toString());
      // Image-wrapping link: usually we prefer the inner image (Pinterest/
      // gallery sites where the image IS the content). But if the wrapping
      // link is a wrapper for the real content (shorteners like t.co OR
      // video platforms like YouTube where the inner image is just an
      // auto-generated thumbnail), the LINK target is what the user wants
      // summarized — skip the inner-image preference and treat as a link.
      if (!linkPrefersImageDeferral(u.toString())) {
        const innerImg = findHoverableImageInside(node);
        if (innerImg) {
          linkUrlForImage.set(innerImg, realLinkUrl);
          return innerImg;
        }
        const innerBg = findBackgroundImageInside(node);
        if (innerBg) {
          bgUrlForEl.set(innerBg.el, innerBg.url);
          linkUrlForImage.set(innerBg.el, realLinkUrl);
          return innerBg.el;
        }
      }
      return node;
    }
    return null;
  }

  // Returns the first <img> child of `el` that passes isHoverableImage, OR
  // a sibling/nearby <img> whose bounding rect visually overlaps the link's.
  // The visual-overlap check catches the gallery-card pattern (Flickr
  // photostream, Pinterest, Behance, etc.) where the link is positioned
  // ON TOP OF or ALONGSIDE the image inside a unified card. Works even when
  // the link has its own text content (a title or photographer credit) —
  // the visual coupling, not the text emptiness, is the real signal.
  function findHoverableImageInside(el) {
    if (el?.querySelectorAll) {
      for (const img of el.querySelectorAll('img')) {
        if (isHoverableImage(img)) return img;
      }
    }
    return findOverlappingHoverableImage(el);
  }

  // Returns {el, url} for the first descendant of `el` whose computed style
  // has a usable background-image URL, OR a nearby element whose bg-image
  // rect overlaps the link's. Mirrors findHoverableImageInside for bg-image.
  function findBackgroundImageInside(el) {
    if (el?.querySelectorAll) {
      for (const desc of el.querySelectorAll('div, span, picture, figure, section, li, article')) {
        const url = getBackgroundImageUrl(desc);
        if (url) return { el: desc, url };
      }
    }
    return findOverlappingBackgroundImage(el);
  }

  // Walks up to 3 parent levels from `el`, searching each parent's descendants
  // for an <img> whose bounding rect visually overlaps `el`'s rect. The 3-level
  // depth bound keeps the scan cheap and avoids matching unrelated images
  // elsewhere on the page.
  function findOverlappingHoverableImage(el) {
    if (!el?.getBoundingClientRect) return null;
    const linkRect = el.getBoundingClientRect();
    if (linkRect.width === 0 || linkRect.height === 0) return null;
    let p = el.parentElement;
    let depth = 0;
    while (p && depth < 3) {
      for (const img of p.querySelectorAll?.('img') || []) {
        if (!isHoverableImage(img)) continue;
        // Skip imgs inside an open lightbox/modal — Reddit's media lightbox
        // sits the image (with the original src) at viewport scale, which
        // means its rect overlaps EVERY post overlay below it. Without this
        // skip, hovering any post resolves to the lightbox image instead of
        // the post's own image.
        if (img.closest?.('shreddit-media-lightbox, [role="dialog"], dialog')) continue;
        if (rectsOverlap(linkRect, img.getBoundingClientRect())) return img;
      }
      // Stop walking past a card boundary. Custom elements (shreddit-post,
      // shreddit-comment, etc.) and <article> are almost always the
      // enclosing card on social/feed sites — going further pulls in other
      // cards' images, which is exactly the cross-post bleed we don't want.
      if (p.tagName?.includes?.('-') || p.tagName === 'ARTICLE') break;
      p = p.parentElement;
      depth++;
    }
    return null;
  }

  function findOverlappingBackgroundImage(el) {
    if (!el?.getBoundingClientRect) return null;
    const linkRect = el.getBoundingClientRect();
    if (linkRect.width === 0 || linkRect.height === 0) return null;
    let p = el.parentElement;
    let depth = 0;
    while (p && depth < 3) {
      for (const desc of p.querySelectorAll?.('div, span, picture, figure, section, li, article') || []) {
        const url = getBackgroundImageUrl(desc);
        if (!url) continue;
        if (rectsOverlap(linkRect, desc.getBoundingClientRect())) return { el: desc, url };
      }
      p = p.parentElement;
      depth++;
    }
    return null;
  }

  function rectsOverlap(a, b) {
    return !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
  }

  function ancestorChain(el) {
    const out = [];
    for (let n = el?.parentElement; n; n = n.parentElement) out.push(n);
    return out;
  }

  function classify(link) {
    // linkUrl (optional): when the trigger is an image inside a link, this
    // is the link's href — server uses it as supplemental context for the
    // vision prompt.
    const linkUrl = linkUrlForImage.get(link);
    // Background-image trigger (Instagram feed posts, etc.) — findHoverable
    // associated this element with a CSS background-image URL via WeakMap.
    const bgUrl = bgUrlForEl.get(link);
    if (bgUrl) return { isExternal: true, payload: bgUrl, linkUrl };
    // Image trigger — send the image URL through the extlink path. The server
    // detects content-type=image/* and routes to the vision-prompt summarizer.
    if (link.tagName === 'IMG') {
      const raw = link.currentSrc || link.getAttribute('src');
      if (!raw) return null;
      let u;
      try { u = new URL(raw, location.href); } catch { return null; }
      if (!/^https?:/i.test(u.protocol)) return null;
      return { isExternal: true, payload: u.toString(), linkUrl };
    }
    if (link.classList.contains('wikilink')) {
      const term = link.dataset.term;
      return term ? { isExternal: false, payload: term } : null;
    }
    if (link.classList.contains('extlink')) {
      const url = link.dataset.url;
      return url ? { isExternal: true, payload: url } : null;
    }
    // Plain mode: classify by URL. Unwrap link-wrapper redirectors first
    // (l.instagram.com/?u=..., l.facebook.com/l.php?u=..., google /url?q=,
    // youtube /redirect?q=) so the destination we send to the server and the
    // wikipedia detection both see the real target.
    const rawHref = link.getAttribute('href');
    if (!rawHref) return null;
    let u;
    try { u = new URL(unwrapRedirector(rawHref), location.href); } catch { return null; }
    if (!/^https?:/i.test(u.protocol)) return null;
    if (/(^|\.)wikipedia\.org$/i.test(u.hostname) && u.pathname.startsWith('/wiki/')) {
      let term;
      try { term = decodeURIComponent(u.pathname.slice(6).split('#')[0]).replace(/_/g, ' '); }
      catch { return null; }
      if (!term || WIKI_NAMESPACES.test(term)) return null;
      return { isExternal: false, payload: term };
    }
    return { isExternal: true, payload: u.toString() };
  }

  // ----- dead-pattern cache (per-page-session) -----
  // When a URL fails with an *inherent* error — content-type the server can't
  // summarize, no extractable text, broken image — a sibling URL from the same
  // source will fail identically. We cache the parent-path key here so the next
  // hover on a sibling silently skips instead of opening a doomed tooltip just
  // to show the same error. Lives for the lifetime of the content script
  // (resets on page reload). Transient errors (timeouts, 5xx, rate limits) are
  // deliberately excluded — those might succeed next time.
  const deadPatternCache = new Set();

  function urlPatternKey(urlStr) {
    let u;
    try { u = new URL(urlStr); } catch { return null; }
    const segs = u.pathname.split('/').filter(Boolean);
    if (segs.length >= 2) {
      // Collapse to parent directory so siblings match.
      segs.pop();
      return u.hostname.toLowerCase() + '/' + segs.join('/') + '/';
    }
    // Shallow path (e.g. /foo or /) — only the exact URL is blocked, never
    // the whole domain.
    return u.hostname.toLowerCase() + u.pathname;
  }

  // Error messages whose root cause is the URL's *shape* (not the network).
  // Inherent failures generalize across siblings; transient ones don't.
  const INHERENT_FAILURE_PATTERNS = [
    /^Cannot summarize content type/i,
    /^Could not extract readable content/i,
    /^Couldn'?t process this image/i,
    /^Image too large to identify/i,
    // Bot-detection / WAF blocks (e.g. "Reddit blocked this fetch") —
    // currently worded as transient but in practice the block applies to
    // every URL on the host, so treat as pattern-level.
    /blocked this (fetch|request|page|content)/i,
  ];
  function isInherentFailure(errMsg) {
    if (!errMsg) return false;
    return INHERENT_FAILURE_PATTERNS.some(re => re.test(errMsg));
  }

  // ----- /etymology client -----
  // Single-word dictionary lookups via Wiktionary. Only fires on user-click of
  // the arrow button — never as part of normal hover. The negative cache
  // suppresses the button on terms a previous click confirmed have no
  // Wiktionary entry, so once a user clicks "Napoleon" once, the button hides
  // for that term going forward.
  const etymologyMissCache = new Set();
  const etymologyResultCache = new Map();

  function isSingleWordTerm(s) {
    if (!s || typeof s !== 'string') return false;
    const t = s.trim();
    if (t.length < 2 || t.length > 40) return false;
    if (/\s/.test(t)) return false;
    // Allow letters + optional internal hyphen/apostrophe. Excludes pure
    // numbers, acronyms with periods, file names, URLs.
    return /^[\p{L}][\p{L}'’-]*$/u.test(t);
  }

  function requestEtymology(term) {
    if (etymologyResultCache.has(term)) {
      return Promise.resolve(etymologyResultCache.get(term));
    }
    return new Promise((resolve, reject) => {
      let port;
      try { port = chrome.runtime.connect({ name: 'pt-etymology' }); }
      catch { reject(new Error('Extension service worker unavailable')); return; }
      let settled = false;
      port.onMessage.addListener((msg) => {
        if (settled) return;
        if (msg.type === 'etymology') {
          settled = true;
          etymologyResultCache.set(term, msg.data);
          resolve(msg.data);
        } else if (msg.type === 'error') {
          settled = true;
          if (msg.status === 404) etymologyMissCache.add(term.toLowerCase());
          reject(new Error(msg.message || 'Etymology fetch failed'));
        }
      });
      port.onDisconnect.addListener(() => {
        if (!settled) { settled = true; reject(new Error('disconnected')); }
      });
      port.postMessage({ type: 'request', term });
    });
  }

  // Hand-drawn arrow (assets/handdrawn-40), rotated 180deg via .active
  // for the "back to summary" state. Fills swapped to currentColor so
  // the arrow takes the tooltip's text color.
  const ETYM_ARROW_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 980.68 752.88" aria-hidden="true"><g><g><path fill="currentColor" d="M737.65,415.69l3.92-8.21c1.92,3.89.97,7.48-3.92,8.21Z"/><rect fill="currentColor" x="275.26" y="455.26" width="11.44" height="1.35"/><polygon fill="currentColor" points="148.99 577.82 148.66 568.99 149.83 568.25 150.16 577.09 148.99 577.82"/><path fill="currentColor" d="M237.51,25.47l-6.5,1.83c.5-2.39,2.84-3.63,6.5-1.83Z"/><path fill="currentColor" d="M980.68,266.3c-1.74.26-4.1-2.29-3.8-5.03l3.8,5.03Z"/><g><g><path fill="currentColor" d="M771.67,505.38l-6.83-.62c2.12-3.94,5.12-8.48,5.82-11.9l2-9.84.7-2.83c.14-.55-1.73-1.2-1.96-.69l-1.23,2.71c-.42.93-2.39,2.34-3.76,2.7,1.83-5.8,6.19-8.29,2.71-14.72l-6.45,12.21c-.85,1.61-4.36,3.02-6.21,2.51-5.63-1.56,3.02-10.35-1.25-13.51l-8.88,10.21-1.56-1.71,3.88-5.77,2.14-16.4-17.24,24.76c-.08-1.52.3-2.52,1.8-5.66-3.38-1.94-7.34-2.23-14.05-1.83l7.28-13.29,10.36-21.82c2.96-6.23,6.48-10.75,9.22-16.79l4.09-9.05,10.05-19.59c3.09-6.03,8.65-11.98,10.84-17.99,1.26-3.46,1.77-5.87,3.79-9.13l9.32-15.09,4.11-8.68-8.97.42-46.27,3.32-61.49.81-15.35-1.16c-2.09-.16-5.01-3.6-4.83-5.58l14.77-2.89-7.84-1.65-10.13-4.57,3.72-6.52-4.13-17.7c-2.24-6.1-2.53-11.36.59-17.14-4-10.79-6.81-17.15-.33-22.94.5-.45.84-2.18.24-2.49-.8-.42-4.6-1.35-4.57-2.24l.55-18.66c.16-5.29-1.63-7.45,3.24-10.73l-4.21-2.99c6.12-7.93,14.21-2.01,16.27-8.53l32.88-2.04,17.93-.5c1.32-.04,3.57,3.01,2.71,3.32l-24.41,1.33c17.23,1.82,34.14,1.28,52.26-.56l-21.53-2.12c5.07-2.6,10.55-1.42,16.39-1.64l52.49-2-10.23-13.34-19.17-24-14.65-20.21-15.08-23.26c1.08-1.71,2.89-4.01,2.42-5.18l-3.05-7.6,9.34,8.87,10.52-4.88-3.64-4.75-1.93-3.08c-1.78-2.85,7.33,1.86,7.54,1.77l2.86-1.19-10.8-14.06c8.86-5.71,7.7,8.64,16.59,6.97,1.2-.99-1.98-4.94-3.47-5.49l1.62-2.42c.27-.4.38-.63-.08-.63h-4.04c-1.9-2.31-3.58-7.1-4.62-12.05,11.23.24,12.71,10.74,19.12,11.43,3.23.35,6.95.06,8.93-3.63l22.28,22.32,9.67,8.52,2.67,1.39c.63.33-.36-2.58-.86-3.04-1.53-1.39-4.64-3.18-3.77-7.25l8.9,6.9,2.53-1.72,18.4,19.18,1.78-3.09c.22-.39.88-2.06,1.13-1.69.38.55,1.85,2.68,2.45,3.24l16.15,14.99,6.62,8.38,9.68,10.84,15.56,16.4,9.33,11.07,7.25,10.39,15.78,18.79c2.96,3.52,6.18,13.82,18.18,19.85l.53,4.05c.14,1.1,3.55,1.05,4.69.95l4.82,7.68,1.2,1.91c.37.59-1.63,2.59-1.87,1.92l-1.48-4.17-1.3,7.75,9.09,5.79c5.52-.01,11.06.16,13.09,7.74l-7.79-4.1c-1.71.43-2.66,5.58-2.6,8.87l-4.44,11.85,10.69-.17c.99-.02,3.19,2.93,2.73,3.78l-2.87,5.41,6.03,9.85,3.62.93c.98.25.8,3.42.59,4.41s-3.44,2.08-3.8,1.2l-2.65-6.39-3.56,13.19c-4.01,14.84-10.42,29.28-17.86,42.8-1.49,2.71-3.39,3.15-2.39,6.99l-4.08,6.32c-1.41,4.47-3.25,8.56-5.47,11.82l-2.56-7.34c-.61-1.76-5.62-.02-6.5,1.54l-8.75,15.44-7.03,9.92-7.19,13.37c-3.27,6.09-6.99,9.72-12.82,13.33l-11,12.69c-4.33-.33-6.72.64-9.09,3.76l5.05,2.48-10.22,14.62-8.53,14.17-12.1,19.75-1.02-11.73-15.65,6.67.98-8.59-8.45,11.06c-.27.36-2.14,1.47-2.53,1.73s-.23-1.14-.02-1.54l.88-1.74c-1.53-9.74,8.73-15.7,5.29-23.14l-8.93,12.39-4.03-1.21,1.72-8.71-6.67,6.76c-.4.4-2.89.63-2.74.09l1.2-4.31c.88-3.16,2.97-7.54,3.04-10.3l-12.07,10.15.91-10.45c-5.17-3.43-8.18,10.29-15.94,13.22l-10.73,4.05ZM771.95,107.47c-.33.93,3.02,4.19,3.16,3.21l.4-2.98c.1-.73-3.31-.94-3.56-.24ZM677.72,223.33h-12.79v1.76h12.79v-1.76ZM941.94,265.02l-11.46-2.09c-1.17,1.51-2.58,6.98-2.34,7.79l13.8-5.7ZM856.77,449.09l1.4-2.42-2.78-5.28-1.62,1.22,3,6.47Z"/><path fill="currentColor" d="M746.71,176.71c-3.92-1.14-6.56-4.14-6.04-8.82,3.08,2.2,4.65,4.14,6.04,8.82Z"/><path fill="currentColor" d="M751.85,184.19c-1.74.26-4.1-2.29-3.8-5.03l3.8,5.03Z"/></g><g><path fill="currentColor" d="M134.75,730.15l-6.1-31.9c-2.82,7.34-1,14.18.42,21.14l1.68,8.23c.45,2.22.83,7.45-.5,9.22s-5.45,3.93-7.53,3.44c-2.26-2.93-4.51-7.45-5.91-10.31l-5.37,1.31c-1.25.3-1.85-2.65-4.06-4.92l-.41,12.65-3.87-.33c-.87-.07-1.76,4.02-2.62,4.2l-13.01,2.74-4.58,3.03c-3.55,2.35-12.69-8.63-18.83.5l-11.77-6.1-1.51,9.83-4.53-7.22c-.55.62-2.76,3.53-3.26,2.82l-2.73-3.94-1.39,7.81-6.88-9.17-1.55,8.44-6.99-10.38-4.7.75-4.99-18.31-1.56,7.99-2.85-7.63-2.71,7.72c-2.72-5.49-3.44-11.83.7-17.14l-2.99-22.62,1.96-11.3-.11-8.02-.67-42.2c-.06-3.68-6.38-8.98-2.63-13.22.76,0,2.38.04,2.49-.57l.58-3.19c.15-.81-3.48.27-3.64.36.35-4.13.41-7.04-1.54-11.17-.85-1.8.42-4.33.69-6.62,1.06-9.23.82-19.33-.16-28.63-.61-5.83.74-9.21,2.01-14.53,2.44-10.22.93-21.86,1.58-33.24.11-1.93-2.29-5.41-3.74-6.76,3.09-5.93,4.15-14.14-1.19-19.98l2.42-13.94c1.2-.7,4.44-2.9,4.53-4.25l1.32-20.45c.51-7.96,1.29-13.07,3.18-20.22,2.29-8.63,1.94-18.8,3.58-27.64l4.56-24.63c1.53-8.29,1.76-16.46,5.78-24.29,1.2-2.34,1.91-5.29,2.59-8.3,2.34-10.33,8.16-20.34,9.42-30.12s3.68-16.93,7.43-25.38l16.09-36.24c3.17-7.13,5.59-15.62,13.46-19.14l-.94-5.59c-.2-1.21,2.45-2.73,4.39-3.42-.81,7.79-4.81,13.62-7.41,20.86-1.86,5.18-.74,11.91-5.13,16.5.67,1.51,1.34,2.99,1.1,2.47l9.3-18.7,9.61-17.33,27.73-46.23,29.96-44.16,26.14-34.39,16.6-19.91c2.16-2.59,7.42-3.1,8.02-8.52.24-2.1,4.46-3.27,5.96-4.33l5.41-3.83,2.88-5.95c.75-1.55,4.6-1.34,6.6-1.32l10.37-7.82c.72-.54,2.76-3.02,1.95-3.15l-5.43-.87c4.06-2.82,9.63-7.87,14.71-10.1l12.55-5.51c5.4-2.37,12.89-3.07,16.83,2.03-4.45,2.7-7.61,6.23-6.09,11.1l13.18,1.54-6.41,5,11.43-.71-.8,2.98c-.17.64,2.49.21,3.15.03l2.57-.7c1.02-.28,1.19,5.91,2.07,5.97.94.06,3.29-.21,4.34-.7l11.83-5.56c3.7-7.05,9.87-11.5,16.92-15.51l15.42-8.78,5.05-9.31c.72-2.26,1.69-5.57,2.99-7.32l4.09-5.53c.97-1.31,5.85-.8,7.34-.11l10.61,4.9c.31-.16,2.33-3.45,1.91-4.59l-2.18-5.77c7.03,3.54,13.7,7.51,19.39,12.38l19.01,16.26c3.31,2.83,6.54,7,9.78,11.02,2.07,2.57,7.4,4.73,10.6,7.74l12.35,11.63,19.05,17.3,30.42,35.44,7.86,11.42c1.88,2.73,7.54,6,8.25,9.86,1.19,6.47,5.54,9.55,8.36,14.81l11.71,21.89,11.76,25.23c1.61-2.81.6-3.77-.48-6.66l-7.39-19.89c-1.53-4.12-5.81-7.47-2.47-13.48l11.97,26.04c7.4,16.1,11.11,33.9,14,51.56l4.34,26.54,3.01,22.77,3.15,30.54,3.01,26.58,9.65,60.52c2.86,17.96,2.85,35.47,2.31,53.12l-.44,14.58c-.22,7.14,1.32,15.02,2.76,22.52l10.3,10.33,10.97,11-5.04.6c-.47.06-1.2,1.09-.84,1.42l2.91,2.63.47,10.66c-1.22,3.74-1,4.88-1.25,10.08l-3.24-8.38-8.89,3.97c3.98,3.97,7.72,6.19,12.84,8.78l2.15,1.08c.63.32-.14,2.88-.82,2.69l-2.97-.86-10.76-3.1c3.7,13.19,6.11,26.39,5.34,40.64-.24,4.47.54,8.23,2.25,12.2l1.69-6.18c-1.28-2.11-.29-1.9,1.28-.54l1.16,28.7-.06,21.62-3.23-13.56c-1.78,8.47-2.31,21.69,2.94,26.67l-3.69,12.72-2.82-8.33-1.85,13.51-1.88,8.26c-.43.12-2.26.22-2.09-.21l.95-2.42-4.64-11.03-2.27,1.31c-.79.46-2.57-.97-4.56-2.14l-3.93,6.84-7.26-6.8-2.26,7.73-.94-5.25c-.21-1.15-1.82-.57-3.81.06l-2.97-8.99-2.32,10.49c-.25,1.13-3.73,2.53-4.6,1.73-1.1-1-2.29-3.58-2.59-5.11l-.76-3.87c-.15-.78-4.18-1.04-4.61-.38l-6.99,10.76-8.97-4.83-10.01,3.19-1.47,2.75c-.25.47-1.67-.27-1.83-.78l-.93-3c-.3-.97-3.16-1.16-4.14-1.55-1.22-.49-1.63-3.03-2.08-6.17l-1.58.25c-.27,5.38-4.01,7.76-7.47,8.3l-2.54-5.45-1.39,8.2c-.16.93-3.19,2.83-3.32,1.89l-.65-4.48-.75-5.15c-.16-1.1-4.34.26-4.32,1.21l-.38,15.12c-1.37-2.89-4.26-7.28-4.51-9.51l-2.31-20.6-2.21,1.88c1.09,3.69.7,6.33-1.21,7.93.11-9.5.13-16.8-2.54-25.16l-2.82,16.17-1.79-31.59-.8-26.43-2.74.72.67,17.64.52,17.38-.09,22.19c-6.38-9.17-4.63-18.78-4.92-28.96l-.86-30.18c-.11-3.81.58-7.88,1.47-10.68-2.6-4.93-3.5-10.54-3.49-17.2l2.85-11.83,1.72-24.21-.32-21.58c-.02-1.61-1.5-5.08-1.18-6.7.84-4.25-.3-8.66-2.63-11.92,3.75-8.68.37-16.01-2.61-24.24-1.96-5.4-2.26-13.24-3.19-19.31l-1.33-8.72c-.11-.73.24-3.08.31-3.8s-2.58-1.37-3.34-1.3l-17.47,1.71-7.95.94-20.28,1.82c-9.04,3-17.21,5.72-26.52,5.15l4.73-3.53-36.01,1.98-32.43,3.19-31.22,3.54-18.44,2.97-38.3,7.32-28.18,6.88-20.63,7.2c-.96-2.06-1.8-8.42.1-9.37,2.82-1.4,6.44-2.19,9.91-3.1l-14.11-1.79-.65,8.01c-.25,3.13-.26,4.89-2.75,6.82l-.65-14.5c-.04-.94-3.04-1.54-3.14-.69l-.59,4.78-3.09,25.16-1.4,14.92c-.96,10.27-4.26,16.28-5.06,28.02l-1.01,14.86-.48,31.81,1.83,23.49c.09,1.11,3.87,4.3,2.93,4.73l-4.64,2.09-4.52-13.07-.65,13.52,1.19,17.49c-1.26.87-3.58,2.09-3.28,3.08l1.45,4.68c.93-3.85,2.63-3.57,2.86-.13l-3.72,1.69c-1.03.47-.87,2.98-.81,4.72l.98,29.75c.53,16.03.84,31.04,3.01,47.05.52,3.81-.04,8.65-.85,11.42l.04.36,2.44-1.59v12.72s-3.53-5.22-3.53-5.22c-.29-.43-1.49-1.86-1.24-2.32l1.39-2.53-1.57-.4ZM203.06,104.77c4.23-3.77,1.67-6.75-.4-8.93l.4,8.93ZM237.42,110.56c3.36-3.9,4.11-6.84,1.62-10.24l-4.62,10.44c.14.29,1.14.23,3-.19ZM233.3,112.27c-.75-3.27-2.99-6.38-4.15-5.78l-6.38,3.29,10.53,2.49ZM248.91,114.05c0-1.36-1.1-2.46-2.46-2.46s-2.46,1.1-2.46,2.46,1.1,2.46,2.46,2.46,2.46-1.1,2.46-2.46ZM275.66,123.69c1.06-6.41-5.46-6.85-6.37-3.2l6.37,3.2ZM256.87,123.17c0-1.67-1.36-3.03-3.03-3.03s-3.03,1.36-3.03,3.03,1.36,3.03,3.03,3.03,3.03-1.36,3.03-3.03ZM268.16,124.34l-11.25.58c1.24,3.94,4.13,5.5,7.17,5.74,1.98.16,5.16-3.85,4.08-6.32ZM282.1,128.96c-.07.91,3.21,4.2,3.12,3.25l-.22-2.43c-.06-.68-2.85-1.5-2.9-.82ZM292.41,137.32c-4.6-2.69-11.86-2.91-14.79.7-.91,1.12.55,5.12,1.87,4.56,1.5-.63,3.92-2.97,4.42-2.19l2.35,3.6,6.14-6.67ZM254.01,141.78c-.71-.24-2.65,3.48-1.91,3.45l3.12-.15c.75-.04,1.91-2.26,1.2-2.49l-2.42-.8ZM295.28,147.66c0-1.13-.92-2.04-2.04-2.04s-2.04.92-2.04,2.04.92,2.04,2.04,2.04,2.04-.92,2.04-2.04ZM288.41,151.75l-3.41,1.4,2.02,4.94,3.41-1.4-2.02-4.94ZM270.48,325.54l7.93-2.86-6.29-1.91,59.74-5.77,29.57-1.62,24.39-1.36,32.82-2.59c1.18-.09,4.02-1.87,4.34-2.3l-4.96-15.18-13.69-33.2-7.28-14.9c-2.03-4.16-6.43-9.82-9.52-13.85l-9.45-12.31-12.85-15.4-14.56-16.44-10.27-12.54c-3.04-3.71-6.06-4.75-9.98-7.59l-10.88-7.86c-1.82-1.31-4.56-3.26-7.12-3.02-1.74.16-2.79,2.9-4.48,4.73l-9.68,10.57-9.53,10.49-21.6,25.64-12.38,17.28c-8.31,11.6-17.38,23.26-24.08,35.88l-12.71,23.94-14.52,26.9-7.74,16.62-2.81,6.91,15.06-2.65,24.2-4.05,13.28-2.94c7.14-1.58,13.37-.6,19.77,2.51l-13.08,4.85c9.06,4.73,16.92.57,25.88-1.33l16.4-3.48c-7.45-2.6-14.58,3.24-23.92-1.16ZM429.01,288.04l-3.48-6.63c-1.78,2.65-.8,6.62,3.48,6.63ZM385.24,321.43l35.94-3.68c1.03-.11,3.08-1.51,3.67-1.99s-2.27-1.63-3.2-1.55l-26.65,2.36-28.79,1.34c-.5.68-.95,3.98-.13,4.11l4.61.73,14.54-1.32ZM344.19,323c-8.53-2.45-16.01-.3-24.39-.17-4.03.06-9.3-1.32-11.08,4.16,12.85-.77,23.6-.69,35.47-3.98ZM425.77,333.83l-1.26,4.29,3.41,1,1.26-4.29-3.41-1ZM589.16,627.49c1.18-4.12,1.28-6.68.25-9.56l-.25,9.56Z"/><path fill="currentColor" d="M441.47,60.99c-.77.49-3.12,1.57-3.53.74l-2.13-4.3-32.49-26.35c-.74-4.89-4.4-4.96-7.29-7.36L367.52,0c10.16,1.95,16.57,9,23.58,14.9l25.61,21.55,20.04,17.71,5.95,5.4.4,1.08,3.35,2.06c.77.47,1.12.64,1.25.79l16.89,19.09,7.74,8.73,11.24,13.14,14.53,19.81.66.74c3.61,3.54,6.96,8.5,9.99,13.67l9.38,16.02,1.82,3.79c.4.82-3.58,2.35-4.03,1.59l-8.29-17.43-2.87-.38c-.83-.11-1.98-2.06-2.45-3.07l-5.75-12.42-.25-1.35-9.74-12.13-7.5-8.61-7.84-7.98-13.17-14.15c-4.96-5.33-9.37-11.96-12.38-17.99-.1-.19-.25-.53-.21-.45l-3.69.4c-.89.1-.59-2.73-.24-2.92l-.09-.61Z"/><path fill="currentColor" d="M143.27,127.22c3.82-6.9,8.59-13.38,14.56-19.59-.3,7.82-4.93,17.12-14.56,19.59Z"/><path fill="currentColor" d="M377.34,450l-17.29-.56c4.85-1.87,11.97-3.21,17.26-2.34l3.08.51c.44.07-2.61,2.41-3.05,2.39Z"/><path fill="currentColor" d="M357.85,450.73l-14.05-1.34c4.22-1.2,9.3-2.26,14.05,1.34Z"/><polygon fill="currentColor" points="395.27 446.84 384.95 447.3 384.26 446.1 392.98 445.72 395.27 446.84"/><path fill="currentColor" d="M176.93,88.82l5.23-5.25c.38,2.76-1.36,5.19-5.23,5.25Z"/><polygon fill="currentColor" points="138.23 668 137.89 659.17 139.06 658.44 139.4 667.27 138.23 668"/><polygon fill="currentColor" points="299.41 176.27 314.92 160.44 316.16 161.69 302.11 175.98 299.41 176.27"/></g></g></g></g></svg>`;
  // Hand-drawn sleeping cat (assets/handdrawn-10), shown in tooltip body
  // when a user hits their daily quota. Fill swapped to currentColor so it
  // inherits the tooltip's text color in either theme.
  const SLEEPING_CAT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 572.58 602.26" aria-hidden="true"><path fill="currentColor" d="M332.81,602.26l-42.68-.1-33.64-3.38-20.04-3.52-37.93-8.32c-16.24-3.56-20.11,1.26-25.52-2.31-5.46-3.6-13.51-6.03-20.73-5.75l-14.91-6.48c-20.6-8.95-40.81-19.08-56.08-35.52-19.24-20.7-28.31-45.52-33.25-72.81-2.29-12.64-1.27-23.93,1.35-36.73,3.12-15.21,15.78-13.71,13.95-20.07-2.79-9.67-11.33-2.66-31.76-5.12-2.35-.28-5.09,1.84-7.71,4.86-1.95,2.24-7.97-1.56-9.68-4.17-1.63-2.48-1.78-10.72,1.18-11.61,14.28-4.41,28.33.07,38.82-3.7l-4.91-21.71-3.47-21.91-4.06-31.68C7.87,281.29-6.52,235.27,2.76,190.48c8.18-11.21,19.02,2.3,49.75,8.96,6.68,1.45,11.81,6.67,17.02,10.49,6.78,4.96,12.61,9.82,17.8,16.58l12.98,16.9c4.13-12.13,6.41-19.3,16.03-26.41-13.29-19.44-23.02-40.65-27.84-63.87-.57-2.73-1.08-5.51-.74-7.21.4-2.04,5.72-3.75,7.88-3.87l24.86-1.32,29.39,1.04c19.32,8.11,36.31,18.88,50.52,33.71,4.04,4.22,9.02,11.46,13.27,13.95l26.76,1.71c8.21.53,22.81-1.2,28.91,4.9l17.31,17.3c14.27-8.99,23.84-5.26,40.87-15.09,3.5-2.02,8.58,4.46,9.27,8.98l24.32,15.44c9.08,5.77,16,12.24,25.18,17.04,17.07,8.92,33.46,8.38,52,11.76l59.96,10.93c13.78,2.51,30.81,12.5,39.74,22.83l25.45,29.42,5.06,20.71c4.44,18.18,4.98,37.56,2.88,56.11l-2.55,22.59c-1.99,17.65-7.91,33.16-15.04,49.2l-9.86,22.21-13.79,20.25-8.91,11.87c-1.52,2.03-5.55,5.04-8.02,7.11l-31.57,26.42-26.16,16.08c-9.98,6.14-16.66,10.72-29.89,11.08-7.74.21-17.22,9.94-24.59,11.59l-38.11,8.55c-8.66,1.94-20.32,3.88-30.09,3.86ZM58.23,339.12l2.96,18.12,6.52,23.31,7.99,15.26c4.7,16.58,17.31,25.31,30.24,34.01,9.1,6.13,13.95,7.51,25.5,7.39l26.26-.28,2.57-18.69c-5.28-2.41-11.1-5.81-12.77-9.4-3.99-8.54,1.62-27.29,7.51-29,4.8-1.39,9.28-.87,15.57-.56,4.43-.58,13.12-4.91,17.06-7.81l23.22-17.09,23.61-14.51c6.98-4.29,14.69-6.51,22.84-8.92l20.4-6.02,3.63-17.81,5.72-33.87c1.29-24.79-11.42-48.95-29.41-65.05l-49.38-2.75c-5.91-4.41-12.38-9.21-17.21-14.59-9.3-10.36-20.87-17.96-32.11-25.9-12.17-8.59-24.4-11.12-39.25-8.63l-15.45,2.59c6.13,18.13,11.62,32.65,22.52,46.25,11.08,13.82,21.18,29.94,37,38.7l32.55,10.18-4.95,4.92c-.66.66.06,2.7.42,4.96-23.93-2.28-46.9-7.93-59.44-28.4-2.39-3.9-7.42-7.39-10.42-5.61-4.07,2.41-5.53,6.59-6.7,10.78-3.48,12.44-1.88,20.73,1.34,31.55l8.97,30.05c1.53,5.13-3.13,14.62-7.17,12.34-11.59-9.84-11.71-24.69-15.88-37.76l-14.24-21.05-12.3-16.5c-4.72-6.34-13.38-14.58-19.35-19.53l-45.18-14.39c-1.07,7.93-1.18,16.69,0,24.73l2.78,18.92,17.99,36.55,9.9,18.19c3.1,5.69,6.2,8.41,14.03,8.3l2.11,27.04ZM310.47,217.51c-8.9,1.03-13.54,3.06-18.42,6.89-.19,3.44,2.54,8.73,5.4,12.14l13.01-19.03ZM456.46,401.37c5.31,4.69,11.75,8.49,15.22,14.89,9.42,17.37,16.86,37.25,14.27,56.48-4.12,3.73-6.53,7.42-9.33,11.93-17.04,27.35-54.24,46.58-86.37,53.68-31.29,6.92-63.49,11.08-95.5,8.83l-47.01-7.95-22-4.69-36.41-9.98c-8.86-2.43-15.11-6.63-22.74-11.14l-23.77-14.07-19.59-16.69-20.59-21.6-11.52-14.3c-5.02-6.23-9.36-10.51-16.93-10.43-1.11-3.32-3.12-6.98-5.13-7.23-8.35-1.07-1.74,14.03-9.04,21.5l9.9,37.74c3.48,13.28,13.47,26.52,22.78,36.68,20.36,22.23,47.65,35.51,76.85,41.13l75.38,14.5,15.84,1.79,35.64,4.94,13.47-1.28c23.75-.17,45.64-1.33,68.79-5.49,13.5-2.43,25.26-9.27,37.81-13.78l33.08-11.87,16.26-9.24,22.44-15.88c9.36-6.62,15.41-16.94,21.72-26.22l9.73-14.3c2.36-3.47,10.57-7.6,12.05-11.26l10.41-25.8,12.84-46.74.18-18.87c.39-41.29,1.75-65.41-34.71-97.14-11.84-11.12-26.09-16.86-42.36-15.57-11.43-5.85-23.38-8.48-35.94-8.67l-24.13-.97c-12.91-.52-22.35-4.51-33.32-11.39l-16.89-6.5-18.38-14.13c-6.99-5.38-14.69-9.33-22.53-12.88l-23.32,34.27c-3.11,4.57-6.05,12.43-2.36,16.21l26.08.02c2.32,0,7.01,3.89,7.64,5.87s-1.45,6.7-2.77,7.5l-33.74,2.54-2.96,18.62c21.61.88,65.3,10.35,63.65,16.95l-2.15,8.57-24.91-5.73-49.88,12.21c-12.22,2.99-25.8,6.91-36.27,12.88l-21.76,12.42-24.37,16.19c-21.35,14.18-28.33,10.51-34.63,14.26-4.12,2.46-6.26,9.47-4.95,13.87,3.7-3.86,12.83-8.05,15.48-1.28,2.79,7.14-2.9,17.22-5.55,24.72,4.09-3.34,8.46-6.21,11.7-4.57,5.03,2.54,6.78,6.54,6.93,13.31,1.36-.57,5.21-2.88,6.33-4.34s-.13-5.89-.96-7.82l-6.29-14.6c6.05-1.05,12.28-.55,17.73.11,6.51-4.54,14.19-9.94,22.08-11.94l70.54-17.89,15.66-2.26c47.12-6.78,53.27-28.9,60.32-25.73,2.53,1.13,5.45,5.44,7.47,9.19-9.89,17.29-29.42,26.18-50.22,27.99l-26.24,2.28-29.49,8.19,4.2,5.13c.88,1.08,4.32.83,5.92.71l14.71-1.08c2.3-.17,6.43,1.37,7.61,3.11l7.78,11.53c1.78,3.85-3.59,12.39-7.78,15.49,5.83,6.27,4.67,12.65.5,20.42l-10.91,20.3-40.04,8.44-20.59,7.86c-16.6,6.34-33.01,8.91-51.93,9.24l18.32,7.33,40.95,10.63,23.8,5c-4.31-10.64,1.74-21.35,9.89-27.48,7.11-5.35,14.24-9.98,22.67-.65l.92-12.91c8.58.97,10.51-3.67,17.12-5.95l34.26-11.85c-4.97-13.08-1.62-23.73,2.08-35.43,12.3-38.92,71.96-55.73,101.25-29.87ZM294.17,314.75l-2.8,4.68,6.07,3.63,2.8-4.68-6.07-3.63ZM280.79,516.61c8.67,2.2,15.69,6.79,24.57,12.93l31.95-.39,18.45-2.19,29.79-4.45c4.01-.6,11.4-2.81,15.13-4.29l20.23-8.02c21.43-8.5,40.09-24.36,51.7-44.56l-6.19-24.78c-2.91-11.64-11.32-23.46-20.77-30.53-21.59-16.16-52.91-.93-74.12,16.68l-4.49,11.71c-5.19,13.53-7.91,28.04,3.81,39.61l-33.78,8.36-16.62,4.67,1.06,12.68-10.83-2.35-1.43,10.32-6.11-3.47c-1.11-.63-4.28,3.48-5.5,3.32l-9.78-1.27c-2.13-.28-5.23,4.16-7.06,6ZM223.13,433.04c6.75-14.39,31.19-9.18,35.54-27.72l-21.83,5.63-28.43,17.03-.04,15.71c7.85.92,11.17-3.01,14.76-10.66ZM155.75,487.2c10.37,3.45,23.15.07,33-.37,26.6-1.19,49.58-11.02,73.67-19.95,8.06-2.99,14.76-2.87,22.23-8.32l14.05-10.26-15.29-4.75c-2.7-.84-3.68-8.35-2.99-11.14l22.44-11.18c-7.32-3.82-13.83,1.43-20.51,4.65-3.69-4.42-11.7-10.19-16.92-6.85-.32,4.34-1.68,12.78-5.07,15.11-1.61,1.11-7.42-2.52-9.54-4.4l-17.65,8.6c3.47,6.15,4.84,9.64,3.99,14.47l-25.73,6.57-27.07,3.58-54.62-1.11,8.92,12.67,17.08,12.67ZM178.17,445.99l-17.95-5.52c-.18.81-.36,4.89.9,5.09l6.65,1.05c4.05.64,10.66.64,10.41-.62Z"/><path fill="currentColor" d="M427.91,109.18l-22.97-14.41-24.78-14.93-17.15-13.4c-2.09-1.63-5.57-6.86-5.15-9.47s4.6-6.29,7.36-7.86l35.36-20.13-34.66-18.86c-1.03-.56-3.15-2.73-3.9-3.57-1.03-1.15,1.73-6.82,3.42-6.54,13.92,2.34,41,18.32,53.73,29.58.38,9.14-8.72,10.25-14.54,12.56-10.65,4.21-18.85,9.43-29.16,16.15,5.41,5.25,10.45,9.88,16.52,13.48l25.21,14.95c7.53,4.46,16.37,9.11,10.72,22.46Z"/><path fill="currentColor" d="M298.89,107.3c-3.21.06-9.81-3.92-9.6-6.7.24-3.1,3.45-7.22,5.22-10.34l19.2-33.76-27.46,6.99c-2.03.52-6.26-.52-7.57-1.52-1.63-1.25-.49-7.47,1.59-7.99l39.12-9.82c2.06-.52,7.37,2.07,8.1,3.88s.12,6.39-.82,8.13l-20.01,37.15c15.54,0,29.17.7,40.75,6.77.15,2.42-1.67,7.3-3.61,7.19l-10.52-.58-34.39.62Z"/><path fill="currentColor" d="M276.79,148.82l-34.89,2.87c-2.67.22-8.4-1.77-10.21-3.86,1.98-6.57,6.23-12.86,10.27-17.95l8.84-11.15c3.83-4.83,7.33-8.2,9.43-12.56l-8.04.19c-1.19.03-1.1,1.14-2.14,4.28l-15.29-6.13,33.54-1.42c1.28,19.56-15.65,23.01-18.82,36.02l27.17,1.2c1.33.06,4.6,3.82,5.1,5.08s-3.06,3.28-4.95,3.43Z"/><path fill="currentColor" d="M448.08,142.15c14.09-6.54,9.82-21.81,15.22-24.55,1.76-.89,5.79,2.42,6.39,4.41,2.71,9.03.44,15.98-5.6,21.45-17.93,16.28-43.25,8.27-43.2,1.65.15-20.63,20.91-39.49,31.51-36.98,2.61.62,6.64,4.13,7.78,6.36-15.23-2.39-25.18,9.5-31.16,21.91l-5.54,4.15c-3.39,2.54,8.41,9.1,24.6,1.59Z"/><path fill="currentColor" d="M363.23,125.41l5.22,14.57c-8.1,7.97-18.55,7.47-28.61,1.22-5.08-3.15-3.66-10.44.17-15.17l3.53-4.37c.98-1.21,6.06.48,5.88,2.04l-.79,7.17c-.21,1.95.84,6,2.49,7s5.19-1.98,6.28-3.63l5.82-8.83Z"/><path fill="currentColor" d="M284.03,171.54c-3.16-.95-8.45-5.16-10.16-9.12,8.53,5.06,18.03,3.87,24.3-3.82l-3.98-4.1c-.74-.76,1.64-4.45,2.69-4.42,2.76.07,6.57,5.82,6.77,9.26-5.26,5.47-12.1,9.85-19.63,12.2Z"/><path fill="currentColor" d="M203.03,283.86l-10.61,18.53c-1.3,2.27-3.56,6.02-5.22,7.21s-7.29-4.13-7.95-6.2c-3.19-10.04,4.8-23.3,12.5-31.84,16.25-18.03,45.07-23.64,51.6-14.35,1.43,2.04,1.71,7.48.25,9.85-16.89-1.68-32.2,2.19-40.57,16.8Z"/><path fill="currentColor" d="M129.29,339.79c-21.59,3.98-23.83,31.08-33.9,39.12l-6.39-16.99c4.97-17.33,15.83-28.17,31.98-35.96,11.77-5.68,37.12-2.61,34.93,8.92l-26.63,4.91Z"/><path fill="currentColor" d="M205.39,351.72c-6.41,9.25-31.24,14.98-30.06,4.84,1.11-9.6,17.8-5.06,24.68-23.51.93-2.49,6.27-5.36,8.88-4.86,2.97.57,6.85,8.59,5.06,11.17l-8.56,12.35Z"/><path fill="currentColor" d="M127.72,384.49c1.36,1.03.79,9.82-.84,9.42l-7.49-1.86c-4.67-1.16-7.15-6.65-4.38-12.85,3.1.71,10.09,3.31,12.71,5.29Z"/><path fill="currentColor" d="M109.97,423.82l-11.89-5.82c-.9-1.87,1.67-9.85,3.82-9.25l8.5,2.36c2.14.59,1.5,5.88-.43,12.71Z"/><path fill="currentColor" d="M242.63,305.26c-6.12-.13-11.74-5.9-10.07-11.73,1.76-1.22,8.79.22,11.18,1.81,2.23,1.49.68,8.62-1.11,9.92Z"/><path fill="currentColor" d="M141.09,403.92c-4.47-1.83-7.84-3.42-9-5.43-1.38-2.39,2.18-10.19,4.28-8.51l6.75,5.48c1.35,1.1-1.01,6.22-2.02,8.46Z"/><path fill="currentColor" d="M272.19,301.24c-3.81,5.77-7.99,5.27-10.63,1.92-2.07-2.63-3.24-6.52-2.12-10.54,4.88.71,11.82,5.05,12.75,8.62Z"/><path fill="currentColor" d="M236.57,328.42l-8.6-8.92c.3-1.34,4.75-6.3,6.2-4.96l6.56,6.04c1.71,1.58-2.45,6.88-4.17,7.85Z"/></svg>`;

  // Hand-drawn star, asset/handdrawn-20 with fills swapped to currentColor
  // so CSS drives the visual state: muted/faded when unsaved, full avocado
  // when saved. Same SVG in both states — only color + opacity change.
  const SAVE_STAR_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 499.45 411.17" aria-hidden="true"><path fill="currentColor" d="M331.22,379.13l-34.8-22.47-38.17-23.65-3.2-2.19c-.83-.57-2.07,1.16-4.17,3.64l-19.3-12.41c-3.51-2.26-11.98-.16-14.69,2.17l-30.26,26.13-23.5,17.29,2.71-7.7c-10.46,9.44-19.82,6.79-28.05-.63l-17.7-15.96c-8.29,1.77-16.74-5.67-16.71-6.42l.28-7.36-5.84,5.07-15.75-12.41.33-14.14-9.32,12.59c.78-11.67,4.06-20.26,8.05-32.95l-7.83,10.62c.71-4.8,1.46-10.62,2.97-14.33l21.58-52.92-10.88-9.18-11.45-10.3-38.08-32.08c-4.46-3.76-12.45-6.99-16.91-8.8l-4.54-8.53-.64-13.14-5.29-9.69c-.7-1.28-4.3-4.59-3.47-5.77l2.92-4.18L0,115.54l11.05-6.01-6.63-1.53,13.31-8.39c.76-.48,3.1-3.4,3.18-2.56l.54,5.69,13.25-2.42,22.13-1.55,37.86-2.95,78.73-7.29c-.71-5.13-3.73-1.17-5.55-4.58.34-.22,2.78-.56,6.75-1,10.04-18.19,16.35-39.76,21.11-61.33,7.52-5.05,15.29,1.23,21.21-5.74,4.66-2.21,14.85,2.54,18.73,5.8l11.27-7.43,9.02-8.54,23.03-5.71c17.05,21.18,29.99,43.69,41.63,68.2l21.54.13c1.42,0,4.73,4.12,5.65,5.55l72.58-5.04,18.66-11.29,1.87,1.61-6.68,6.13,20.06-7.95,8.96,2.85c2.16.69,6.2,4.54,7.25,5.18l-4.84,4.68,13.91-2.04,11.68,5.64-6.22,3.34,3.01,7.44c.78,1.93-2.05,4.86-3.38,6.73l4.77,1.81c.6.23.65.48.27.95l-3.41,4.24,13.13,3.89-10.22,11.53,5.58,6.28c1.46,1.64-3.28,5.83-4.98,7.01.06,1.06.84,5.42-.37,5.61l-7.06,1.1,3.12,5.55-2.74,9.62-22.25,6.61c-7.52,2.23-14.66,1.93-21.34,4.92-17.8,7.95-38.39,18.5-50.14,34.06l17.45,34.46c3.46,6.83,5.56,15.26,6.81,22.07-3.21.72-4.27.63-4.32,1.59l-.32,6.06c-.04.76-2.53,2.69-2.81,1.99l-2.37-5.87c-.06-.12-2.97-.29-3.17.47l-1.65,6.23-15.55,17.72-8.21-9.14-1.3,10.45-8.68-10.02.32,15.43-7.88-10.78,3.5,12.51c-1.08.08-5.86,1.12-7.11-.2l-6.72-7.04,1.14,12.92-4.23-7.9-24.32-45.51-23.64,18.25,8.98,7.97-4.38-.78c-.85-.15-1.84-.34-1.69.19l1.11,3.86,53.22,32.47,30.14,19.96c19.14,12.67,38.95,24.62,54.65,41.06-1.12,1.96-1.71,5.22-1.22,6.86l4.47,15.06-7.57-9.62,2.57,22.74-8.2,3.32c-3.19,1.29-7.86-7.31-15.27-7.68-2.11-.11-2.97,4.56-3.45,7.93l-7.86-4.92,5.35,13.37-13.46-10.25,5.59,11.61-14.33-11.96c-1.54.79-4.93,2.05-6.02,1.53l-14.84-7.12-13.7-8.7-50.05-32.86-1.49,1.95,33.95,22.89,1.52,1.03,22.54,14.73,1.87,1.21,14.04,12.32c-5.64-2.4-12.38-7.09-16.1-10.05l-1.14-.91-22.37-14.92-1.6-1.17ZM403.98,77.55c2.55-.03,5.82-1.78,8.66-4.48l-45.76,1.92c-4.64.19-11.55,1.89-16.38,3.1l53.48-.54ZM384.66,85.27l-25.66-1.14c-2.36-.06-2.13,4.75.14,4.45l25.51-3.31ZM266.52,145.09c-4.14-1.04-9.22-.84-14.2,1.97,3.83,2.13,7.88,1.75,14.2-1.97ZM222.48,211.53l12.67-12.32c.76-.74,3.52-2.23,4.18-1.75l3.42,2.5,18.87-15.4c-1.35-2.59-1.69-5.12-.15-6.65,2.17-2.15,4.23-2.46,8.14.04,2.85-1.18,8.37-5.58,11.9-9.01l-10.04-19.16-15.05,2.43,13.09,3.3-10.32,1.21c-2.2.26-5.5,6.58-7.5,5.74l-8.98-3.79c-3.9,9.71-12.82,1.69-19.72,12.08l-18.13,27.34c6.51,6.07,11.34,9.89,17.63,13.44ZM385.96,268.78c.93-2.22,1.5-4.04,1.48-5.73-.01-1.35-5.31-2.92-4.75-1.65l3.27,7.38Z"/><path fill="currentColor" d="M251.81,187.42l-4.03,4.96c-.4.49-3.25-.27-2.87-.77l3.58-4.59c1.32.16,5.19.63,3.31.4Z"/></svg>`;

  // ----- Saves storage (Plus feature) -----
  // Local-first: stored in chrome.storage.sync so saves follow the user
  // across Chrome instances signed into the same Google account, with a
  // graceful fallback to chrome.storage.local if sync isn't available.
  // Schema per save (~200 bytes — fits 500+ within sync's 100KB quota):
  //   { id, term, isExternal, url?, savedAt, sourcePageTitle?, sourceUrl? }
  const SAVES_KEY = 'savedTooltips';

  function getSavesStorageArea() {
    return chrome.storage?.sync || chrome.storage?.local || null;
  }

  function loadSaves() {
    return new Promise((resolve) => {
      const area = getSavesStorageArea();
      if (!area) return resolve([]);
      area.get(SAVES_KEY, (data) => resolve(Array.isArray(data?.[SAVES_KEY]) ? data[SAVES_KEY] : []));
    });
  }

  function writeSaves(saves) {
    return new Promise((resolve) => {
      const area = getSavesStorageArea();
      if (!area) return resolve(false);
      area.set({ [SAVES_KEY]: saves }, () => resolve(!chrome.runtime?.lastError));
    });
  }

  function saveKeyFor(item) {
    return item.isExternal ? `e:${item.url}` : `w:${item.term}`;
  }

  async function isItemSaved(item) {
    const saves = await loadSaves();
    const key = saveKeyFor(item);
    return saves.some(s => saveKeyFor(s) === key);
  }

  async function addSave(item) {
    const saves = await loadSaves();
    const key = saveKeyFor(item);
    if (saves.some(s => saveKeyFor(s) === key)) return saves;
    const next = [item, ...saves].slice(0, 500); // hard cap
    await writeSaves(next);
    return next;
  }

  async function removeSave(item) {
    const saves = await loadSaves();
    const key = saveKeyFor(item);
    const next = saves.filter(s => saveKeyFor(s) !== key);
    await writeSaves(next);
    return next;
  }

  async function userCanSave() {
    // Saves are free for everyone — they live in the user's own
    // chrome.storage and cost the server nothing. The supporter tier sells
    // unlimited usage, not features.
    return true;
  }

  const UPGRADE_URL = 'https://portaltext.com/#pricing';

  // Recursively render a node + its children. Single-child = vertical
  // stacked descent; multi-child = horizontal sibling spread with a
  // horizontal "T" connector. Renders the parent box, then a vertical
  // edge, then children container (linear or branching).
  function renderEtymNode(node) {
    const parts = ['<div class="pt-etym-node-wrap">'];
    parts.push('<div class="pt-etym-node">');
    if (node.language) parts.push(`<div class="pt-etym-lang">${escapeHtml(node.language)}</div>`);
    parts.push(`<div class="pt-etym-word">${escapeHtml(node.word)}</div>`);
    if (node.gloss) parts.push(`<div class="pt-etym-gloss">"${escapeHtml(node.gloss)}"</div>`);
    parts.push('</div>');
    if (node.children && node.children.length) {
      const branching = node.children.length > 1;
      if (!branching) parts.push('<div class="pt-etym-edge"></div>');
      parts.push(`<div class="pt-etym-children${branching ? ' branching' : ''}">`);
      for (const child of node.children) parts.push(renderEtymNode(child));
      parts.push('</div>');
    }
    parts.push('</div>');
    return parts.join('');
  }

  function renderEtymologyView(bodyEl, data) {
    const parts = [];
    if (data.lookedUpFrom && data.word && data.lookedUpFrom.toLowerCase() !== data.word.toLowerCase()) {
      parts.push(`<div class="pt-etym-from">Showing root: <strong>${escapeHtml(data.word)}</strong> (from "${escapeHtml(data.lookedUpFrom)}")</div>`);
    }
    if (data.ipa) {
      parts.push(`<div class="pt-etym-header-ipa">${escapeHtml(data.ipa)}</div>`);
    }
    if (data.definitions && data.definitions.length) {
      parts.push('<ul class="pt-etym-defs">');
      for (const sec of data.definitions) {
        for (const d of sec.defs) {
          parts.push(`<li class="pt-etym-def"><span class="pt-etym-pos">${escapeHtml(sec.partOfSpeech || '')}</span>${escapeHtml(d)}</li>`);
        }
      }
      parts.push('</ul>');
    }
    if (data.etymology) {
      const { text, chain, tree } = data.etymology;
      parts.push('<div class="pt-etym-tree-label">Etymology</div>');
      if (tree && tree.children && tree.children.length) {
        parts.push('<div class="pt-etym-tree">');
        parts.push(renderEtymNode(tree));
        parts.push('</div>');
      } else if (chain && chain.length) {
        // Legacy fallback for cached/older responses without a tree
        parts.push('<div class="pt-etym-tree">');
        parts.push(`<div class="pt-etym-node"><div class="pt-etym-word">${escapeHtml(data.word)}</div></div>`);
        for (const node of chain) {
          parts.push('<div class="pt-etym-edge"></div>');
          parts.push(`<div class="pt-etym-node">${node.language ? `<div class="pt-etym-lang">${escapeHtml(node.language)}</div>` : ''}<div class="pt-etym-word">${escapeHtml(node.word)}</div>${node.gloss ? `<div class="pt-etym-gloss">"${escapeHtml(node.gloss)}"</div>` : ''}</div>`);
        }
        parts.push('</div>');
      } else if (text) {
        parts.push(`<div class="pt-etym-text">${escapeHtml(text)}</div>`);
      }
    }
    if (!parts.length) {
      bodyEl.innerHTML = `<div class="tt-error">No dictionary entry found.</div>`;
      return;
    }
    bodyEl.innerHTML = parts.join('');
  }

  // ----- /summary client (extension build: routes through the service worker) -----
  // The standalone runtime fetches /summary directly. In the extension, the
  // content script runs in the page's origin (en.wikipedia.org, etc.) and
  // would be blocked by CORS — the service worker has chrome-extension://
  // origin and bypasses CORS via host_permissions. We open a long-lived port,
  // post the request, and receive parsed SSE events back. SSE parsing happens
  // in the worker; here we just dispatch typed events to the same callbacks
  // the standalone version expects.
  async function streamSummary(payload, onDelta, onFinal, onPort) {
    return new Promise((resolve, reject) => {
      let port;
      try {
        port = chrome.runtime.connect({ name: 'pt-summary' });
      } catch (err) {
        reject(new Error('Extension service worker unavailable'));
        return;
      }
      // Hand the port back so callers can disconnect() it when the user
      // dismisses the tooltip mid-stream. Without this, the worker keeps
      // streaming until [DONE] and we pay for a completion the user never
      // sees.
      if (typeof onPort === 'function') onPort(port);
      let settled = false;
      const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

      port.onMessage.addListener((msg) => {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type === 'delta' && msg.text) onDelta(msg.text);
        else if (msg.type === 'final') onFinal(msg);
        else if (msg.type === 'done') settle(resolve);
        else if (msg.type === 'error') {
          const e = new Error(msg.message || 'Summary error');
          if (msg.reason) e.reason = msg.reason;
          if (msg.plan) e.plan = msg.plan;
          settle(reject, e);
        }
      });
      // Worker disconnects when the response completes or errors. If we hit
      // disconnect without a 'done'/'error' first, treat as a graceful end.
      port.onDisconnect.addListener(() => settle(resolve));

      port.postMessage({ type: 'request', payload });
    });
  }

  // ----- Paywall prefetch -----
  // For paywall hosts (NYT etc.) the server's anonymous fetch only sees the
  // article teaser. We work around this by having the SW fetch the URL with
  // the user's session cookies (credentials:'include') and ship the HTML
  // back here; we run Readability locally and pass the extracted text to
  // /summary as `prefetched`. So authenticated content is parsed in-browser
  // — only the cleaned article text crosses our servers.
  //
  // Heuristic: detect by hostname. Match exact + any subdomain; match all
  // common paywalled English-language news sites. Easy to extend.
  const PAYWALL_HOSTS = [
    /(^|\.)nytimes\.com$/i,
    /(^|\.)wsj\.com$/i,
    /(^|\.)bloomberg\.com$/i,
    /(^|\.)ft\.com$/i,
    /(^|\.)washingtonpost\.com$/i,
    /(^|\.)newyorker\.com$/i,
    /(^|\.)theatlantic\.com$/i,
    /(^|\.)economist\.com$/i,
    /(^|\.)wired\.com$/i,
    /(^|\.)theinformation\.com$/i,
  ];
  function urlNeedsPrefetch(url) {
    let u;
    try { u = new URL(url); } catch { return false; }
    const h = u.hostname.toLowerCase();
    return PAYWALL_HOSTS.some(re => re.test(h));
  }

  // Asks the SW to fetch `url` with credentials and ship raw HTML back.
  // Resolves to an HTML string, or rejects on timeout/network/non-HTML.
  function prefetchHtmlViaWorker(url) {
    return new Promise((resolve, reject) => {
      let port;
      try { port = chrome.runtime.connect({ name: 'pt-prefetch' }); }
      catch { reject(new Error('Service worker unavailable')); return; }
      let settled = false;
      port.onMessage.addListener((msg) => {
        if (settled) return;
        settled = true;
        if (msg?.type === 'html' && typeof msg.html === 'string') resolve(msg.html);
        else if (msg?.type === 'error') reject(new Error(msg.message || 'Prefetch failed'));
        else reject(new Error('Unexpected prefetch response'));
        try { port.disconnect(); } catch {}
      });
      port.onDisconnect.addListener(() => { if (!settled) { settled = true; reject(new Error('Prefetch disconnected')); } });
      port.postMessage({ type: 'request', url });
    });
  }

  // Fetches + Readability-extracts a paywall page client-side. Returns
  // { title, content, excerpt } or null on any failure (caller proceeds
  // without prefetched data, falling back to server-side fetch).
  async function prefetchAndExtractPage(url) {
    if (typeof Readability !== 'function') return null;
    let html;
    try { html = await prefetchHtmlViaWorker(url); }
    catch { return null; }
    if (!html || html.length < 200) return null;
    let doc;
    try { doc = new DOMParser().parseFromString(html, 'text/html'); }
    catch { return null; }
    // Set <base> so Readability resolves URLs correctly when interpreting
    // markup (matters mostly for image tags it sometimes serializes).
    if (!doc.querySelector('base')) {
      const base = doc.createElement('base');
      base.href = url;
      doc.head?.appendChild(base);
    }
    try {
      const article = new Readability(doc).parse();
      if (!article || !article.textContent) return null;
      const content = article.textContent.replace(/\s+/g, ' ').trim();
      if (content.length < 200) return null;
      return {
        title: (article.title || doc.title || '').trim().slice(0, 300),
        content: content.slice(0, 6000),
        excerpt: (article.excerpt || '').trim().slice(0, 500),
      };
    } catch {
      return null;
    }
  }

  // ----- Origin context -----
  // Extract the origin page's title + lead so /summary can frame the
  // contextualization in terms of where the reader currently is. Uses Mozilla
  // Readability over the live document; falls back to <h1>/<h2> + body
  // textContent on list-shaped pages where Readability bails.
  let currentArticle = null;
  // The URL that was current when currentArticle was extracted. Used as a
  // stale-guard in getCurrentContext: if the user has SPA-navigated since
  // (Reddit feed → thread → back), we'd rather send no context than wrong
  // context. Set at the end of refreshOriginContext, cleared the instant
  // we detect a URL change.
  let extractedAtUrl = null;

  function getCurrentContext() {
    if (!currentArticle) return null;
    if (extractedAtUrl !== location.href) return null;
    return { title: currentArticle.title, lead: currentArticle.lead };
  }

  function refreshOriginContext() {
    const urlAtStart = location.href;
    try {
      if (typeof Readability === 'function') {
        const article = new Readability(document.cloneNode(true)).parse();
        if (article && article.textContent && article.textContent.trim().length > 200) {
          currentArticle = {
            title: (article.title || document.title || 'this page').trim(),
            lead: article.textContent.replace(/\s+/g, ' ').trim().slice(0, 500)
          };
          extractedAtUrl = urlAtStart;
          return;
        }
      }
    } catch (err) {
      console.warn('Readability extraction failed:', err.message);
    }
    const titleEl = document.querySelector('main h1, main h2, h1, h2');
    const title = (titleEl?.textContent || document.title || 'this page').trim();
    const lead = (document.body?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    currentArticle = lead.length > 50 ? { title, lead } : null;
    extractedAtUrl = currentArticle ? urlAtStart : null;
  }

  // Resolves the origin context to send with a /summary request. Four sources,
  // in order of precedence:
  //
  // 1. Chain root: if the trigger is inside any tooltip currently on the stack,
  //    use the bottom-most tooltip (STACK[0], the one opened directly from the
  //    page) as the context for every recursive hover that follows. The reader
  //    entered the chain via that tooltip — its title and rendered body frame
  //    the whole exploration. Especially valuable when the page itself has
  //    little context to offer (image-only pages, list views) and the first
  //    tooltip is what carries the actual subject.
  //
  // 2. data-ctx-*: walking up from the trigger, the nearest ancestor with
  //    data-ctx-title / data-ctx-lead wins. Lets hosts scope context per-block
  //    (HN comments, Bible chapters, sidebars).
  //
  // 3. Site-specific block extractors (SPAs where the page-level extractor
  //    returns nothing useful — Twitter is the headliner). Walks up from the
  //    trigger to a site-known container (e.g. <article> on Twitter = one
  //    tweet) and extracts that block's text. Runs BEFORE page-level because
  //    on Twitter, body.textContent will happily return 10kB of sidebar/nav
  //    junk that scores as "valid" context but is actually noise — the per-
  //    block extraction is much more relevant when it applies. Strictly
  //    per-hover; not cached.
  //
  // 4. Page-level currentArticle, set by refreshOriginContext (Readability).
  function getContextForElement(el) {
    // Saves opened from the popup explicitly want no context — the saved
    // tooltip is meant to be the start of a fresh chain, not anchored to
    // wherever the user happens to be browsing now.
    if (el?.hasAttribute?.('data-portaltext-saved-anchor')) return null;
    if (STACK.length > 0 && STACK.some(s => s.shadow.contains(el))) {
      const root = STACK[0];
      const title = (root.el.querySelector('h3')?.textContent || root.term || '').trim();
      const lead = (root.el.querySelector('.body')?.textContent || '')
        .replace(/\s+/g, ' ').trim().slice(0, 500);
      if (title && lead.length > 50) return { title, lead };
      // Root tooltip body too short or still streaming — fall through to other sources
    }
    let n = el;
    while (n && n.dataset !== undefined) {
      if (n.dataset.ctxTitle) {
        return { title: n.dataset.ctxTitle, lead: n.dataset.ctxLead || '' };
      }
      n = n.parentElement;
    }
    const siteCtx = extractSiteSpecificContext(el);
    if (siteCtx) return siteCtx;
    const localCtx = extractLocalContext(el);
    if (localCtx) return localCtx;
    return getCurrentContext();
  }

  // Extract context FROM THE TRIGGER'S NEIGHBORHOOD rather than the page lede.
  // For most general sites (news articles, blogs, Wikipedia, docs), a link
  // halfway down a page appears in a paragraph that has nothing to do with
  // the article's opening 500 chars. Grabbing ~250 chars on either side of
  // the trigger — plus the nearest preceding heading and the site name —
  // gives the model the actual semantic context of where the link lives.
  // Returns null if surrounding text is too thin (e.g. very short page),
  // which falls through to the page-level lead as before.
  function extractLocalContext(el) {
    if (!el || el.nodeType !== 1) return null;
    // Find a container with enough surrounding text. Walk up to the nearest
    // ancestor with at least ~200 chars of content, but don't go all the way
    // to <body> on huge pages — that pulls in nav and footer noise.
    let block = el.parentElement;
    let safety = 0;
    while (block && safety < 12) {
      const len = (block.textContent || '').length;
      if (len >= 200 && len <= 20000) break;
      block = block.parentElement;
      safety++;
    }
    if (!block) return null;
    let beforeText = '';
    let afterText = '';
    try {
      const beforeRange = document.createRange();
      beforeRange.selectNodeContents(block);
      beforeRange.setEndBefore(el);
      beforeText = beforeRange.toString().replace(/\s+/g, ' ').trim();
      const afterRange = document.createRange();
      afterRange.selectNodeContents(block);
      afterRange.setStartAfter(el);
      afterText = afterRange.toString().replace(/\s+/g, ' ').trim();
    } catch { /* ranges can throw if el isn't fully inside block — fall through */ }
    if (beforeText.length + afterText.length < 80) return null;
    // 250 char budget per side, but if one side runs short, give the slack
    // to the other. Total ≈ 500 chars, matching the existing page-lead size.
    const BUDGET = 500;
    const halfBefore = Math.min(beforeText.length, Math.floor(BUDGET / 2));
    const halfAfter = Math.min(afterText.length, BUDGET - halfBefore);
    const finalBefore = Math.min(beforeText.length, BUDGET - halfAfter);
    const before = beforeText.slice(-finalBefore);
    const after = afterText.slice(0, halfAfter);
    // Find the nearest preceding heading in document order (h1–h4). Gives
    // the model a section anchor for stories with clear structure.
    const header = findNearestHeader(el);
    const siteName = getPageSiteName();
    const pageTitle = currentArticle?.title || document.title || 'this page';
    // Pack into a single lead string with light prose framing. Keeping
    // structure in the existing { title, lead } shape means no server-side
    // changes — the model just sees a more contextually relevant lead.
    const headerLine = header ? `[Section: ${header}] ` : '';
    const siteLine   = siteName ? `On ${siteName}. ` : '';
    const lead = `${siteLine}${headerLine}${before} [LINK] ${after}`.slice(0, 600);
    return { title: pageTitle, lead };
  }

  function findNearestHeader(el) {
    const headers = document.querySelectorAll('h1, h2, h3, h4');
    let nearest = null;
    for (const h of headers) {
      // Heading must appear BEFORE el in document order, and not be el itself.
      if (h === el) continue;
      if (h.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) {
        nearest = h;
      } else {
        break; // we've passed el's position; earlier candidates win
      }
    }
    if (!nearest) return null;
    return (nearest.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120) || null;
  }

  function getPageSiteName() {
    const og = document.querySelector('meta[property="og:site_name"]')?.getAttribute('content');
    if (og && og.trim()) return og.trim().slice(0, 60);
    try {
      const h = location.hostname.replace(/^www\./, '').replace(/^m\./, '').replace(/^mobile\./, '');
      // Strip TLD for cleaner display ("nytimes" not "nytimes.com")
      const stem = h.split('.').slice(0, -1).join('.');
      return (stem || h).slice(0, 60);
    } catch {
      return null;
    }
  }

  // Per-host fallback context extractors for SPAs where Readability returns
  // nothing useful. Each extractor walks UP from the hover trigger to find
  // the smallest containing block of meaningful text on that site, so the
  // tooltip is framed by (e.g.) the specific tweet the link is in rather than
  // the whole page or no context at all.
  function extractSiteSpecificContext(el) {
    const host = location.hostname.replace(/^www\./, '').replace(/^mobile\./, '').replace(/^m\./, '');
    if (host === 'twitter.com' || host === 'x.com') return extractTwitterContext(el);
    if (host === 'youtube.com' || host === 'youtu.be') return extractYouTubeContext();
    if (host === 'reddit.com' || host.endsWith('.reddit.com')) return extractRedditContext(el);
    return null;
  }

  // YouTube is an SPA — the URL changes when you switch videos but the
  // document doesn't reload, so cached page-level context goes stale instantly.
  // Read the OG meta tags fresh at each hover; YouTube SSRs them and updates
  // them on SPA navigation, so they always reflect the CURRENT video.
  function extractYouTubeContext() {
    const title = document.querySelector('meta[property="og:title"]')?.getAttribute('content')
      || document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
    const desc = document.querySelector('meta[property="og:description"]')?.getAttribute('content') || '';
    if (!title) return null;
    return { title: title.slice(0, 200), lead: desc.slice(0, 500) };
  }

  function extractTwitterContext(el) {
    // Twitter wraps every tweet (in feeds, replies, quote tweets, threads) in
    // an <article> element. Hovers outside any article (trending sidebar,
    // sidebar nav, etc.) get no useful context — fall through to none.
    const article = el.closest('article');
    if (!article) {
      console.log('[portaltext] twitter: no <article> ancestor for', el);
      return null;
    }
    const text = (article.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length < 30) {
      console.log('[portaltext] twitter: article found but text too short', text.length);
      return null;
    }
    // Pull the author @handle from the first profile-style internal link in
    // the article. Twitter handles are /[A-Za-z0-9_]+ at the path root.
    let handle = '';
    for (const a of article.querySelectorAll('a[href^="/"]')) {
      const href = a.getAttribute('href');
      if (/^\/[A-Za-z0-9_]{1,15}$/.test(href)) { handle = href.slice(1); break; }
    }
    const ctx = {
      title: handle ? `A tweet by @${handle}` : 'A tweet',
      lead: text.slice(0, 500),
    };
    console.log('[portaltext] twitter context:', ctx.title, '/', ctx.lead.slice(0, 120) + '…');
    return ctx;
  }

  // Reddit per-post / per-comment context. On the front page and any feed,
  // page-level Readability picks the densest text block and uses it as the
  // frame for every hover — which means hovering a link in post B gets
  // summarized as if the reader is reading post A. We avoid that by walking
  // up to the nearest <shreddit-post> (new Reddit) or div.thing (old Reddit)
  // and framing on that specific post. For thread pages, comments get the
  // same treatment so links inside a deep reply aren't framed as the OP.
  function extractRedditContext(el) {
    const post = el.closest?.('shreddit-post');
    if (post) {
      const title = post.getAttribute('post-title') || '';
      const sub = post.getAttribute('subreddit-prefixed-name')
        || (post.getAttribute('subreddit-name') ? `r/${post.getAttribute('subreddit-name')}` : '');
      const author = post.getAttribute('author') ? `u/${post.getAttribute('author')}` : '';
      if (title) {
        const parts = ['A Reddit post'];
        if (sub) parts.push(`in ${sub}`);
        if (author) parts.push(`by ${author}`);
        parts.push(`titled "${title}".`);
        // If it's a text post, append the body so Claude has something
        // substantive to lean on; for link/image posts the title is all we get.
        const bodyEl = post.querySelector('[slot="text-body"], .post-rtjson-content, .md');
        const body = (bodyEl?.textContent || '').replace(/\s+/g, ' ').trim();
        const lead = body.length > 30
          ? `${parts.join(' ')} ${body.slice(0, 1500)}`
          : parts.join(' ');
        const ctx = { title: title.slice(0, 200), lead: lead.slice(0, 500) };
        console.log('[portaltext] reddit post context:', ctx.title);
        return ctx;
      }
    }
    const comment = el.closest?.('shreddit-comment');
    if (comment) {
      const author = comment.getAttribute('author') ? `u/${comment.getAttribute('author')}` : 'an anonymous user';
      const text = (comment.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length >= 30) {
        const ctx = { title: `A Reddit comment by ${author}`, lead: text.slice(0, 500) };
        console.log('[portaltext] reddit comment context:', ctx.title);
        return ctx;
      }
    }
    // Old Reddit (old.reddit.com) keeps everything in flat DOM with data-*.
    const oldPost = el.closest?.('div.thing.link');
    if (oldPost) {
      const title = (oldPost.querySelector('a.title')?.textContent || '').trim();
      const sub = oldPost.getAttribute('data-subreddit') ? `r/${oldPost.getAttribute('data-subreddit')}` : '';
      const author = oldPost.getAttribute('data-author') ? `u/${oldPost.getAttribute('data-author')}` : '';
      if (title) {
        const parts = ['A Reddit post'];
        if (sub) parts.push(`in ${sub}`);
        if (author) parts.push(`by ${author}`);
        parts.push(`titled "${title}".`);
        const ctx = { title: title.slice(0, 200), lead: parts.join(' ').slice(0, 500) };
        console.log('[portaltext] old-reddit post context:', ctx.title);
        return ctx;
      }
    }
    const oldComment = el.closest?.('div.thing.comment');
    if (oldComment) {
      const authorEl = oldComment.querySelector('a.author');
      const author = authorEl?.textContent ? `u/${authorEl.textContent}` : 'an anonymous user';
      const body = (oldComment.querySelector('.usertext-body')?.textContent || '').replace(/\s+/g, ' ').trim();
      if (body.length >= 30) {
        const ctx = { title: `A Reddit comment by ${author}`, lead: body.slice(0, 500) };
        console.log('[portaltext] old-reddit comment context:', ctx.title);
        return ctx;
      }
    }
    return null;
  }

  // ----- Circular-link pruning -----
  // After a tooltip's final HTML lands, walk the body and strip any wikilink
  // or extlink that would point right back to where the reader already is.
  // Two flavors of "circular":
  //   - matches the current page (Wikipedia article, page URL)
  //   - matches any tooltip currently on the stack (the chain root, ancestors,
  //     or this tooltip itself — clicking would open a duplicate)
  // We strip rather than disable so the text remains readable; the underlying
  // word stays in place, just no longer hoverable.
  //
  // The server-side prompt already tells Claude not to emit these (`dontLink`
  // list in buildPrompt), but Claude occasionally slips past — this is the
  // defense-in-depth runtime guard.
  function pruneCircularLinks(rootEl) {
    const stackIds = new Set();
    for (const item of STACK) if (item.term) stackIds.add(normalizeId(item.term));

    let pageWikiTitle = null;
    if (/(^|\.)wikipedia\.org$/i.test(location.hostname) && location.pathname.startsWith('/wiki/')) {
      try {
        pageWikiTitle = decodeURIComponent(location.pathname.slice(6).split('#')[0]).replace(/_/g, ' ');
      } catch { /* malformed pathname — ignore */ }
    }
    const pageUrl = canonicalizeUrl(location.href);

    for (const a of rootEl.querySelectorAll('a.wikilink')) {
      const id = normalizeId(a.dataset.term || '');
      if (!id) continue;
      const isCircular = stackIds.has(id) || (pageWikiTitle && normalizeId(pageWikiTitle) === id);
      if (isCircular) a.replaceWith(document.createTextNode(a.textContent));
    }
    for (const a of rootEl.querySelectorAll('a.extlink')) {
      const url = a.dataset.url || '';
      if (!url) continue;
      const isCircular = stackIds.has(normalizeId(url)) || canonicalizeUrl(url) === pageUrl;
      if (isCircular) a.replaceWith(document.createTextNode(a.textContent));
    }
  }

  function normalizeId(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }

  function canonicalizeUrl(s) {
    try {
      const u = new URL(s, location.href);
      return (u.origin + u.pathname).replace(/\/$/, '').toLowerCase();
    } catch {
      return String(s).toLowerCase();
    }
  }

  // ----- Tooltip stack engine -----
  // Wait this long after a stable hover before opening the tooltip AND
  // firing the inference call. Higher = fewer wasted model calls when the
  // cursor is just passing over a link en route to clicking it; lower =
  // snappier feel for actual hovers. 750ms matches the macOS default for
  // hover affordances — a deliberate park without feeling sluggish.
  // The nested delay is shorter because once a tooltip is already open, the
  // user is in "portaltext mode" — they've committed to the experience and
  // need less ambiguity time before triggering a recursive hover.
  const HOVER_OPEN_DELAY = 750;           // ms before opening (page-level hover)
  const HOVER_OPEN_DELAY_NESTED = 600;    // ms before opening (in-tooltip hover)
  const HOVER_CLOSE_DELAY = 220;  // ms before closing after mouse leaves chain
  const LOCK_DELAY = 1900;        // ms of engagement before chain locks in place
  const FULL_OPACITY_COUNT = 4;            // most recent N tooltips at full opacity
  const FADE_TIERS = [0.7, 0.45, 0.25, 0.1]; // older ones fade through these
  const MAX_VISIBLE = FULL_OPACITY_COUNT + FADE_TIERS.length;
  const STACK = []; // [{ el, term, trigger, depth, locked, lockTimer, ... }]
  let openTimer = null;
  let closeTimer = null;
  let lastCursorX = 0;
  let lastCursorY = 0;
  // When optional Ctrl activation is enabled, keep our own key state so
  // pressing Ctrl after the cursor is already parked on a link works too.
  let ctrlActivationHeld = false;
  let lastHoverTarget = null;

  document.addEventListener('mousemove', (e) => {
    lastCursorX = e.clientX;
    lastCursorY = e.clientY;
    // Belt-and-suspenders close trigger: if there's an open chain and the
    // cursor isn't over any of it, schedule the global close. mouseleave on
    // the trigger / tooltip body would normally handle this, but on SPAs
    // that recycle DOM nodes (Reddit, anything React-heavy) the trigger
    // reference can become detached without firing mouseleave — without
    // this poll, the chain hangs around until Esc / mousedown / depth-pop.
    if (STACK.length === 0) return;
    if (!isCursorOverChain()) {
      maybeScheduleGlobalClose();
    } else if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
  });

  function recalculateChainOpacities() {
    while (STACK.length > MAX_VISIBLE) {
      removeTooltip(STACK.shift());
    }
    for (let i = 0; i < STACK.length; i++) {
      const item = STACK[i];
      item.el.style.zIndex = String(1000 + i);
      if (item.locked) {
        item.el.style.opacity = '1';
        continue;
      }
      const distance = STACK.length - 1 - i;
      const opacity = distance < FULL_OPACITY_COUNT
        ? 1
        : FADE_TIERS[distance - FULL_OPACITY_COUNT];
      item.el.style.opacity = String(opacity);
    }
  }

  function onItemEnter(item) {
    item.engagedCount++;
    if (item.closeTimer) { clearTimeout(item.closeTimer); item.closeTimer = null; }
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
  }

  function onItemLeave(item) {
    item.engagedCount--;
    if (item.engagedCount < 0) item.engagedCount = 0;
    if (item.engagedCount === 0) maybeScheduleItemClose(item);
    // Always check global close — engagedCount can drift after re-orderings; :hover is the
    // browser's source of truth for whether the cursor is actually on the chain
    maybeScheduleGlobalClose();
  }

  // Topmost unlocked tooltip closes when its link/body is no longer hovered
  function maybeScheduleItemClose(item) {
    if (item.closeTimer || item.engagedCount > 0 || item.locked) return;
    if (STACK[STACK.length - 1] !== item) return;
    item.closeTimer = setTimeout(() => {
      item.closeTimer = null;
      if (!STACK.includes(item) || item.engagedCount > 0 || item.locked) return;
      if (STACK[STACK.length - 1] !== item) return;
      STACK.pop();
      removeTooltip(item);
      recalculateChainOpacities();
      if (STACK.length > 0) maybeScheduleItemClose(STACK[STACK.length - 1]);
    }, HOVER_CLOSE_DELAY);
  }

  // Whole chain closes when no item is being engaged (mouse off everything).
  // Combines two sources of truth — :hover (accurate when trigger is alive
  // and DOM is stable) AND a rect-based cursor check (works even when the
  // trigger has been detached by an SPA re-render, which is the Reddit case
  // — React replaces post nodes constantly, so our stored trigger reference
  // becomes a stale orphan that never fires mouseleave and reports stale
  // :hover state).
  function isAnyChainElementHovered() {
    if (STACK.some(s => s.el.matches?.(':hover'))) return true;
    if (STACK.some(s => s.trigger.isConnected && s.trigger.matches?.(':hover'))) return true;
    return isCursorOverChain();
  }

  function isCursorOverChain() {
    const x = lastCursorX, y = lastCursorY;
    const hit = (r) => r && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    for (const item of STACK) {
      // Saved-tooltip items don't auto-close on mousemove — they were opened
      // by an explicit user click in the popup, not a hover, and the cursor
      // probably isn't anywhere near them. They stay open until dismissed
      // by Esc / click-outside / hovering a different page link.
      if (item.openedFromSave) return true;
      if (hit(item.el.getBoundingClientRect())) return true;
      // Live trigger rect first (it follows scroll/layout shifts), but fall
      // back to the cached rect from open-time when the trigger has been
      // detached. Reddit recycles IMG elements under us — without this
      // fallback, every detach immediately schedules a close, which then
      // fires before Reddit re-attaches a fresh node, so the tooltip
      // open/close-loops at the cursor's position.
      let tr = null;
      if (item.trigger.isConnected) {
        const live = item.trigger.getBoundingClientRect();
        if (live.width > 0 && live.height > 0) tr = live;
      }
      if (!tr) tr = item.triggerRectAtOpen;
      if (hit(tr)) return true;
      // hoverHost rect — the conceptual hover region. On Reddit this is the
      // overlay link covering the whole post, which is much larger than the
      // IMG we picked as trigger; without this the tooltip would close as
      // soon as the user moves off the image area but is still on the post.
      let hr = null;
      if (item.hoverHost?.isConnected) {
        const live = item.hoverHost.getBoundingClientRect();
        if (live.width > 0 && live.height > 0) hr = live;
      }
      if (!hr) hr = item.hoverHostRectAtOpen;
      if (hit(hr)) return true;
    }
    return false;
  }

  function maybeScheduleGlobalClose() {
    if (closeTimer || STACK.length === 0) return;
    if (isAnyChainElementHovered()) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      if (isAnyChainElementHovered()) return;
      closeAllTooltips();
    }, HOVER_CLOSE_DELAY);
  }

  function startLockTimer(item) {
    if (item.locked || item.lockTimer) return;
    item.lockTimer = setTimeout(() => {
      item.lockTimer = null;
      if (!STACK.includes(item)) return;
      lockTooltip(item);
    }, LOCK_DELAY);
  }

  function lockTooltip(item) {
    // Single-lock invariant: only one tooltip is locked at a time
    STACK.forEach(s => {
      if (s !== item && s.locked) {
        s.locked = false;
        s.el.classList.remove('locked');
      }
    });
    item.locked = true;
    item.el.classList.add('locked');
    if (item.lockTimer) { clearTimeout(item.lockTimer); item.lockTimer = null; }
    if (item.closeTimer) { clearTimeout(item.closeTimer); item.closeTimer = null; }
    // Promote to top of stack — z-index from recalculateChainOpacities handles visual ordering
    const idx = STACK.indexOf(item);
    if (idx !== -1 && idx !== STACK.length - 1) {
      STACK.splice(idx, 1);
      STACK.push(item);
    }
    recalculateChainOpacities();
  }

  function depthOfContainer(el) {
    // If link is inside a tooltip, return that tooltip's depth + 1.
    // Else it's in the host page: depth 0.
    for (let i = STACK.length - 1; i >= 0; i--) {
      if (STACK[i].shadow.contains(el)) return i + 1;
    }
    return 0;
  }

  function openTooltip(cls, trigger, depth, hoverHost) {
    const { isExternal, payload: term } = cls;
    const headerLabel = isExternal ? hostnameOf(term) : term;

    // Tooltips live inside a shadow root so the page's CSS can't reach in
    // (Flickr making our <h3> bigger, etc.). The host is a bare <div> with
    // no styles of its own — it's just a mount point in document.body.
    // The actual tooltip element is inside the shadow tree.
    const host = document.createElement('div');
    host.setAttribute('data-portaltext-host', '');
    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = TOOLTIP_STYLES;
    shadow.appendChild(style);

    const el = document.createElement('div');
    el.className = 'tooltip';
    el.dataset.depth = depth;
    el.dataset.theme = currentTheme;
    const showEtymBtn = !isExternal && isSingleWordTerm(term) && !etymologyMissCache.has(term.toLowerCase());
    el.innerHTML = `
      <h3>${escapeHtml(headerLabel)}</h3>
      <button class="pt-save-btn" type="button" title="Save tooltip" aria-label="Save">${SAVE_STAR_SVG}</button>
      ${showEtymBtn ? `<button class="pt-etym-btn" type="button" title="Dictionary & etymology" aria-label="Show etymology">${ETYM_ARROW_SVG}</button>` : ''}
      <div class="body"><div class="loading"><div class="pt-spinner"><div class="pt-spinner-frame pt-spinner-small"></div><div class="pt-spinner-frame pt-spinner-medium"></div><div class="pt-spinner-frame pt-spinner-big"></div></div></div></div>
    `;
    shadow.appendChild(el);

    // Attach hover handlers to the shadow root too — Chrome suppresses
    // mouseover/mouseout at document level for moves WITHIN a shadow tree
    // (both endpoints retarget to the same host). Without these, hovering
    // a wikilink inside an open tooltip would never trigger a recursive
    // tooltip because the document handler doesn't see those events.
    shadow.addEventListener('mouseover', handleMouseover);
    shadow.addEventListener('mouseout', handleMouseout);

    document.body.appendChild(host);
    positionTooltip(el, trigger);
    requestAnimationFrame(() => el.classList.add('visible'));

    trigger.classList.add('active');

    const item = {
      el, host, shadow, term, trigger, depth,
      // Snapshot the trigger's viewport rect now — we need it as a fallback
      // for the close-on-mousemove rect check after Reddit (and any other
      // SPA that recycles DOM under us) detaches the live trigger node.
      triggerRectAtOpen: trigger.getBoundingClientRect(),
      // hoverHost is the original cursor target when the tooltip resolved
      // (e.g. Reddit's A.absolute.inset-0 overlay covering the whole post).
      // Tracking its rect lets us treat the cursor as "still hovering" while
      // it's anywhere inside the conceptual hover region, not only over the
      // IMG we actually summarize.
      hoverHost: hoverHost || null,
      hoverHostRectAtOpen: hoverHost ? hoverHost.getBoundingClientRect() : null,
      locked: false, lockTimer: null, closeTimer: null, engagedCount: 0,
      handlers: null
    };

    const enter = () => onItemEnter(item);
    const leave = () => onItemLeave(item);
    const triggerEnter = () => { onItemEnter(item); startLockTimer(item); };
    const triggerLeave = () => {
      if (item.lockTimer) { clearTimeout(item.lockTimer); item.lockTimer = null; }
      onItemLeave(item);
    };

    el.addEventListener('mouseenter', enter);
    el.addEventListener('mouseleave', leave);
    trigger.addEventListener('mouseenter', triggerEnter);
    trigger.addEventListener('mouseleave', triggerLeave);
    item.handlers = { enter, leave, triggerEnter, triggerLeave };

    STACK.push(item);
    recalculateChainOpacities();

    // Mouse is currently on the trigger (its hover opened this tooltip) — bump count + start lock
    triggerEnter();

    // Stream the AI summary directly into the body — text-only during the stream
    // (so no <a> children are created and torn down), then swap in the verified
    // HTML when the final event arrives. Link color fades in via the
    // .just-finalized class.
    const bodyEl = el.querySelector('.body');

    // Etymology view state shared with the summary stream's onFinal callback —
    // a late-arriving final event must not clobber the etymology view if the
    // user clicked in mid-stream. onFinal writes latestSummaryHtml regardless
    // but only repaints bodyEl when etymView is false.
    item.etymView = false;
    item.latestSummaryHtml = null;

    // ----- Save (star) button -----
    // Click → toggle save state. Plus user: persists to chrome.storage.sync.
    // Free user: opens the pricing section in a new tab (popup may not be
    // open so a chip-style prompt would be invisible — sending them to
    // /staging#pricing is the clearest path).
    const saveBtn = el.querySelector('.pt-save-btn');
    if (saveBtn) {
      const saveItem = isExternal
        ? { isExternal: true,  url: term }
        : { isExternal: false, term };
      // Reflect current save state asynchronously after the tooltip mounts.
      isItemSaved(saveItem).then((saved) => {
        if (saved) {
          saveBtn.classList.add('saved');
          saveBtn.setAttribute('aria-label', 'Unsave');
          saveBtn.title = 'Unsave';
        }
      });
      saveBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const canSave = await userCanSave();
        if (!canSave) {
          chrome.tabs?.create?.({ url: UPGRADE_URL })
            || window.open(UPGRADE_URL, '_blank');
          return;
        }
        const wasSaved = saveBtn.classList.contains('saved');
        if (wasSaved) {
          await removeSave(saveItem);
          saveBtn.classList.remove('saved');
          saveBtn.setAttribute('aria-label', 'Save');
          saveBtn.title = 'Save tooltip';
        } else {
          // Capture the AI-generated h3 title if the stream has finalized,
          // so the saves list shows "Mona Lisa — Leonardo da Vinci" instead
          // of "en.wikipedia.org". Falls back to the raw term/URL if the
          // header hasn't populated yet (user clicked save mid-stream).
          const headerText = (el.querySelector('h3')?.textContent || '').trim();
          const record = {
            ...saveItem,
            id: crypto.randomUUID ? crypto.randomUUID() : `s_${Date.now()}_${Math.random().toString(36).slice(2,8)}`,
            savedAt: Date.now(),
            displayTitle: headerText.slice(0, 140),
            sourceSiteName: getPageSiteName(),
            sourceUrl: location.href.slice(0, 500),
            // Preserve the language the tooltip was generated in. When the
            // save is reopened later we re-render in this same language
            // rather than the user's current preference — saves should
            // come back the way they were saved, not retranslated.
            lang: (preferredLanguage && preferredLanguage !== 'auto') ? preferredLanguage : null,
          };
          await addSave(record);
          saveBtn.classList.add('saved', 'flash');
          saveBtn.setAttribute('aria-label', 'Unsave');
          saveBtn.title = 'Unsave';
          setTimeout(() => saveBtn.classList.remove('flash'), 360);
        }
      });
    }

    const etymBtn = el.querySelector('.pt-etym-btn');
    if (etymBtn) {
      let loading = false;
      etymBtn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        if (loading) return;
        if (item.etymView) {
          bodyEl.classList.remove('etymology');
          if (item.latestSummaryHtml !== null) bodyEl.innerHTML = item.latestSummaryHtml;
          etymBtn.classList.remove('active');
          item.etymView = false;
          return;
        }
        item.latestSummaryHtml = bodyEl.innerHTML;
        loading = true;
        bodyEl.classList.add('etymology');
        bodyEl.innerHTML = `<div class="loading"><div class="pt-spinner"><div class="pt-spinner-frame pt-spinner-small"></div><div class="pt-spinner-frame pt-spinner-medium"></div><div class="pt-spinner-frame pt-spinner-big"></div></div></div>`;
        etymBtn.classList.add('active');
        item.etymView = true;
        try {
          const data = await requestEtymology(term);
          if (!STACK.includes(item)) return;
          renderEtymologyView(bodyEl, data);
        } catch (err) {
          if (!STACK.includes(item)) return;
          bodyEl.innerHTML = `<div class="tt-error">No dictionary entry found.</div>`;
          // 404 already added to etymologyMissCache in requestEtymology — also
          // hide the button on this tooltip going forward (user already saw the miss).
          etymBtn.style.display = 'none';
        } finally {
          loading = false;
        }
      });
    }

    // Expansion is locked to grow downward: after the initial positionTooltip
    // call, top stays anchored so the reader's eyeline doesn't jump when
    // streaming text, the final HTML, or the etymology view changes height.
    function maybeReposition() { /* intentionally no-op */ }

    const ctx = getContextForElement(trigger);
    // Saved-tooltip anchors carry the lang they were saved in; otherwise
    // fall back to the user's current global preference.
    const savedLang = trigger?.getAttribute?.('data-portaltext-saved-lang');
    const effectiveLang = savedLang
      || (preferredLanguage && preferredLanguage !== 'auto' ? preferredLanguage : null);
    const lang = effectiveLang;
    const summaryRequest = isExternal
      ? { url: term, context: ctx, ...(cls.linkUrl ? { linkUrl: cls.linkUrl } : {}), ...(lang ? { lang } : {}) }
      : { target: term, context: ctx, ...(lang ? { lang } : {}) };

    async function startStream() {
      let streamBuffer = '';
      let streamTextNode = null;
      bodyEl.classList.remove('just-finalized');
      bodyEl.innerHTML = `<div class="loading"><div class="pt-spinner"><div class="pt-spinner-frame pt-spinner-small"></div><div class="pt-spinner-frame pt-spinner-medium"></div><div class="pt-spinner-frame pt-spinner-big"></div></div></div>`;

      function ensureStreamNode() {
        if (streamTextNode) return;
        // Fade the spinner out smoothly rather than yanking it. The
        // .fading-out class transitions opacity 1 → 0 over 220ms; after
        // that it gets removed and the streaming text node takes its
        // place. Anything that already arrived is buffered, so the brief
        // overlap doesn't drop characters.
        const loadingEl = bodyEl.querySelector('.loading');
        if (loadingEl) {
          loadingEl.classList.add('fading-out');
          setTimeout(() => loadingEl.remove(), 220);
        }
        streamTextNode = document.createTextNode('');
        bodyEl.appendChild(streamTextNode);
      }

      // Paywall prefetch: when the URL is a known paywall host, fetch +
      // Readability locally with the user's session cookies and pass the
      // extracted text through as `prefetched`. Server then skips its own
      // (anonymous) fetch and uses our text directly. Any failure (timeout,
      // CORS, no Readability content) silently falls back to server fetch.
      let finalRequest = summaryRequest;
      if (isExternal && urlNeedsPrefetch(term) && STACK.includes(item)) {
        const prefetched = await prefetchAndExtractPage(term);
        if (prefetched && STACK.includes(item)) {
          finalRequest = { ...summaryRequest, prefetched };
        }
      }
      if (!STACK.includes(item)) return;

      streamSummary(finalRequest,
        (delta) => {
          if (!STACK.includes(item)) return;
          if (item.etymView) return; // don't surface deltas while etymology view is up
          streamBuffer += delta;
          ensureStreamNode();
          streamTextNode.data = stripTagsForStream(streamBuffer);
          maybeReposition();
        },
        (data) => {
          if (!STACK.includes(item)) return;
          el.querySelector('h3').textContent = data.title || term;
          const finalHtml = sanitizeTooltipHtml(data.html);
          if (item.etymView) {
            // Cache the final HTML so the user can switch back to a fully
            // rendered summary — but don't repaint over the etymology view.
            item.latestSummaryHtml = finalHtml;
            return;
          }
          bodyEl.innerHTML = finalHtml;
          // Defense-in-depth: strip any AI-emitted wikilink/extlink that
          // would loop back to the current page or a tooltip already in the
          // chain (the prompt's dontLink list isn't 100% reliable).
          pruneCircularLinks(bodyEl);
          item.latestSummaryHtml = bodyEl.innerHTML;
          bodyEl.classList.add('just-finalized');
        },
        (port) => { item.streamPort = port; }
      ).catch(err => {
        if (!STACK.includes(item)) return;
        // If the failure is inherent to this URL's shape (content-type, broken
        // image, no extractable text), cache the parent-path so sibling URLs
        // from the same source silently skip going forward.
        if (isExternal && isInherentFailure(err?.message)) {
          const key = urlPatternKey(term);
          if (key) deadPatternCache.add(key);
        }
        showRetry(err);
      });
    }

    function showRetry(err) {
      // Out of credits (per-install daily allowance) and the global daily
      // budget breaker share the sleeping-cat treatment — both mean "rest
      // until tomorrow", they just differ in whose limit was hit. The $7
      // upgrade pitch is retired; supporter copy lands with the Stripe flow.
      if (err?.reason === 'quota_exceeded' || err?.reason === 'pdf_quota_exceeded') {
        bodyEl.innerHTML = `
          <div class="tt-quota-out">
            <div class="tt-quota-cat">${SLEEPING_CAT_SVG}</div>
            <p class="tt-quota-heading">oops! you've hit your usage limit.</p>
            <p class="tt-quota-body">come back tomorrow — your free credits refill daily.</p>
          </div>
        `;
        return;
      }
      if (err?.reason === 'spend_cap') {
        bodyEl.innerHTML = `
          <div class="tt-quota-out">
            <div class="tt-quota-cat">${SLEEPING_CAT_SVG}</div>
            <p class="tt-quota-heading">portaltext is napping.</p>
            <p class="tt-quota-body">today's free budget for everyone is used up — back tomorrow.</p>
          </div>
        `;
        return;
      }
      bodyEl.innerHTML = `<div class="tt-error">${escapeHtml(friendlyError(err))}</div>`;
    }

    startStream();
  }

  // Translate raw error messages into a quiet footnote. No retry button —
  // the vast majority of "summary failed" cases are this link being
  // unsummarizable (anti-bot block, paywall, SPA shell with no text, weird
  // content type), and offering retry creates false hope. The user just
  // hovers something else.
  function friendlyError(err) {
    const m = (err?.message || '').toLowerCase();

    const unsupported = m.match(/unsupported source:\s*(\S+)/);
    if (unsupported) {
      const host = unsupported[1];
      // Twitter/X is handled via the syndication fast-path now; only
      // genuinely auth-walled hosts (Instagram) still land here.
      if (host.includes('instagram')) return "Instagram doesn't allow link previews.";
      return `${host} doesn't allow link previews.`;
    }

    const status = m.match(/page returned\s+(\d{3})/);
    if (status) {
      const code = parseInt(status[1], 10);
      if (code === 404) return 'Page not found.';
      if (code === 403) return 'This site blocked the request.';
      if (code === 401 || code === 407) return 'This page needs you to be logged in.';
      if (code === 410) return 'This page is gone.';
      if (code === 451) return 'This page is legally blocked.';
      if (code >= 500 && code < 600) return 'The site is having trouble.';
      return 'The site rejected the request.';
    }

    if (m.includes('429') || m.includes('rate limit')) return 'Hit a rate limit. Give it a few seconds.';
    if (m.includes('took too long') || m.includes('timeout') || m.includes('etimedout')) return "That didn't respond in time.";
    if (m.includes('enotfound') || m.includes('eai_again')) return "Couldn't find this site.";
    if (m.includes('econnrefused')) return "Couldn't connect to this site.";
    if (m.includes('econnreset') || m.includes('socket hang up')) return 'Connection dropped.';
    if (m.includes('cert_') || m.includes('certificate') || m.includes('ssl')) return 'This site has a security issue.';
    if (m.includes('could not fetch') || m.includes('fetch failed') || m.includes('network')) return "Couldn't reach this page.";
    if (m.includes('anthropic') || m.includes('our api')) return 'API hiccup. Give it a moment.';
    if (m.includes('readable') || m.includes('extract')) return "This page didn't have readable text.";
    if (m.includes('cannot summarize') || m.includes('content type')) return "Can't summarize this kind of content.";
    if (m.includes('too large') || m.includes('too big')) return 'Too large to summarize.';
    if (m.includes('private ip') || m.includes('local host') || m.includes('only http')) return "Can't fetch that link.";
    if (m.includes('invalid url')) return "That link isn't valid.";

    return "Couldn't summarize this one.";
  }

  function positionTooltip(el, trigger) {
    // For wrapped inline links, getClientRects() returns one rect per line — anchor
    // to the line under the cursor instead of the wide bounding box.
    const rectList = trigger.getClientRects();
    let rect = trigger.getBoundingClientRect();
    if (rectList.length > 1) {
      let best = null;
      let bestDist = Infinity;
      for (const r of rectList) {
        if (lastCursorY >= r.top && lastCursorY <= r.bottom) { best = r; break; }
        const d = Math.min(Math.abs(lastCursorY - r.top), Math.abs(lastCursorY - r.bottom));
        if (d < bestDist) { bestDist = d; best = r; }
      }
      if (best) rect = best;
    } else if (rectList.length === 1) {
      rect = rectList[0];
    }
    const ttRect = el.getBoundingClientRect();
    const margin = 8;

    let left = rect.right + 8;
    let top = rect.top - 4;

    if (left + ttRect.width > window.innerWidth - margin) {
      left = rect.left - ttRect.width - 8;
    }
    if (left < margin) left = margin;

    if (top + ttRect.height > window.innerHeight - margin) {
      top = window.innerHeight - ttRect.height - margin;
    }
    if (top < margin) top = margin;

    el.style.left = left + 'px';
    el.style.top = top + 'px';

    // Containing-block sanity check. position:fixed normally pins to the
    // viewport, BUT if any ancestor of the host has a transform / filter /
    // perspective / backdrop-filter / contain:paint|strict|content / will-
    // change:transform set, that ancestor takes over as the containing
    // block for fixed descendants — and our style.left/top end up measured
    // from THAT element's box instead of the viewport. Reddit's app shell
    // hits this and parks every tooltip in the upper-right corner.
    // Read where we actually landed and offset by the delta if needed.
    const actual = el.getBoundingClientRect();
    const dx = left - actual.left;
    const dy = top - actual.top;
    if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) {
      el.style.left = (left + dx) + 'px';
      el.style.top = (top + dy) + 'px';
    }
  }

  function removeTooltip(item) {
    if (!item) return;
    if (item.lockTimer) { clearTimeout(item.lockTimer); item.lockTimer = null; }
    if (item.closeTimer) { clearTimeout(item.closeTimer); item.closeTimer = null; }
    // Abort any in-flight summary stream. Worker sees onDisconnect and
    // cancels the upstream fetch → Claude completion stops mid-token,
    // refunding the user's quota and our Anthropic spend.
    if (item.streamPort) {
      try { item.streamPort.disconnect(); } catch {}
      item.streamPort = null;
    }
    if (item.handlers) {
      item.el.removeEventListener('mouseenter', item.handlers.enter);
      item.el.removeEventListener('mouseleave', item.handlers.leave);
      item.trigger.removeEventListener('mouseenter', item.handlers.triggerEnter);
      item.trigger.removeEventListener('mouseleave', item.handlers.triggerLeave);
    }
    item.trigger.classList.remove('active');
    item.el.classList.remove('visible');
    item.el.style.opacity = '0';
    // Remove the HOST (which contains the shadow root, which contains el).
    setTimeout(() => item.host.remove(), 220);
  }

  function closeAllTooltips() {
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
    if (closeTimer) { clearTimeout(closeTimer); closeTimer = null; }
    while (STACK.length) removeTooltip(STACK.pop());
  }

  function repositionAll() {
    STACK.forEach(s => positionTooltip(s.el, s.trigger));
  }

  // ----- Listeners -----

  // Named handlers so we can attach them to BOTH the document AND each
  // tooltip's shadow root. Why both: when the cursor moves WITHIN a shadow
  // tree, both source and destination retarget to the same shadow host at
  // document level — Chrome optimizes that into "no event" (the cursor
  // didn't appear to cross any element from outside the shadow). Listeners
  // attached inside the shadow still fire normally. So to catch hovers on
  // wikilinks inside an open tooltip, the same handler also has to live
  // on the shadow root.
  function handleMouseover(e) {
    if (!portaltextEnabled) return;
    // At document level, events from a tooltip's shadow tree are retargeted
    // to the shadow host. composedPath()[0] preserves the actual inner node,
    // which lets "hover, then press Ctrl" work for recursive tooltip links.
    const eventTarget = (typeof e?.composedPath === 'function'
      ? e.composedPath().find(node => node?.nodeType === 1)
      : null) || e?.target || (e?.nodeType === 1 ? e : null);
    if (eventTarget) lastHoverTarget = eventTarget;
    // MouseEvent.ctrlKey is also a recovery path if a page intercepted the
    // keyup event: every new hover re-synchronizes our key state instead of
    // leaving Ctrl activation accidentally latched on.
    if (typeof e?.ctrlKey === 'boolean') ctrlActivationHeld = e.ctrlKey;
    if (requireCtrlToActivate && !ctrlActivationHeld) return;
    const link = findHoverable(e);
    if (!link) return;
    const cls = classify(link);
    if (!cls) return;
    if (STACK.some(s => s.trigger === link)) return;
    const depth = depthOfContainer(link);
    // hoverHost = the element the user's cursor is *actually* on when the
    // tooltip resolves. For Reddit's overlay-link pattern, this is the
    // A.absolute.inset-0 covering the whole post card, while `link` is the
    // sibling IMG we resolved via rect overlap. Tracking both lets the
    // close-on-mousemove logic treat the cursor as "still hovering" anywhere
    // inside the conceptual hover region (the whole post), not only over the
    // image we summarize.
    const tgt = eventTarget;
    const hoverHost = tgt && tgt !== link ? tgt : null;
    if (openTimer) clearTimeout(openTimer);
    // Shorter delay for hovers inside an already-open tooltip — user is in
    // portaltext mode and doesn't need as much ambiguity time.
    const delay = depth > 0 ? HOVER_OPEN_DELAY_NESTED : HOVER_OPEN_DELAY;
    openTimer = setTimeout(() => {
      openTimer = null;
      // Releasing Ctrl before the dwell delay completes cancels the gesture.
      if (requireCtrlToActivate && !ctrlActivationHeld) return;
      while (STACK.length > depth) {
        removeTooltip(STACK.pop());
      }
      openTooltip(cls, link, depth, hoverHost);
    }, delay);
  }

  function handleMouseout(e) {
    if (!openTimer) return;
    const link = findHoverable(e);
    if (!link) return;
    // Sub-element transitions inside a link (Reddit post titles wrap text in
    // nested spans/badges/icons; many cards do similar) fire mouseout AND
    // mouseover even though the cursor stays over the link. If we cancel
    // blindly here, the 500ms openTimer keeps resetting and never fires —
    // so a previously-locked tooltip never gets replaced and the new link's
    // tooltip never opens. relatedTarget tells us where the cursor is going;
    // if it's still inside our link, we're staying, don't cancel.
    const to = e.relatedTarget;
    if (to && link.contains(to)) return;
    clearTimeout(openTimer);
    openTimer = null;
  }

  document.addEventListener('mouseover', handleMouseover);
  document.addEventListener('mouseout', handleMouseout);

  // Mousedown anywhere cancels a pending tooltip-open timer. Without this,
  // a user who hovers a link briefly then clicks it would still trigger
  // inference between the click and the next page loading (mouse is still
  // on the link, the 500ms timer fires post-click). We use mousedown rather
  // than click to cancel as early as possible (browser navigation can begin
  // before click fires, especially on middle-click / ctrl-click new tabs).
  document.addEventListener('mousedown', () => {
    if (openTimer) { clearTimeout(openTimer); openTimer = null; }
  }, true); // capture phase so we run before the page's own click handlers

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeAllTooltips();
      return;
    }
    if (e.key !== 'Control') return;
    ctrlActivationHeld = true;
    // A key press does not produce a new mouseover event. If Ctrl was pressed
    // while the pointer was already resting on a candidate, begin the normal
    // delayed-open flow from the last target seen under the pointer.
    if (requireCtrlToActivate && !e.repeat && lastHoverTarget?.isConnected && lastHoverTarget.matches?.(':hover')) {
      handleMouseover(lastHoverTarget);
    }
  }, true);

  document.addEventListener('keyup', (e) => {
    if (e.key !== 'Control') return;
    ctrlActivationHeld = false;
    if (requireCtrlToActivate && openTimer) { clearTimeout(openTimer); openTimer = null; }
  }, true);

  window.addEventListener('blur', () => {
    ctrlActivationHeld = false;
    if (requireCtrlToActivate && openTimer) { clearTimeout(openTimer); openTimer = null; }
  });

  // Engine-only click: stack management. Click navigation on the protocol
  // anchors themselves is host concern (native href, or a host-bound listener).
  document.addEventListener('click', (e) => {
    if (!STACK.length) return;
    if (findHoverable(e)) return; // host handles these
    // Click target is retargeted to the shadow host when the click happens
    // inside a tooltip's shadow root, so e.target alone can't tell us which
    // tooltip is involved. composedPath() carries the actual path through
    // the shadow boundary; check whether any tooltip host is in it.
    const path = e.composedPath();
    const containingItem = STACK.find(s => path.includes(s.host));
    if (!containingItem) {
      closeAllTooltips();
      return;
    }
    lockTooltip(containingItem);
  });

  window.addEventListener('scroll', repositionAll, { passive: true });
  window.addEventListener('resize', repositionAll);

  // Initial origin extraction
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', refreshOriginContext);
  } else {
    refreshOriginContext();
  }

  // SPA-navigation awareness: when the URL changes via history.pushState (no
  // event fires for that natively) or replaceState, invalidate the cached
  // origin context immediately and schedule a re-extract once the SPA has
  // had a chance to render the new view. The two-step matters: in the gap
  // between nav and re-extract, getCurrentContext sees extractedAtUrl !==
  // location.href and returns null, so we never send the previous page's
  // context as the frame for a hover on the new page (Reddit thread → back
  // to feed → hover a new post was the bug case).
  let lastObservedUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastObservedUrl) {
      lastObservedUrl = location.href;
      currentArticle = null;
      extractedAtUrl = null;
      // Delay the re-extract — SPAs swap the DOM asynchronously and reading
      // immediately would just re-cache the OLD content under the NEW URL.
      setTimeout(refreshOriginContext, 400);
    }
  }
  // Hook history.pushState/replaceState so we catch programmatic SPA navs
  // within ~50ms instead of waiting up to 1s for the polling fallback. Both
  // are silent natively — no event fires when an SPA router calls them.
  for (const fn of ['pushState', 'replaceState']) {
    const original = history[fn];
    history[fn] = function(...args) {
      const r = original.apply(this, args);
      setTimeout(checkUrlChange, 50);
      return r;
    };
  }
  // popstate covers back/forward; small delay so the SPA's own router has a
  // tick to update <title> and <meta> before we invalidate/re-extract.
  window.addEventListener('popstate', () => setTimeout(checkUrlChange, 100));
  // Polling fallback for sites that bypass the History API or for any case
  // where our hook didn't run (extension injected after the SPA's own).
  setInterval(checkUrlChange, 1000);

  // ----- Annotate-page handler -----
  // The popup's "Annotate this page" button sends {type:'annotate'} to the
  // active tab. We extract clean text via Readability, route the request
  // through the service worker (cross-origin bypass), then walk the live
  // DOM wrapping each annotation's phrase in a real <a class="wikilink">
  // anchor. Wrapped phrases are immediately hoverable via the existing
  // tooltip flow — no extra plumbing needed.
  if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg?.type === 'annotate') {
        annotatePage().then(applied => sendResponse({ applied })).catch(err => sendResponse({ error: err.message }));
        return true;
      }
      if (msg?.type === 'pt-open-saved') {
        try {
          openSavedTooltip(msg);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ error: err.message });
        }
        return false;
      }
      return false;
    });
  }

  // Open a saved tooltip as a fresh chain root. Creates a synthetic anchor
  // at viewport center (visibility:hidden so it doesn't paint, but has a
  // getBoundingClientRect so positionTooltip works). The tooltip then
  // streams a fresh summary WITHOUT the saved context — by design, saves
  // are forward-looking bookmarks for new exploration, not memorabilia.
  function openSavedTooltip(msg) {
    if (!portaltextEnabled) return;
    closeAllTooltips();
    const anchor = document.createElement('div');
    anchor.setAttribute('data-portaltext-saved-anchor', '');
    // Stash the saved language on the anchor so openTooltip can find it
    // and pass it through to /summary instead of the user's current pref.
    if (msg.lang) anchor.setAttribute('data-portaltext-saved-lang', msg.lang);
    anchor.style.cssText = [
      'position: fixed',
      `left: ${Math.round(window.innerWidth / 2)}px`,
      `top:  ${Math.round(window.innerHeight / 2.5)}px`,
      'width: 1px',
      'height: 1px',
      'visibility: hidden',
      'pointer-events: none',
      'z-index: 0',
    ].join(';');
    document.body.appendChild(anchor);
    const cls = msg.isExternal
      ? { isExternal: true,  payload: msg.url }
      : { isExternal: false, payload: msg.term };
    openTooltip(cls, anchor, 0, null);
    // Mark the just-opened tooltip as a save-origin item so isCursorOverChain
    // doesn't immediately close it (cursor isn't on the synthetic anchor).
    const item = STACK[STACK.length - 1];
    if (item && item.trigger === anchor) item.openedFromSave = true;
    // Clean up the synthetic anchor when the tooltip eventually closes.
    // Poll for STACK no longer containing this trigger; cheap and bounded.
    const cleanup = setInterval(() => {
      if (!STACK.some(s => s.trigger === anchor)) {
        anchor.remove();
        clearInterval(cleanup);
      }
    }, 500);
  }

  // ----- Auto-detect citation patterns -----
  // Citation formats have such unambiguous regex shapes that no AI call
  // is needed to detect them — wrap on page load directly as extlinks
  // pointing at the canonical resolver URL. The existing hover flow then
  // produces an AI summary by fetching that resolver (arXiv abstract page,
  // DOI redirect target, RFC HTML, etc.). Pure client-side, zero cost.
  // Helper: strip trailing punctuation that's part of the surrounding text
  // (period, comma, semicolon, colon) but not slashes or other DOI-valid chars.
  // Real DOIs never end in sentence punctuation; capturing it produces a
  // broken doi.org URL like ".../article.def." that fails to resolve.
  const stripTrailingPunct = (s) => s.replace(/[.,;:]+$/, '');

  const CITATION_PATTERNS = [
    // arXiv: arXiv:2308.12966 (with optional version suffix). Case-insensitive
    // because authors write "arxiv:" / "ArXiv:" inconsistently in the wild.
    { re: /\barxiv:\s*(\d{4}\.\d{4,5})(v\d+)?\b/gi,
      url: (m) => `https://arxiv.org/abs/${m[1]}` },
    // DOI: doi:10.1234/abc — capture greedily, then strip trailing sentence
    // punctuation so "doi: 10.x/y. Epub 2024" resolves correctly.
    { re: /\bdoi:\s*(10\.\d{4,9}\/[^\s,;)\]]+)/gi,
      url: (m) => `https://doi.org/${stripTrailingPunct(m[1])}` },
    // RFC: RFC 1234 or RFC1234 or RFC-1234
    { re: /\brfc[\s-]?(\d{1,5})\b/gi,
      url: (m) => `https://datatracker.ietf.org/doc/html/rfc${m[1]}` },
    // ISBN with optional 978/979 prefix, hyphens or spaces allowed.
    { re: /\bisbn[-: ]?\s*((?:97[89][- ]?)?[\d -]{8,17}[\dX])\b/gi,
      url: (m) => `https://www.worldcat.org/isbn/${m[1].replace(/[\s-]/g, '')}` },
    // PubMed: PMID: 12345678 — accept 4–10 digits to cover both historic
    // and current ID ranges (PMIDs are in the tens of millions now).
    // \s* (rather than \s?) tolerates multiple spaces / non-breaking space
    // separators that some sites use between the label and the number.
    { re: /\bpmid:?\s*(\d{4,10})\b/gi,
      url: (m) => `https://pubmed.ncbi.nlm.nih.gov/${m[1]}/` },
  ];
  const CITATION_WRAP_CAP = 500; // hard cap per scan, defensive

  function shouldSkipNodeForCitations(node) {
    const parent = node.parentElement;
    if (!parent) return true;
    const tag = parent.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NOSCRIPT' ||
        tag === 'TEXTAREA' || tag === 'INPUT') return true;
    // Skip text already inside an anchor (don't double-wrap), inside our
    // own tooltips (data-portaltext-host), or inside no-portaltext zones.
    if (parent.closest('a')) return true;
    if (parent.closest('[data-portaltext-host], [data-portaltext="off"], .no-portaltext')) return true;
    return false;
  }

  function wrapMatchesInTextNode(textNode) {
    const text = textNode.data;
    const matches = [];
    for (const pat of CITATION_PATTERNS) {
      pat.re.lastIndex = 0;
      let m;
      while ((m = pat.re.exec(text)) !== null) {
        matches.push({ start: m.index, end: m.index + m[0].length, label: m[0], url: pat.url(m) });
        if (m.index === pat.re.lastIndex) pat.re.lastIndex++;
      }
    }
    if (matches.length === 0) return 0;
    // Sort + remove overlaps (earlier wins) so adjacent patterns don't fight.
    matches.sort((a, b) => a.start - b.start);
    const ordered = [];
    let lastEnd = -1;
    for (const m of matches) {
      if (m.start >= lastEnd) { ordered.push(m); lastEnd = m.end; }
    }
    const frag = document.createDocumentFragment();
    let cursor = 0;
    for (const m of ordered) {
      if (m.start > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, m.start)));
      const a = document.createElement('a');
      a.className = 'extlink portaltext-citation portaltext-fade-in';
      a.setAttribute('data-url', m.url);
      a.setAttribute('href', m.url);
      a.textContent = m.label;
      frag.appendChild(a);
      cursor = m.end;
    }
    if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
    textNode.parentNode.replaceChild(frag, textNode);
    return ordered.length;
  }

  function scanAndWrapCitations(root) {
    if (!root || !portaltextEnabled) return;
    let count = 0;
    const candidates = [];
    const tw = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (count >= CITATION_WRAP_CAP) return NodeFilter.FILTER_REJECT;
        if (shouldSkipNodeForCitations(node)) return NodeFilter.FILTER_REJECT;
        const text = node.data;
        if (!text || text.length < 6) return NodeFilter.FILTER_SKIP;
        // Cheap pre-filter — any pattern's lead chars present at all?
        // Case-insensitive so lowercase prefixes ("pmid:", "doi:") still hit.
        if (!/arxiv|doi|rfc|isbn|pmid/i.test(text)) return NodeFilter.FILTER_SKIP;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    while (tw.nextNode()) candidates.push(tw.currentNode);
    for (const node of candidates) {
      if (count >= CITATION_WRAP_CAP) break;
      count += wrapMatchesInTextNode(node);
    }
    // Second pass: catch citations whose prefix and value are split across
    // DOM nodes (e.g. PubMed renders <span>PMID: </span><span>32233995</span>).
    // The text-node walker can't see these as one match. Walk small leaf-ish
    // elements, check their *combined* textContent, then wrap just the value
    // inside the actual text node that holds it.
    scanSplitCitations(root, count);
  }

  // Element-level pass — wraps citations whose prefix and value live in
  // separate text nodes within a single small parent. Targets containers
  // that typically hold one citation line (article footers, sidebar lists,
  // dd/li blocks) and skips already-linked / already-wrapped values.
  function scanSplitCitations(root, startCount) {
    let count = startCount || 0;
    // Use querySelectorAll then filter — TreeWalker on elements doesn't
    // give us textContent-aware acceptance cheaply.
    const els = root.querySelectorAll('span, div, dd, dt, li, p, td, small');
    for (const el of els) {
      if (count >= CITATION_WRAP_CAP) break;
      if (el.children.length > 8) continue;
      if (el.closest('a')) continue;
      if (el.closest('[data-portaltext-host], [data-portaltext="off"], .no-portaltext')) continue;
      const text = el.textContent || '';
      if (text.length === 0 || text.length > 240) continue;
      if (!/arxiv|doi|rfc|isbn|pmid/i.test(text)) continue;
      // Try each pattern against the element's combined text.
      for (const pat of CITATION_PATTERNS) {
        pat.re.lastIndex = 0;
        const m = pat.re.exec(text);
        if (!m) continue;
        const value = m[1];
        if (!value || value.length < 3) continue;
        // Locate the actual descendant text node containing the value and
        // wrap it. Skip if it's already inside an anchor (page's own link).
        if (wrapValueInElement(el, value, pat.url(m))) {
          count++;
          break; // one citation per element to avoid double-wrapping
        }
      }
    }
  }

  function wrapValueInElement(el, value, url) {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (node.parentElement?.closest('a')) return NodeFilter.FILTER_REJECT;
        return node.data && node.data.includes(value)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_SKIP;
      },
    });
    const node = tw.nextNode();
    if (!node) return false;
    const idx = node.data.indexOf(value);
    if (idx < 0) return false;
    // Split: before [value] after — keep before & after as text, replace
    // the middle with an extlink anchor.
    const middle = node.splitText(idx);
    middle.splitText(value.length); // tail stays in the DOM as text
    const a = document.createElement('a');
    a.className = 'extlink portaltext-citation portaltext-fade-in';
    a.setAttribute('data-url', url);
    a.setAttribute('href', url);
    a.textContent = value;
    middle.parentNode.replaceChild(a, middle);
    return true;
  }

  // Initial scan: fire once during browser-idle time after content script
  // boots, so we don't compete with the page's own initial render. SPAs
  // that add new content later won't get auto-wrapped in v1 — adding a
  // debounced MutationObserver is the natural follow-up if it matters.
  function scheduleInitialCitationScan() {
    const runScan = () => {
      if (document.body) scanAndWrapCitations(document.body);
    };
    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(runScan, { timeout: 2000 });
    } else {
      setTimeout(runScan, 600);
    }
  }
  scheduleInitialCitationScan();

  async function annotatePage() {
    // PDF pages render in Chrome's embedded plugin — no DOM to walk, can't
    // wrap text. Friendly bail rather than a confusing failure.
    if (/\.pdf(\?|#|$)/i.test(location.pathname) || document.contentType === 'application/pdf') {
      throw new Error('PDF pages can\'t be annotated yet — use hover-to-summarize instead');
    }

    let text = '';
    let title = document.title || '';
    try {
      if (typeof Readability === 'function') {
        const article = new Readability(document.cloneNode(true)).parse();
        if (article?.textContent) {
          text = article.textContent.replace(/\s+/g, ' ').trim();
          if (article.title) title = article.title;
        }
      }
    } catch { /* fall through to body fallback */ }
    if (!text || text.length < 200) {
      text = (document.body?.textContent || '').replace(/\s+/g, ' ').trim();
    }
    if (!text || text.length < 100) throw new Error('No readable text found on this page');

    const annotations = await fetchAnnotationsViaWorker({ url: location.href, text, title });
    if (!annotations?.length) return 0;
    return applyAnnotationsToPage(annotations);
  }

  // Routes the annotation fetch through the service worker, mirroring the
  // pattern used for /summary. Worker has chrome-extension:// origin so it
  // can hit the server cross-origin from any page.
  function fetchAnnotationsViaWorker(payload) {
    return new Promise((resolve, reject) => {
      let port;
      try { port = chrome.runtime.connect({ name: 'pt-annotate' }); }
      catch { reject(new Error('Extension service worker unavailable')); return; }
      let settled = false;
      port.onMessage.addListener((msg) => {
        if (settled) return;
        settled = true;
        if (msg?.type === 'annotations') resolve(msg.annotations || []);
        else if (msg?.type === 'error') reject(new Error(msg.message || 'Annotate failed'));
        else resolve([]);
        try { port.disconnect(); } catch {}
      });
      port.onDisconnect.addListener(() => { if (!settled) { settled = true; resolve([]); } });
      port.postMessage({ type: 'request', payload });
    });
  }

  // Walks visible text nodes in the body and wraps the first occurrence of
  // each annotation phrase. Skips text inside <a>, <code>, <pre>, <script>,
  // <style>, <textarea>, and inside any tooltip shadow content (we never
  // touch our own UI). Returns the count of wrapped phrases.
  function applyAnnotationsToPage(annotations) {
    const SKIP_TAGS = new Set(['A', 'CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'NOSCRIPT', 'SVG', 'MATH', 'BUTTON']);
    let applied = 0;

    function findTextNodeContaining(phrase) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.data || node.data.indexOf(phrase) === -1) return NodeFilter.FILTER_REJECT;
          let p = node.parentElement;
          while (p && p !== document.body) {
            if (SKIP_TAGS.has(p.tagName)) return NodeFilter.FILTER_REJECT;
            if (p.hasAttribute && p.hasAttribute('data-portaltext-host')) return NodeFilter.FILTER_REJECT;
            p = p.parentElement;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });
      return walker.nextNode();
    }

    function wrap(phrase, term) {
      const node = findTextNodeContaining(phrase);
      if (!node) return false;
      const idx = node.data.indexOf(phrase);
      const before = node.data.slice(0, idx);
      const after = node.data.slice(idx + phrase.length);
      const a = document.createElement('a');
      a.className = 'wikilink portaltext-fade-in';
      a.dataset.term = term;
      a.href = `https://en.wikipedia.org/wiki/${encodeURIComponent(term.replace(/ /g, '_'))}`;
      a.textContent = phrase;
      const parent = node.parentNode;
      parent.insertBefore(document.createTextNode(before), node);
      parent.insertBefore(a, node);
      parent.insertBefore(document.createTextNode(after), node);
      parent.removeChild(node);
      return true;
    }

    for (const ann of annotations) {
      if (!ann?.phrase || !ann?.term) continue;
      if (wrap(ann.phrase, ann.term)) applied++;
    }
    return applied;
  }

  // ----- User-wrap: selection → wikilink -----
  // Two entry points, same wrap logic:
  //   1. Right-click → "Make hoverable with portaltext" (background.js posts
  //      a pt-wrap-selection message to the active tab).
  //   2. Floating mini-button that appears on mouseup near any non-trivial
  //      text selection. Click → wraps. Click anywhere else → dismisses.
  //
  // Either path wraps the live Range in <a class="wikilink" data-term="X">,
  // which the existing mouseover infrastructure picks up for free.
  const WRAP_ICON_URL = chrome.runtime.getURL('assets/selectchip.svg');
  let ptFloatBtn = null;

  function isInFormField(node) {
    let n = node && node.nodeType === 3 ? node.parentElement : node;
    while (n && n.nodeType === 1) {
      const tag = n.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || n.isContentEditable) return true;
      n = n.parentElement;
    }
    return false;
  }

  // Word-character predicate for selection word-boundary snap. Includes
  // Unicode letters/numbers plus hyphens (for compound words like
  // "well-being"). Apostrophes are NOT word chars — they're almost always
  // a boundary in lookup contexts ("Microsoft's" → user wants "Microsoft",
  // not the possessive). Trade-off: contractions like "don't" become "don"
  // on partial selection, but the user can manually extend if they wanted
  // the full contraction.
  function isSelectionWordChar(ch) {
    if (!ch) return false;
    return /[\p{L}\p{N}\-]/u.test(ch);
  }

  // Expand a Range so partial-word selections become full words. Operates
  // only within the start/end text nodes — won't cross element boundaries.
  // Returns a new Range; doesn't mutate the original.
  //
  // Two passes per end:
  //   1. Strip whitespace toward the selection interior. The user's "real"
  //      intent is bounded by the non-whitespace chars; whitespace they
  //      included is almost always sloppy click-drag.
  //   2. Only after trimming, check whether the now-effective boundary is
  //      mid-word. If yes (last non-whitespace char is a word char AND the
  //      next char is also a word char), extend through the word. If the
  //      user selected through whitespace cleanly, leave the boundary as-is
  //      — never pull the next word in just because it's adjacent.
  function expandRangeToWordBoundaries(range) {
    const r = range.cloneRange();
    if (r.startContainer.nodeType === 3) {
      const text = r.startContainer.data;
      let i = r.startOffset;
      // Skip leading whitespace inside the selection.
      while (i < text.length && /\s/.test(text[i])) i++;
      // Now i points at the first real char of the user's intent. If the
      // char to the left is also a word char, they cut mid-word — extend.
      if (i > 0 && i < text.length && isSelectionWordChar(text[i]) && isSelectionWordChar(text[i - 1])) {
        while (i > 0 && isSelectionWordChar(text[i - 1])) i--;
      }
      r.setStart(r.startContainer, i);
    }
    if (r.endContainer.nodeType === 3) {
      const text = r.endContainer.data;
      let i = r.endOffset;
      // Strip trailing whitespace inside the selection.
      while (i > 0 && /\s/.test(text[i - 1])) i--;
      // Now i is just past the last real char. If text[i] is a word char,
      // the user cut mid-word — extend forward. Otherwise leave alone.
      if (i > 0 && i < text.length && isSelectionWordChar(text[i - 1]) && isSelectionWordChar(text[i])) {
        while (i < text.length && isSelectionWordChar(text[i])) i++;
      }
      r.setEnd(r.endContainer, i);
    }
    return r;
  }

  // Find the nearest ancestor <a> of a node. Used to detect when a selection
  // lives entirely inside an existing link, so we can mark that link as a
  // wikilink instead of trying to wrap (nested <a> is invalid HTML).
  function findContainingAnchor(node) {
    let n = node && node.nodeType === 3 ? node.parentElement : node;
    while (n && n.nodeType === 1) {
      if (n.tagName === 'A') return n;
      n = n.parentElement;
    }
    return null;
  }

  // Selections inside open tooltips live in their shadow roots, not at the
  // document level — window.getSelection() returns empty for them. This
  // walks the open-tooltip stack to find the active non-collapsed selection
  // wherever it lives. Returns the Selection object plus a `root` for any
  // callers that need to know whether they're in document or shadow.
  function getActiveSelection() {
    const docSel = window.getSelection();
    if (docSel && docSel.rangeCount > 0 && !docSel.getRangeAt(0).collapsed) {
      return docSel;
    }
    for (const item of STACK) {
      const sel = item.shadow?.getSelection?.();
      if (sel && sel.rangeCount > 0 && !sel.getRangeAt(0).collapsed) {
        return sel;
      }
    }
    return null;
  }

  function wrapCurrentSelection(text) {
    const sel = getActiveSelection();
    if (!sel) return;
    const origRange = sel.getRangeAt(0);
    if (isInFormField(origRange.commonAncestorContainer)) return;

    // Snap to whole-word boundaries. Catches the two most common selection
    // mistakes: trailing/leading punctuation/whitespace, and partial words
    // ("elephan" → "elephant"). Update the live selection so the visible
    // highlight reflects what we're about to wrap.
    const range = expandRangeToWordBoundaries(origRange);
    sel.removeAllRanges();
    sel.addRange(range);

    const effectiveText = ((text && text.trim()) || range.toString().trim()).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    if (!effectiveText) return;

    // Selection is inside an existing <a>. Nested <a> is invalid HTML and
    // browsers normalize it in ways that break our hover detection — so
    // instead, just promote the containing <a> to a wikilink with our term.
    // Native click navigation is preserved (we only added a class + data
    // attribute). If the link is already a wikilink/extlink, the user
    // already has a hoverable element here — leave it alone.
    const containingAnchor = findContainingAnchor(range.commonAncestorContainer);
    if (containingAnchor) {
      if (!containingAnchor.classList.contains('wikilink') && !containingAnchor.classList.contains('extlink')) {
        containingAnchor.classList.add('wikilink', 'portaltext-user-marked', 'portaltext-fade-in');
        containingAnchor.setAttribute('data-term', effectiveText);
      }
      sel.removeAllRanges();
      return;
    }

    const a = document.createElement('a');
    // portaltext-fade-in triggers the 800ms color: inherit → green
    // animation defined in PAGE_STYLES, giving the wrap a soft entrance
    // to pair with the chip's exit fade.
    a.className = 'wikilink portaltext-user-marked portaltext-fade-in';
    a.setAttribute('data-term', effectiveText);
    try {
      range.surroundContents(a);
    } catch {
      // surroundContents throws when the range crosses element boundaries.
      // extractContents + insertNode handles partial-element selections.
      const frag = range.extractContents();
      a.appendChild(frag);
      range.insertNode(a);
    }
    // Unwrap any wikilink/extlink anchors that got pulled inside the new
    // wrap — the user's new selection explicitly overrides any prior
    // wrapping. Without this, hovering the new wrap would fire on the
    // innermost (stale) anchor via event delegation.
    a.querySelectorAll('a.wikilink, a.extlink').forEach((stale) => {
      while (stale.firstChild) stale.parentNode.insertBefore(stale.firstChild, stale);
      stale.remove();
    });
    sel.removeAllRanges();
  }

  function hideFloatBtn() {
    if (!ptFloatBtn) return;
    const btn = ptFloatBtn;
    ptFloatBtn = null;
    // Fade out with a tiny upward drift so dismissal feels intentional.
    btn.style.transition = 'opacity 220ms ease-out, transform 220ms ease-out';
    btn.style.opacity = '0';
    btn.style.transform = 'translateY(-4px)';
    setTimeout(() => btn.remove(), 240);
  }

  function showFloatBtn(x, y, text) {
    hideFloatBtn();
    const btn = document.createElement('div');
    btn.setAttribute('data-portaltext-float', '');
    btn.title = 'Make hoverable with portaltext';
    // selectchip.svg bakes in its own outline + drop shadow, so no extra
    // chip background / border / box-shadow needed here. Just position the
    // SVG and let it carry the look. Aspect is ~0.57:1 (taller than wide),
    // matching the hand-drawn question-mark glyph. Starts at opacity 0 and
    // fades in on the next frame for a soft entrance.
    btn.style.cssText = [
      'position: fixed',
      `left: ${Math.round(x)}px`,
      `top: ${Math.round(y)}px`,
      'width: 22px',
      'height: 38px',
      'z-index: 2147483647',
      `background-image: url(${WRAP_ICON_URL})`,
      'background-size: contain',
      'background-repeat: no-repeat',
      'background-position: center',
      // CSS drop-shadow on top of the SVG's own filter — shadows the
      // rendered glyph silhouette (not a rectangular box), so it reads
      // clean on busy backgrounds without a halo.
      'filter: drop-shadow(0 2px 6px rgba(0,0,0,0.30)) drop-shadow(0 1px 2px rgba(0,0,0,0.15))',
      'opacity: 0',
      'transform: translateY(2px)',
      'transition: opacity 160ms ease-out, transform 160ms ease-out',
      'cursor: pointer',
      'user-select: none',
      'pointer-events: auto'
    ].join(';');
    // Hover-to-confirm: the moment the cursor lands on the chip, the wrap
    // fires and the chip vanishes. Faster than a click and matches the
    // "approach to commit" feel. mousedown stays as a fallback for touch
    // devices that don't fire mouseenter.
    btn.addEventListener('mouseenter', () => {
      wrapCurrentSelection(text);
      hideFloatBtn();
    });
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      wrapCurrentSelection(text);
      hideFloatBtn();
    });
    document.body.appendChild(btn);
    ptFloatBtn = btn;
    // Trigger the entrance fade on the next frame so the initial opacity:0 +
    // translateY:2 paints before we transition to opacity:1 + translateY:0.
    requestAnimationFrame(() => {
      btn.style.opacity = '1';
      btn.style.transform = 'translateY(0)';
    });
  }

  document.addEventListener('mouseup', () => {
    if (!portaltextEnabled) { hideFloatBtn(); return; }
    // setTimeout 0 so the selection state is settled after the mouseup.
    setTimeout(() => {
      // getActiveSelection() looks in document first, then walks open
      // tooltips' shadow roots — so selecting text inside a tooltip body
      // surfaces here too, not just selections on the host page.
      const sel = getActiveSelection();
      if (!sel) { hideFloatBtn(); return; }
      const origRange = sel.getRangeAt(0);
      if (isInFormField(origRange.commonAncestorContainer)) { hideFloatBtn(); return; }
      // Snap the visible highlight to whole-word boundaries before showing
      // the chip — gives the user "oh, it caught the whole word" feedback,
      // and means the chip position matches what we'll actually wrap.
      const expanded = expandRangeToWordBoundaries(origRange);
      sel.removeAllRanges();
      sel.addRange(expanded);
      const text = sel.toString().trim();
      if (!text || text.length < 2 || text.length > 120) { hideFloatBtn(); return; }
      const rect = expanded.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) { hideFloatBtn(); return; }
      // Position to the right of the selection's end, nudged up slightly.
      // Anchor the chip above-and-right of the selection, overlapping the
      // selection's top edge by ~6px so it visually attaches to the text
      // rather than floating in space. Clamped to the viewport.
      const CHIP_W = 22, CHIP_H = 38;
      const x = Math.min(rect.right + 4, window.innerWidth - CHIP_W - 4);
      const y = Math.max(rect.top - CHIP_H + 6, 4);
      showFloatBtn(x, y, text);
    }, 0);
  });

  document.addEventListener('mousedown', (e) => {
    if (ptFloatBtn && !ptFloatBtn.contains(e.target)) hideFloatBtn();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') hideFloatBtn();
  });
  document.addEventListener('scroll', hideFloatBtn, true);

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === 'pt-wrap-selection') {
      wrapCurrentSelection(msg.text);
      hideFloatBtn();
    }
  });

  // ----- Public API -----
  // Hosts call refreshOriginContext() after navigating between page states (SPA),
  // and closeAllTooltips() when initiating a navigation that should dismiss the chain.
  window.portaltext = {
    refreshOriginContext,
    closeAllTooltips,
    getCurrentContext
  };
})();
