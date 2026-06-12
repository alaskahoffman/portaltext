/*
 * popup.js — toolbar UI.
 *
 * Account-less by design: the default state is the silent anon identity's
 * usage chip (plan label + daily-usage ring), with all controls (per-domain
 * toggle, annotate, saves, settings) always available. There is no sign-in
 * — the install ID (visible in settings, click-to-copy) is the identity.
 *
 * The per-domain toggle reads the active tab's hostname, looks it up in
 * chrome.storage.local (under DISABLED_KEY), and flips it on click, asking
 * the service worker to re-evaluate the tab so enabling takes effect
 * immediately. Disabling requires a refresh to undo (already-injected
 * listeners persist on the current page until reload).
 */

const DISABLED_KEY = 'disabledDomains';
const THEME_KEY = 'theme';
const AUTH_TOKEN_KEY = 'authToken';
const AUTH_USER_KEY = 'authUser';      // cached publicUserFields blob; refreshed on each popup open

// Single base for backend + site links. Point at http://localhost:3000 to
// test against a local server (keep background.js's API_BASE in sync).
const API_BASE = 'https://portaltext.com';
const AUTH_BASE = `${API_BASE}/auth`;
const UPGRADE_URL = `${API_BASE}/#pricing`;

const toggleEl = document.getElementById('toggle');
const domainEl = document.getElementById('domain');
const stateWordEl = document.getElementById('state-word');
const unsupportedEl = document.getElementById('unsupported');
const themeToggleEl = document.getElementById('themeToggle');
const annotateBtnEl = document.getElementById('annotateBtn');
const annotateLabelEl = annotateBtnEl?.querySelector('.annotate-label');
const savesListEl = document.getElementById('savesList');
const savesNavBtnEl = document.getElementById('savesNavBtn');
const savesBackBtnEl = document.getElementById('savesBackBtn');
const settingsNavBtnEl = document.getElementById('settingsNavBtn');
const settingsBackBtnEl = document.getElementById('settingsBackBtn');
const languageSelectEl = document.getElementById('languageSelect');
const mainViewEl = document.getElementById('mainView');
const savesViewEl = document.getElementById('savesView');
const settingsViewEl = document.getElementById('settingsView');
const popupToolsEl = document.getElementById('popupTools');

const PREF_LANG_KEY = 'preferredLanguage';

// View-stack pattern. Adding new subviews means: drop a
// <section id="xView" hidden> alongside the existing ones, add an entry
// here, and wire its nav button + back button to call showView('x') /
// showView('main').
const VIEWS = {
  main:     () => mainViewEl,
  saves:    () => savesViewEl,
  settings: () => settingsViewEl,
};
function showView(name) {
  for (const [key, getEl] of Object.entries(VIEWS)) {
    const el = getEl();
    if (el) el.hidden = (key !== name);
  }
  if (name === 'saves') renderSavesList();
  if (name === 'settings') loadSettings();
}

async function loadSettings() {
  if (languageSelectEl) {
    const { [PREF_LANG_KEY]: lang = 'auto' } = await chrome.storage.local.get(PREF_LANG_KEY);
    languageSelectEl.value = lang;
  }
  // Install ID — the anon identity's user id. Shown so people can quote it
  // in support requests and (eventually) supporter-tier upgrades.
  if (installIdEl) {
    const { [AUTH_USER_KEY]: user = null } = await chrome.storage.local.get(AUTH_USER_KEY);
    installIdEl.textContent = user?.id || 'not registered yet';
    installIdEl.dataset.fullId = user?.id || '';
  }
}

// Same key as the content script uses — chrome.storage.sync first, falling
// back to .local when sync isn't available.
const SAVES_KEY = 'savedTooltips';
function getSavesStorageArea() {
  return chrome.storage?.sync || chrome.storage?.local || null;
}
function loadSavesFromStorage() {
  return new Promise((resolve) => {
    const area = getSavesStorageArea();
    if (!area) return resolve([]);
    area.get(SAVES_KEY, (data) => resolve(Array.isArray(data?.[SAVES_KEY]) ? data[SAVES_KEY] : []));
  });
}
function writeSavesToStorage(saves) {
  return new Promise((resolve) => {
    const area = getSavesStorageArea();
    if (!area) return resolve(false);
    area.set({ [SAVES_KEY]: saves }, () => resolve(!chrome.runtime?.lastError));
  });
}

