# portaltext

An LLM-enabled augmentation to hypertext. The portaltext protocol bridges the
gap between hyperlink origin and destination — connecting two pages to each
other and to the rest of the open web through them.

Hover any link to see a short, context-aware summary of where it leads,
framed by where you currently are. Hover the links inside the summary to
recurse. Works on articles, PDFs, images, citations (arXiv/DOI/PMID), and
plain prose via full-page annotation.

**[Install from the Chrome Web Store](https://chromewebstore.google.com/detail/portaltext/hlhjiehpelkfhdcihpdpkmgodapjlfcb)**
· free, account-less, no tracking · [portaltext.com](https://portaltext.com)

## Design principles

- **Gel, not generator.** The AI is connective tissue between pages that
  already exist. It summarizes and links; it never invents claims. Every
  Wikipedia link the model emits is verified against the live API before it
  reaches you.
- **Account-less by default.** The extension registers a silent anonymous
  identity on install. No email, no password, no onboarding. Quotas are
  per-install credits that refill daily and bank for a week.
- **Privacy as architecture.** Each hover sends the link URL plus a small
  excerpt of the current page for context — nothing else. No hover history is
  stored, no tracking, no ads. Paywalled pages you're logged into are
  extracted locally in your browser; the authenticated HTML never crosses the
  server.

## Repository layout

| Path | What it is | License |
|---|---|---|
| `server.js` | The whole backend: summary streaming (SSE), quota/credit system, anonymous identities, spend breaker | AGPL-3.0 |
| `index.html` | portaltext.com | AGPL-3.0 |
| `portaltext.js` | Standalone drop-in runtime — powers the homepage's live demo; embeddable on any page via `<script src="/portaltext.js" data-endpoint="/summary">` | AGPL-3.0 |
| `extension/` | The Chrome extension (MV3): content script, service worker, popup | **MIT** (`extension/LICENSE`) |
| `welcome.html`, `privacy.html` | Auxiliary pages | AGPL-3.0 |
| `scripts/` | Operational scripts (usage digest, tier grants) | AGPL-3.0 |

The split is deliberate: the extension is MIT so anyone can fork, port, or
embed the hover-tooltip pattern freely. The server is AGPL so hosted
derivatives stay open.

## Self-hosting

```bash
git clone https://github.com/alaskahoffman/portaltext && cd portaltext
npm install
cp .env.example .env   # fill in at least ANTHROPIC_API_KEY
npm run dev            # http://localhost:3000
```

See [.env.example](.env.example) for every knob — model provider selection
(Anthropic / OpenRouter / Together), the daily spend breaker, proxy depth,
and storage paths. Two that matter in production:

- `TRUSTED_PROXY_HOPS` must match your real reverse-proxy depth or per-IP
  rate limits won't work correctly.
- `AUTH_DB_PATH` should live on a persistent disk — it holds all identities
  and quota state.

To point your own extension build at your own server, edit the endpoint
constants at the top of `extension/background.js` and `extension/popup.js`.

## Contributing

portaltext is a personal project by [Alaska Hoffman](https://twitter.com/145k4),
maintained in the gaps between other work. Issues and PRs are welcome but may
sit a while; small focused PRs have the best odds. Bug reports about tooltip
rendering on specific sites are especially useful — include the URL and what
you hovered.

## License

Server, site, and standalone runtime: [AGPL-3.0](LICENSE).
Extension: [MIT](extension/LICENSE).
© 2026 Alaska Hoffman.
