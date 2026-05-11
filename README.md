# Marginalia

**Live: [marginalia-md.netlify.app](https://marginalia-md.netlify.app)**

The reader-marginalia an author would otherwise never see.

When a real reader marks up the margins of a book with their reactions, those notes stay with the reader — the author never gets that view. Marginalia closes that loop: write in the canvas, hand it to a reader, and see the kind of marginal annotations they would have written. Cross-references, parallels from traditions you haven't cited, naive questions, skeptical pushback.

Click `↻ summon` when you want a fresh set. Click any fragment to pin it across summons.

## Heritage

Built with Claude. The system prompt was iterated against Claude's voice and reasoning depth, and the default reader is Claude Haiku 4.5 — that's what the tool was tuned for and where it feels most coherent.

The architecture, however, is **model-agnostic**. The worker uses a provider-adapter pattern; adding a new provider is one async function and a registry entry. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

**Supported providers:** Anthropic (default), OpenAI, Mistral, Ollama (local), Cloudflare Workers AI (free fallback).

## How it works

Three pieces:

- **Frontend** (`index.html`, `js/app.js`, `css/style.css`) — vanilla HTML/CSS/JS, no build step. Six fixed margin slots (3 left, 3 right) hold the marginalia. User-summoned only; no auto-refresh on a timer. The user owns the rate of arrival.
- **Worker** (`worker/src/worker.js`) — Cloudflare Worker that proxies requests to whatever LLM provider you've configured. Holds the API key. Handles CORS. Returns up to 6 marginalia per call.
- **System prompt** (in worker) — casts the model as a *reader* of the draft, not a commentator or assistant. Explicitly varies the perspectives the marginalia come *from* (more-knowledgeable / less-knowledgeable / disagreeing / cross-domain). Refuses author-echo by design.

## Features

- **Two reader stances** — drafting (six probing fragments) and reading (three sparse, appreciative fragments)
- **Form hints** — optional vocabulary-of-attention calibration (poetry, essay, fiction, memoir, technical writing, journalism, etc.)
- **Pin** — click a fragment to keep it; only unpinned slots regenerate, saving tokens
- **BYOK** — bring your own API key for any supported provider; key stays in your browser, never stored server-side
- **Trial compute** — ~25 free summons with real Claude Haiku, then graceful fallback to free open model
- **File open/save** — load `.txt`/`.md` files, save your work back out
- **Keyboard shortcuts** — `Cmd+.` silence (5 min), `Cmd+Shift+S` summon
- **Copy** — copy any fragment + expansion to clipboard
- **Mobile responsive** — margins collapse below the canvas on narrow screens

## Run locally

Two terminals.

**Terminal 1 — worker:**

```bash
cd worker
echo 'ANTHROPIC_API_KEY=sk-ant-…' > .dev.vars
chmod 600 .dev.vars
npx wrangler dev
```

**Terminal 2 — frontend:**

```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`. The frontend auto-detects `localhost` and routes to the local worker.

## Host your own

1. Fork this repo.
2. Deploy the worker:
   ```bash
   cd worker
   npx wrangler secret put ANTHROPIC_API_KEY   # paste your key
   npx wrangler deploy
   ```
   Worker URL will be `https://marginalia-api.<your-subdomain>.workers.dev`.
3. In `js/app.js`, point `WORKER_URL`'s production branch at your deployed worker.
4. In `worker/wrangler.toml`, add your frontend's URL to `ALLOWED_ORIGINS`.
5. Deploy the frontend (Netlify, Cloudflare Pages, GitHub Pages — anything that serves static files).

## Swap providers

See [CONTRIBUTING.md](CONTRIBUTING.md) for full adapter-authoring instructions. The short version: one async function, one registry entry, one worker secret.

## Architecture notes

- **No drift.** Marginalia don't move. Real notes in real books don't drift across the page; the brain treats peripheral motion as interruption regardless of how slow it is. The orbits sit still until you summon a new set.
- **No auto-refresh.** Notes get added when a reader has a thought, not on a timer. The mind needs processing time between intellectual stimuli; the user owns the rate.
- **Reader-not-author voice.** The system prompt explicitly does NOT instruct the model to "match the author's register." Doing so produces author-echo. Instead it asks the model to vary the *origins* of the marginalia — sometimes more-knowledgeable than the author, sometimes less, sometimes disagreeing, sometimes connecting to a domain the author hasn't cited.
- **Pin economy.** Click a fragment to pin it; the worker is then asked for only the count of fresh fragments needed (1-6). Token cost scales with what's actually requested.

## License

MIT. See [LICENSE](LICENSE).