const authInfoEl = document.getElementById('auth-info');
const authEmailDisplayEl = document.getElementById('auth-email-display');
const authPlanDisplayEl = document.getElementById('auth-plan-display');
const authUsageDisplayEl = document.getElementById('auth-usage-display');
const authUsageFillEl = document.getElementById('auth-usage-fill');
const authUpgradeEl = document.getElementById('auth-upgrade');
const installIdEl = document.getElementById('installIdEl');

function hostnameOf(url) {
  try { return new URL(url).hostname; } catch { return null; }
}

async function getDisabledDomains() {
  const { [DISABLED_KEY]: list = [] } = await chrome.storage.local.get(DISABLED_KEY);
  return new Set(list);
}

async function setDisabledDomains(set) {
  await chrome.storage.local.set({ [DISABLED_KEY]: Array.from(set) });
}

function renderToggle(host, isDisabled) {
  domainEl.textContent = host;
  stateWordEl.textContent = isDisabled ? 'off' : 'on';
  toggleEl.classList.toggle('on',  !isDisabled);
  toggleEl.classList.toggle('off',  isDisabled);
  // Account-less: the controls are always available. Even before the anon
  // identity resolves, hovering self-heals via the worker's ensureAuthToken.
  toggleEl.hidden = false;
  updateAnnotateVisibility(isDisabled);
}

let cachedUserTier = null;
let cachedActiveTab = null;
let cachedTabHost = null;

// Updates the state-card / unsupported visuals based on the cached tab.
async function refreshExtensionUiForTab() {
  if (!cachedActiveTab) return;
  const url = cachedActiveTab.url || '';
  if (!/^https?:/i.test(url) || !cachedTabHost) {
    renderUnsupported();
    return;
  }
  const disabled = await getDisabledDomains();
  renderToggle(cachedTabHost, disabled.has(cachedTabHost));
}
function updateAnnotateVisibility(isDisabledForDomain) {
  if (!annotateBtnEl) return;
  // Annotation is available to everyone — the server prices it in credits
  // rather than gating it behind a plan.
  annotateBtnEl.hidden = isDisabledForDomain;
}

async function renderSavesList() {
  if (!savesListEl) return;
  const saves = await loadSavesFromStorage();
  if (saves.length === 0) {
    savesListEl.innerHTML = '<li class="saves-empty">No saved tooltips yet. Star one to add it here.</li>';
    return;
  }
  // Truncate long titles in JS so the markup doesn't ship full source URLs.
  const trunc = (s, n) => (s && s.length > n) ? s.slice(0, n - 1) + '…' : (s || '');
  savesListEl.innerHTML = saves.map((s, i) => {
    // Prefer the AI-generated tooltip header captured at save time. Fall
    // back to the term (wiki) or hostname (external) for older records
    // that predate the displayTitle field.
    const fallbackTitle = s.isExternal ? (safeHostname(s.url) || s.url) : s.term;
    const title = trunc(s.displayTitle || fallbackTitle, 36);
    // Source: cleaned site name (X, CNN, HackerNews) rather than the full
    // browser tab title (which often includes section breadcrumbs like
    // "Home / X"). Older records may have a sourcePageTitle field —
    // derive a clean site name from sourceUrl as a fallback.
    const siteName = s.sourceSiteName || (s.sourceUrl ? safeHostname(s.sourceUrl) : null);
    const sourceLine = siteName
      ? `<span class="saves-item-source">from ${escapeHtmlText(trunc(siteName, 36))}</span>`
      : '';
    return `<li class="saves-item" data-index="${i}">
      <span class="saves-item-title">${escapeHtmlText(title)}</span>
      ${sourceLine}
      <button class="saves-item-remove" type="button" aria-label="Remove" data-index="${i}">×</button>
    </li>`;
  }).join('');
  // Wire interactions.
  savesListEl.querySelectorAll('.saves-item').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      if (ev.target.closest('.saves-item-remove')) return;
      const idx = Number(el.getAttribute('data-index'));
      const item = saves[idx];
      if (!item || !cachedActiveTab?.id) return;
      const url = cachedActiveTab.url || '';
      if (!/^https?:/i.test(url)) {
        // Can't dispatch into chrome:// or PDF viewer tabs. Visual nudge only.
        el.style.transition = 'background-color 200ms ease';
        el.style.background = 'var(--paper-dim)';
        setTimeout(() => el.style.background = '', 600);
        return;
      }
      try {
        await chrome.tabs.sendMessage(cachedActiveTab.id, {
          type: 'pt-open-saved',
          term: item.term,
          isExternal: !!item.isExternal,
          url: item.url,
          lang: item.lang || null, // restore the language the tooltip was saved in
        });
        window.close(); // close the popup so the user can see the tooltip
      } catch {
        // Content script not loaded (extension was just enabled, page hasn't
        // reloaded). Soft fail — user can refresh and retry.
      }
    });
  });
  savesListEl.querySelectorAll('.saves-item-remove').forEach((btn) => {
    btn.addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const idx = Number(btn.getAttribute('data-index'));
      const next = saves.filter((_, i) => i !== idx);
      await writeSavesToStorage(next);
      renderSavesList();
    });
  });
}

