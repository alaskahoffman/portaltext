/*
 * portaltext.js — the standalone runtime.
 *
 * Drop this on any page; mark cross-references with `class="wikilink"`
 * (+ `data-term="Exact Wikipedia Title"`) or `class="extlink"` (+ `data-url="https://..."`),
 * and hover behavior is automatic. Configure the /summary endpoint via
 * `<script src="portaltext.js" data-endpoint="https://your-server/summary">`.
 *
 * The runtime is hover-only: clicks fall through to native browser behavior.
 * Hosts that want custom click navigation bind their own click listeners.
 */
(function () {
  'use strict';

  // Handshake with the extension: mark the document so the extension's
  // content script (which runs in an isolated world and can't see this
  // script's window) knows an embedded runtime already handles hovers here.
  // Without this, extension users visiting a page that embeds the runtime
  // (portaltext.com itself) would get two tooltips per hover.
  document.documentElement.dataset.portaltextEmbedded = '1';

  // ----- Configuration -----
  const scriptEl = document.currentScript ||
    document.querySelector('script[src*="portaltext.js"]');
  const SUMMARY_ENDPOINT = scriptEl?.dataset.endpoint || '/summary';
  // Plain-<a> mode: when enabled, any <a href> with an http(s) URL is portaltext-able,
  // not just anchors with the explicit `wikilink`/`extlink` classes. Hosts opt out
  // per-anchor with `class="no-portaltext"` or any ancestor with `data-portaltext="off"`.
  // Off by default so the runtime is conservative — flip to true on adopter sites
  // where every existing hyperlink should be hover-summarizable.
  const PLAIN_ANCHORS = scriptEl?.dataset.plainAnchors === 'true';

  // ----- Styles -----
  // Injected on init so adopters get fully-styled tooltips with one <script> tag.
  // Hosts override the look via CSS custom properties on :root or a wrapping
  // element (e.g. `--portaltext-bg`, `--portaltext-link`, `--portaltext-font`).
  const STYLES = `
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
  margin: 0 0 6px;
  font-family: var(--portaltext-heading-font, "Linux Libertine", Georgia, serif);
  font-size: 17px;
  font-weight: 400;
}
.tooltip .body {
  font-size: 13.5px;
  font-family: var(--portaltext-body-font, "LINE Seed JP", -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", Arial, sans-serif);
}
.tooltip .body p { margin: 0 0 14px; }
.tooltip .body p:last-child { margin-bottom: 0; }
.tooltip .footer {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--portaltext-border-soft, #ddd);
  font-size: 12px;
  color: var(--portaltext-muted, #54595d);
  display: flex;
  justify-content: space-between;
}
.tooltip .footer kbd {
  background: var(--portaltext-bg-soft, #f8f9fa);
  border: 1px solid var(--portaltext-border, #a2a9b1);
  border-radius: 0;
  padding: 1px 5px;
  font-size: 11px;
}
.tooltip[data-depth="1"] { box-shadow: 0 8px 28px rgba(0,0,0,0.20), 0 3px 8px rgba(0,0,0,0.10); }
.tooltip[data-depth="2"] { box-shadow: 0 10px 32px rgba(0,0,0,0.22), 0 4px 10px rgba(0,0,0,0.12); }
.tooltip[data-depth="3"] { box-shadow: 0 12px 36px rgba(0,0,0,0.24), 0 5px 12px rgba(0,0,0,0.14); }
.tooltip.locked {
  border-left: 3px solid var(--portaltext-lock, #0645ad);
  padding-left: 14px;
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
  /* Individual translate/rotate so rotate animates cleanly around the
     element's own center while the translate keeps it centered in the
     parent. Avoids the order-of-operations weirdness with a single
     transform property. */
  translate: -50% -50%;
  rotate: 0deg;
  background-repeat: no-repeat;
  background-position: center;
  background-size: contain;
  opacity: 0;
  animation: pt-spinner-pulse 1.2s infinite, pt-spinner-rotate 4.5s linear infinite;
}
.pt-spinner-small  { width: 26px; height: 26px; background-image: url('/assets/handdrawn-34.svg'); animation-delay: 0s;   }
.pt-spinner-medium { width: 50px; height: 50px; background-image: url('/assets/handdrawn-31.svg'); animation-delay: 0.4s; }
.pt-spinner-big    { width: 72px; height: 72px; background-image: url('/assets/handdrawn-29.svg'); animation-delay: 0.8s; }
@keyframes pt-spinner-pulse {
  0%, 33%   { opacity: 1; }
  34%, 100% { opacity: 0; }
}
@keyframes pt-spinner-rotate {
  to { rotate: 360deg; }
}
.tooltip .error { color: var(--portaltext-error, #c00); font-size: 13px; }
.tooltip .tt-error {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
  color: var(--portaltext-muted, #54595d);
  font-size: 13px;
}
.tooltip .tt-retry {
  background: var(--portaltext-bg-soft, #f8f9fa);
  border: 1px solid var(--portaltext-border, #a2a9b1);
  border-radius: 0;
  padding: 3px 10px;
  font-size: 12px;
  cursor: pointer;
  color: var(--portaltext-fg, #202122);
  font-family: inherit;
}
.tooltip .tt-retry:hover { background: var(--portaltext-border-soft, #ececec); }
.tooltip a.wikilink, .tooltip a.extlink {
  color: var(--portaltext-link, #0645ad);
  text-decoration: none;
  cursor: pointer;
}
.tooltip a.wikilink:hover, .tooltip a.extlink:hover {
  color: var(--portaltext-link-hover, #3366bb);
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
  to   { color: var(--portaltext-link, #0645ad); }
}
.tooltip .body.just-finalized a.wikilink,
.tooltip .body.just-finalized a.extlink {
  animation: portaltext-linkFadeIn 500ms ease-out;
}
/* Generic fade-in for protocol anchors that get inserted into already-rendered
   content (e.g. when an annotation pass lands after the page text is on screen).
   Hosts add the class manually when wrapping; the keyframes are reused. */
a.wikilink.portaltext-fade-in,
a.extlink.portaltext-fade-in {
  animation: portaltext-linkFadeIn 800ms ease-out;
}
.tooltip .hint-locked { display: none; }
.tooltip.locked .hint-default { display: none; }
.tooltip.locked .hint-locked { display: inline; color: var(--portaltext-lock, #0645ad); }
a.wikilink, a.extlink {
  color: var(--portaltext-link, #0645ad);
  text-decoration: none;
  cursor: pointer;
}
a.wikilink:hover, a.extlink:hover {
  color: var(--portaltext-link-hover, #3366bb);
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
`;

  function injectStyles() {
    // Google Fonts as a separate <link> — @import inside an injected
    // <style> tag is unreliable in extension contexts (browsers handle
    // it differently than a stylesheet linked in the page's own head).
    const fontPreconnect = document.createElement('link');
    fontPreconnect.rel = 'preconnect';
    fontPreconnect.href = 'https://fonts.gstatic.com';
    fontPreconnect.crossOrigin = 'anonymous';
    document.head.appendChild(fontPreconnect);
    const fontLink = document.createElement('link');
    fontLink.rel = 'stylesheet';
    fontLink.href = 'https://fonts.googleapis.com/css2?family=LINE+Seed+JP:wght@400;700&display=swap';
    document.head.appendChild(fontLink);

    const style = document.createElement('style');
    style.setAttribute('data-portaltext', '');
    style.textContent = STYLES;
    document.head.appendChild(style);
  }

  if (document.head) injectStyles();
  else document.addEventListener('DOMContentLoaded', injectStyles, { once: true });

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

  // ----- Anchor classification -----
  // Two-step process: findHoverable() decides whether a click target activates
  // the runtime at all (explicit classes always; plain <a href> only in plain mode
  // and not opted out). classify() decides whether to send {target} (Wikipedia
  // path) or {url} (Readability path) to /summary.
  const WIKI_NAMESPACES = /^(Special|File|Category|Help|Wikipedia|Portal|Talk|User|Template|MediaWiki):/i;

  function findHoverable(target) {
    const explicit = target.closest?.('a.wikilink, a.extlink');
    if (explicit) return explicit;
    if (!PLAIN_ANCHORS) return null;
    const a = target.closest?.('a[href]');
    if (!a) return null;
    if (a.classList.contains('no-portaltext')) return null;
    if (a.closest('[data-portaltext="off"]')) return null;
    const href = a.getAttribute('href');
    if (!href || !/^https?:/i.test(href)) return null;
    return a;
  }

  function classify(link) {
    if (link.classList.contains('wikilink')) {
      const term = link.dataset.term;
      return term ? { isExternal: false, payload: term } : null;
    }
    if (link.classList.contains('extlink')) {
      const url = link.dataset.url;
      return url ? { isExternal: true, payload: url } : null;
    }
    // Plain mode: classify by URL
    const href = link.getAttribute('href');
    if (!href) return null;
    let u;
    try { u = new URL(href, location.href); } catch { return null; }
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

  // ----- SSE consumer for /summary -----
  // `payload` is either {target, context} (Wikipedia) or {url, context} (any URL).
  async function streamSummary(payload, onDelta, onFinal) {
    const resp = await fetch(SUMMARY_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.error || `Summary failed: ${resp.status}`);
    }
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf('\n\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);
        if (data === '[DONE]') return;
        let event;
        try { event = JSON.parse(data); } catch { continue; }
        if (event.type === 'delta' && event.text) onDelta(event.text);
        else if (event.type === 'final') onFinal(event);
        else if (event.type === 'error') throw new Error(event.message || 'Summary error');
      }
    }
  }

  // ----- Origin context -----
  // Extract the origin page's title + lead so /summary can frame the
  // contextualization in terms of where the reader currently is. Uses Mozilla
  // Readability over the live document; falls back to <h1>/<h2> + body
  // textContent on list-shaped pages where Readability bails.
  let currentArticle = null;

  function getCurrentContext() {
    if (!currentArticle) return null;
    return { title: currentArticle.title, lead: currentArticle.lead };
  }

  function refreshOriginContext() {
    try {
      if (typeof Readability === 'function') {
        const article = new Readability(document.cloneNode(true)).parse();
        if (article && article.textContent && article.textContent.trim().length > 200) {
          currentArticle = {
            title: (article.title || document.title || 'this page').trim(),
            lead: article.textContent.replace(/\s+/g, ' ').trim().slice(0, 500)
          };
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
  }

  // Resolves the origin context to send with a /summary request. Three sources,
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
  // 3. Page-level currentArticle, set by refreshOriginContext (Readability).
  function getContextForElement(el) {
    if (STACK.length > 0 && STACK.some(s => s.el.contains(el))) {
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
    return getCurrentContext();
  }

  // ----- Tooltip stack engine -----
  const HOVER_OPEN_DELAY = 220;   // ms before opening
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

  document.addEventListener('mousemove', (e) => {
    lastCursorX = e.clientX;
    lastCursorY = e.clientY;
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
  // Uses :hover query rather than engagedCount — browser is the source of truth.
  function isAnyChainElementHovered() {
    return STACK.some(s => s.el.matches(':hover') || s.trigger.matches(':hover'));
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
      if (STACK[i].el.contains(el)) return i + 1;
    }
    return 0;
  }

  function openTooltip(cls, trigger, depth) {
    const { isExternal, payload: term } = cls;
    const headerLabel = isExternal ? hostnameOf(term) : term;
    const el = document.createElement('div');
    el.className = 'tooltip';
    el.dataset.depth = depth;
    el.innerHTML = `
      <h3>${escapeHtml(headerLabel)}</h3>
      <div class="body"><div class="loading"><div class="pt-spinner"><div class="pt-spinner-frame pt-spinner-small"></div><div class="pt-spinner-frame pt-spinner-medium"></div><div class="pt-spinner-frame pt-spinner-big"></div></div></div></div>
    `;
    document.body.appendChild(el);
    positionTooltip(el, trigger);
    requestAnimationFrame(() => el.classList.add('visible'));

    trigger.classList.add('active');

    const item = {
      el, term, trigger, depth,
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

    function maybeReposition() {
      const r = el.getBoundingClientRect();
      const margin = 8;
      if (r.bottom > window.innerHeight - margin || r.right > window.innerWidth - margin) {
        positionTooltip(el, trigger);
      }
    }

    const ctx = getContextForElement(trigger);
    const summaryRequest = isExternal
      ? { url: term, context: ctx }
      : { target: term, context: ctx };

    function startStream() {
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

      streamSummary(summaryRequest,
        (delta) => {
          if (!STACK.includes(item)) return;
          streamBuffer += delta;
          ensureStreamNode();
          streamTextNode.data = stripTagsForStream(streamBuffer);
          maybeReposition();
        },
        (data) => {
          if (!STACK.includes(item)) return;
          el.querySelector('h3').textContent = data.title || term;
          bodyEl.innerHTML = data.html;
          bodyEl.classList.add('just-finalized');
          positionTooltip(el, trigger);
        }
      ).catch(err => {
        if (!STACK.includes(item)) return;
        showRetry(err);
      });
    }

    function showRetry(err) {
      const msg = friendlyError(err);
      bodyEl.innerHTML = `<div class="tt-error">${escapeHtml(msg)} <button class="tt-retry" type="button">Try again</button></div>`;
      const btn = bodyEl.querySelector('.tt-retry');
      if (btn) btn.addEventListener('click', (e) => {
        // Stop bubbling: otherwise the runtime's document click handler runs after
        // we've already replaced bodyEl's contents — the original button reference
        // is now detached, contains() returns false, and the handler interprets it
        // as a click outside the chain and dismisses everything.
        e.stopPropagation();
        startStream();
      });
    }

    startStream();
  }

  // Translate raw error messages into something friendlier. Most failures are
  // transient (rate limits, API hiccups, timeouts) — phrase them so the user
  // knows retry is the right move. A few terminal failures (image too large,
  // SSRF rejection, weird content type) get a less-encouraging message but
  // still fit the same UI.
  function friendlyError(err) {
    const m = (err?.message || '').toLowerCase();
    // Specific hosts the server flagged as unsupported (auth-walled, bot-blocked, etc).
    const unsupported = m.match(/unsupported source:\s*(\S+)/);
    if (unsupported) {
      const host = unsupported[1];
      if (host.includes('x.com') || host.includes('twitter')) return "X (Twitter) doesn't allow link previews.";
      return `${host} doesn't allow link previews.`;
    }
    if (m.includes('429') || m.includes('rate limit')) return 'Hit a rate limit.';
    if (/\b5\d\d\b/.test(m) || m.includes('anthropic')) return 'API hiccup.';
    if (m.includes('took too long') || m.includes('timeout')) return "That didn't respond in time.";
    if (m.includes('readable') || m.includes('extract')) return "Couldn't read this page.";
    if (m.includes('cannot summarize') || m.includes('content type')) return "Can't summarize this kind of content.";
    if (m.includes('too large') || m.includes('too big')) return 'Too large to summarize.';
    if (m.includes('private ip') || m.includes('local host') || m.includes('only http')) return "Can't fetch that link.";
    return 'Something went wrong.';
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
  }

  function removeTooltip(item) {
    if (!item) return;
    if (item.lockTimer) { clearTimeout(item.lockTimer); item.lockTimer = null; }
    if (item.closeTimer) { clearTimeout(item.closeTimer); item.closeTimer = null; }
    if (item.handlers) {
      item.el.removeEventListener('mouseenter', item.handlers.enter);
      item.el.removeEventListener('mouseleave', item.handlers.leave);
      item.trigger.removeEventListener('mouseenter', item.handlers.triggerEnter);
      item.trigger.removeEventListener('mouseleave', item.handlers.triggerLeave);
    }
    item.trigger.classList.remove('active');
    item.el.classList.remove('visible');
    item.el.style.opacity = '0';
    setTimeout(() => item.el.remove(), 220);
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

  document.addEventListener('mouseover', (e) => {
    const link = findHoverable(e.target);
    if (!link) return;

    const cls = classify(link);
    if (!cls) return;

    if (STACK.some(s => s.trigger === link)) return;

    const depth = depthOfContainer(link);

    if (openTimer) clearTimeout(openTimer);
    openTimer = setTimeout(() => {
      openTimer = null;
      while (STACK.length > depth) {
        removeTooltip(STACK.pop());
      }
      openTooltip(cls, link, depth);
    }, HOVER_OPEN_DELAY);
  });

  document.addEventListener('mouseout', (e) => {
    const link = findHoverable(e.target);
    if (link && openTimer) { clearTimeout(openTimer); openTimer = null; }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllTooltips();
  });

  // Engine-only click: stack management. Click navigation on the protocol
  // anchors themselves is host concern (native href, or a host-bound listener).
  document.addEventListener('click', (e) => {
    if (!STACK.length) return;
    if (findHoverable(e.target)) return; // host handles these
    const containingItem = STACK.find(s => s.el.contains(e.target));
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

  // ----- Public API -----
  // Hosts call refreshOriginContext() after navigating between page states (SPA),
  // and closeAllTooltips() when initiating a navigation that should dismiss the chain.
  window.portaltext = {
    refreshOriginContext,
    closeAllTooltips,
    getCurrentContext
  };
})();
