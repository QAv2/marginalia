# Marginalia

**Live: [marginalia-md.netlify.app](https://marginalia-md.netlify.app)**

The reader-marginalia an author would otherwise never see.

When a real reader marks up the margins of a book with their reactions, those notes stay with the reader — the author never gets that view. Marginalia closes that loop: paste your draft into the canvas, hand it to a reader, and see the kind of marginal annotations they would have written. Cross-references, parallels from traditions you haven't cited, naive questions, skeptical pushback.

Click `↻ summon` when you want a fresh set. Click any fragment to pin it across summons.

## Heritage

Built with Claude. The system prompt was iterated against Claude's voice and reasoning depth, and the default reader is Claude Haiku 4.5 — that's what the tool was tuned for and where it feels most coherent.

The architecture, however, is **model-agnostic**. The worker uses a provider-adapter pattern (see `worker/src/worker.js`); the Anthropic adapter is the first adapter, not the only code path. OpenAI, Mistral, local Ollama, or any chat-capable LLM can be added in roughly twenty lines. Pick your favorite reader. Off you go.

## How it works

Three pieces:

- **Frontend** (`index.html`, `js/app.js`, `css/style.css`) — vanilla HTML/CSS/JS, no build step. Six fixed margin slots (3 left, 3 right) hold the marginalia. User-summoned only; no auto-refresh on a timer. The user owns the rate of arrival.
- **Worker** (`worker/src/worker.js`) — Cloudflare Worker that proxies requests to whatever LLM provider you've configured. Holds the API key. Handles CORS. Returns 6 (or N) marginalia per call.
- **System prompt** (in worker) — casts the model as a *reader* of the draft, not a commentator or assistant. Explicitly varies the perspectives the marginalia come *from* (more-knowledgeable / less-knowledgeable / disagreeing / cross-domain). Refuses author-echo by design.

## Run locally

You need two terminals.

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

The worker uses an adapter pattern. To add a new provider:

1. Open `worker/src/worker.js`. There are commented sketches for OpenAI and Ollama — uncomment one or write your own following the pattern.
2. Each adapter is one async function: `({ systemPrompt, userMessage, model, env }) → string`. It calls the provider's chat-completion endpoint and returns the model's text response. Throw on error.
3. Add the adapter to the `getProviders(env)` map: `name → { defaultModel, call }`.
4. Set the provider's API key as a worker secret (`npx wrangler secret put OPENAI_API_KEY`).
5. The frontend can then request that provider via the `provider` field in the POST body. Default stays whatever `DEFAULT_PROVIDER` points at.

Request body shape:

```json
{
  "context": "<= 1500 chars of the author's prose centered on the cursor>",
  "count": 6,
  "provider": "anthropic",
  "model": "claude-haiku-4-5-20251001"
}
```

`provider` and `model` are optional — defaults apply. The response body now also returns `provider` and `model` so the frontend can confirm what served the request.

## Architecture notes

- **No drift.** Marginalia don't move. Real notes in real books don't drift across the page; the brain treats peripheral motion as interruption regardless of how slow it is. The orbits sit still until you summon a new set.
- **No auto-refresh.** Notes get added when a reader has a thought, not on a timer. The mind needs processing time between intellectual stimuli; the user owns the rate.
- **Reader-not-author voice.** The system prompt explicitly does NOT instruct the model to "match the author's register." Doing so produces author-echo. Instead it asks the model to vary the *origins* of the marginalia — sometimes more-knowledgeable than the author, sometimes less, sometimes disagreeing, sometimes connecting to a domain the author hasn't cited.
- **Pin.** Click a fragment to pin it; the worker is then asked for only the count of fresh fragments needed (1-6). Token cost scales with what's actually requested.
