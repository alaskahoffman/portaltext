# portaltext extension (v0.3.0)

Chrome extension (Manifest V3) for [portaltext](https://portaltext.com) —
hover any link for an instant, context-aware AI summary of where it leads,
framed by the page you're on. Recursive: links inside tooltips hover too.

Licensed **MIT** (see [LICENSE](LICENSE)) — fork it, port the hover pattern,
point it at your own backend. The server lives at the repo root under
AGPL-3.0.

## Architecture

- **`manifest.json`** — MV3, no static content scripts. Permissions:
  `storage`, `scripting` (programmatic injection), `tabs` (install-time sweep
  of open tabs), `contextMenus` ("make hoverable" on selections),
  `<all_urls>` host permission.
- **`background.js`** — service worker. Owns:
  - injection (per-domain disable list + always-skip list; injects
    `vendor/readability.js`, `vendor/purify.min.js`, `portaltext.js`);
  - the **silent anonymous identity**: on install (and on any request without
    a token) it registers with `POST /auth/anon` and stores the bearer token
    in `chrome.storage.local` — no user-facing signup;
  - all network: long-lived ports for `/summary` SSE streaming (with
    abort-on-dismiss), one-shot ports for `/annotate`, `/etymology`, and
    credentialed paywall prefetch (extracted locally so authenticated HTML
    never reaches the server).
- **`portaltext.js`** — the content script (~3.4k lines): hover detection,
  tooltip rendering (DOMPurify-sanitized, fails closed), recursive stacking,
  citation detection, full-page annotation, etymology trees, saves.
- **`popup.html` / `popup.js`** — per-domain toggle, usage ring, language +
  theme settings, optional hold-Control activation, saves list, and the
  install ID (click-to-copy; quote it in support requests or supporter upgrades).

## Install (dev)

1. `chrome://extensions` → enable **Developer mode**
2. **Load unpacked** → select this `extension/` directory

To run against your own server, change the endpoint constants at the top of
`background.js` and `popup.js`.

## Per-anchor opt-out

Pages can mark anchors as non-hoverable:

- `<a class="no-portaltext" href="...">` — single anchor
- `data-portaltext="off"` on any ancestor — subtree

## Release

Zip this directory (minus the zips) and upload to the Chrome Web Store
dashboard. Ship server changes **before** publishing an extension version
that depends on them.