// Re-render the saves list if storage changes while the popup is open
// (rare but cheap — e.g. saves cleared from devtools or a save made via
// another browser tab that happened to sync within the popup's lifetime).
if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (changes[SAVES_KEY]) renderSavesList();
  });
}

function safeHostname(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return null; }
}
function escapeHtmlText(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

function renderUnsupported() {
  toggleEl.hidden = true;
  unsupportedEl.hidden = false;
  if (annotateBtnEl) annotateBtnEl.hidden = true;
}

// ---- Identity chip ----

function renderSignedIn(user) {
  authInfoEl.hidden = false;
  // Anon identities (the normal case) show a friendly label. Legacy email
  // rows can still authenticate until their sessions expire — show their
  // email if one comes back from /auth/me.
  if (authEmailDisplayEl) authEmailDisplayEl.textContent = user.is_anon ? 'portaltext' : (user.email || 'portaltext');
  if (authPlanDisplayEl) authPlanDisplayEl.textContent = user.is_anon ? 'free' : (user.plan_tier || 'free');
  // Usage ring fills with today's usage against today's TOTAL available —
  // which is today's refill plus whatever was banked from prior days.
  // daily_used / (daily_used + quota_remaining) gives the "fraction of
  // today's pool you've consumed" reading: heavy days with no bank fill
  // the ring fast; same usage with a full bank fills it slowly.
  // daily_limit=null means unlimited (beta): hide the ring entirely.
  // Circumference = 2*PI*r ≈ 43.98 (r=7 in viewBox 0 0 18 18).
  const CIRCUMFERENCE = 43.98;
  const dailyLimit = user.daily_limit;
  const dailyUsed = user.daily_used ?? 0;
  const remaining = user.quota_remaining ?? 0;
  if (dailyLimit == null) {
    if (authUsageDisplayEl) authUsageDisplayEl.hidden = true;
  } else {
    if (authUsageDisplayEl) authUsageDisplayEl.hidden = false;
    const startOfDayPool = dailyUsed + remaining;
    const usedFraction = startOfDayPool > 0
      ? Math.min(1, Math.max(0, dailyUsed / startOfDayPool))
      : 0;
    authUsageFillEl.style.strokeDashoffset = (CIRCUMFERENCE * (1 - usedFraction)).toFixed(2);
  }
  // Upgrade button hidden for now — the $7 Plus pitch is retired; it comes
  // back as the supporter flow once the Stripe link + claim code ship.
  if (authUpgradeEl) authUpgradeEl.hidden = true;
  // Cache the tier so the annotate-button visibility (which depends on both
  // plan and per-domain enable state) can update without re-fetching /me.
  cachedUserTier = user.plan_tier || 'free';
  // Show extension controls (toggle / tools row) once we know there's a
  // signed-in user. Saves nav inside the tools row gates separately on
  // paid tier via updateSavesNavVisibility.
  if (popupToolsEl) popupToolsEl.hidden = false;
  if (toggleEl && !toggleEl.hidden) {
    updateAnnotateVisibility(toggleEl.classList.contains('off'));
  }
  updateSavesNavVisibility();
  // If user just signed in via the form during this popup session, the
  // toggle/unsupported were hidden by the prior signed-out render. Refresh.
  if (cachedActiveTab) refreshExtensionUiForTab();
}

// "No identity yet" — fresh install before /auth/anon resolves, or the
// rare case where registration failed (offline). The extension still works
// account-lessly (the worker self-heals on the next hover), so all controls
// stay visible; the identity chip just stays empty until the ID exists.
function renderNoIdentity() {
  authInfoEl.hidden = true;
  cachedUserTier = null;
  if (popupToolsEl) popupToolsEl.hidden = false;
  updateSavesNavVisibility();
  if (cachedActiveTab) refreshExtensionUiForTab();
}

// Saves are a free feature — they live in chrome.storage.sync (keyed by
// Chrome profile, persisting across sign-ins) and cost the server nothing.
// The supporter tier sells unlimited usage, not features.
function updateSavesNavVisibility() {
  if (!savesNavBtnEl) return;
  savesNavBtnEl.hidden = false;
}

async function fetchMe(token) {
  try {
    const resp = await fetch(`${AUTH_BASE}/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.user || null;
  } catch {
    return null;
  }
}

async function initAuth() {
  let { [AUTH_TOKEN_KEY]: storedToken = '', [AUTH_USER_KEY]: cachedUser = null } =
    await chrome.storage.local.get([AUTH_TOKEN_KEY, AUTH_USER_KEY]);

  // Optimistic render: if we have a cached user object, show it immediately.
  // Otherwise render the no-identity state — controls visible, no sign-in
  // form. Account-less means the popup never leads with an auth wall.
  if (storedToken && cachedUser) renderSignedIn(cachedUser);
  else renderNoIdentity();

  // No token: ask the worker to register (or finish registering) the silent
  // anon identity. Routed through the worker so a hover racing the popup
  // can't mint a second identity. If it fails (offline), the no-identity
  // render stands and the next hover retries.
  if (!storedToken) {
    try {
      const { token = '' } = await chrome.runtime.sendMessage({ type: 'ensure-auth' }) || {};
      if (token) {
        storedToken = token;
        const { [AUTH_USER_KEY]: anonUser = null } = await chrome.storage.local.get(AUTH_USER_KEY);
        if (anonUser) renderSignedIn(anonUser);
      }
    } catch { /* worker unreachable — keep no-identity render */ }
  }

  // Probe the server for the live user (validates the token + refreshes
  // usage). If the token is stale, clear it; the next popup open or hover
  // re-registers a fresh anon identity.
  if (storedToken) {
    const fresh = await fetchMe(storedToken);
    if (fresh) {
      renderSignedIn(fresh);
      await chrome.storage.local.set({ [AUTH_USER_KEY]: fresh });
    } else {
      await chrome.storage.local.remove([AUTH_TOKEN_KEY, AUTH_USER_KEY]);
      renderNoIdentity();
    }
  }

  authUpgradeEl?.addEventListener('click', () => {
    chrome.tabs.create({ url: UPGRADE_URL });
  });

}

function applyTheme(theme) {
  const t = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', t);
  // Icons inside the button (sun + moon) handle the visual switch via CSS
  // (see :root[data-theme="dark"] rules in popup.html) — no textContent
  // update needed, and overwriting it would wipe the icon markup.
}

async function init() {
  // One-time cleanup: legacy testerToken key from before the auth system
  // was wired up. Removing it from local storage so we don't carry stale
  // identity data around.
  chrome.storage.local.remove('testerToken').catch(() => {});

  // Auth: render the right state (signed-in chip vs sign-in form) and
  // wire submit + sign-out handlers. Runs first so the auth section is
  // populated before the rest of the popup paints, avoiding a flash.
  initAuth();

  // Theme: applied as early as possible so the popup doesn't flash
  // light before swapping to dark.
  const { [THEME_KEY]: storedTheme = 'light' } = await chrome.storage.local.get(THEME_KEY);
  applyTheme(storedTheme);
  themeToggleEl.addEventListener('click', async () => {
    const current = document.documentElement.getAttribute('data-theme') || 'light';
    const next = current === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    await chrome.storage.local.set({ [THEME_KEY]: next });
  });

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  cachedActiveTab = tab || null;
  const url = tab?.url || '';
  const host = /^https?:/i.test(url) ? hostnameOf(url) : null;
  cachedTabHost = host;
  await refreshExtensionUiForTab();

  // Toggle click handler — attached once per popup session. Uses the
  // popup's cachedTabHost so signing in mid-session updates correctly.
  toggleEl.addEventListener('click', async () => {
    if (!cachedTabHost) return;
    const fresh = await getDisabledDomains();
    if (fresh.has(cachedTabHost)) {
      fresh.delete(cachedTabHost);
      await setDisabledDomains(fresh);
      chrome.runtime.sendMessage({ type: 'reinject', tabId: tab.id, url: tab.url });
    } else {
      fresh.add(cachedTabHost);
      await setDisabledDomains(fresh);
    }
    renderToggle(cachedTabHost, fresh.has(cachedTabHost));
  });

  // Annotate-this-page action. Sends a one-shot message to the content
  // script in the active tab; it runs Readability + the /annotate endpoint
  // and wraps interesting phrases as wikilinks. Visible only when
  // portaltext is enabled for the current domain (managed in renderToggle).
  if (annotateBtnEl) {
    annotateBtnEl.addEventListener('click', async () => {
      annotateBtnEl.disabled = true;
      annotateBtnEl.classList.remove('success', 'error');
      annotateLabelEl.textContent = 'Annotating…';
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'annotate' });
        if (response?.error) throw new Error(response.error);
        const applied = response?.applied || 0;
        annotateBtnEl.classList.add('success');
        annotateLabelEl.textContent = applied === 1 ? '1 link added' : `${applied} links added`;
      } catch (err) {
        annotateBtnEl.classList.add('error');
        const msg = (err?.message || '').toLowerCase();
        annotateLabelEl.textContent = msg.includes('pdf')
          ? 'PDFs not supported'
          : (msg.includes('receiving end') ? 'Refresh page first' : 'Annotation failed');
      } finally {
        annotateBtnEl.disabled = false;
        // Restore the idle label after a few seconds so the button stays reusable.
        setTimeout(() => {
          annotateBtnEl.classList.remove('success', 'error');
          annotateLabelEl.textContent = 'Annotate this page';
        }, 4000);
      }
    });
  }

  // Nav: tools-row buttons open their subviews; each subview's back
  // link returns to main. All views share the popup header above.
  if (savesNavBtnEl) {
    savesNavBtnEl.addEventListener('click', () => showView('saves'));
  }
  if (savesBackBtnEl) {
    savesBackBtnEl.addEventListener('click', () => showView('main'));
  }
  if (settingsNavBtnEl) {
    settingsNavBtnEl.addEventListener('click', () => showView('settings'));
  }
  if (settingsBackBtnEl) {
    settingsBackBtnEl.addEventListener('click', () => showView('main'));
  }
  if (languageSelectEl) {
    languageSelectEl.addEventListener('change', async () => {
      await chrome.storage.local.set({ [PREF_LANG_KEY]: languageSelectEl.value });
    });
  }
  if (installIdEl) {
    installIdEl.addEventListener('click', async () => {
      const id = installIdEl.dataset.fullId;
      if (!id) return;
      try {
        await navigator.clipboard.writeText(id);
        const orig = installIdEl.textContent;
        installIdEl.textContent = 'copied!';
        setTimeout(() => { installIdEl.textContent = orig; }, 1200);
      } catch { /* clipboard unavailable — the id is still visible to copy by hand */ }
    });
  }
}

init();
