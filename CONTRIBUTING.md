# Contributing to Marginalia

Marginalia is model-agnostic by design. The most impactful contribution is a new provider adapter — if your favorite LLM can play "thoughtful reader," it belongs here.

## Adding a provider adapter

The worker uses a simple adapter pattern. Each provider is one async function and a registry entry.

### 1. Write the adapter function

Open `worker/src/worker.js`. Your adapter follows this signature:

```js
async function callYourProvider({ systemPrompt, userMessage, model, env }) {
  // Call the provider's chat-completion endpoint.
  // Return { text, usage } where:
  //   text  = the model's raw text response (should be JSON)
  //   usage = { input_tokens, output_tokens } or null if unavailable
}
```

Look at `callAnthropic`, `callOpenAI`, or `callMistral` for working examples. The system prompt and user message are already formatted — your adapter just needs to deliver them to the model and return the response.

### 2. Register it

In `getProviders()`, add your provider to the map:

```js
if (userApiKey || env.YOUR_PROVIDER_API_KEY) {
  providers.yourprovider = {
    defaultModel: env.YOUR_PROVIDER_MODEL || "your-default-model",
    call: (opts) => callYourProvider({ ...opts, env: envWithUserKey }),
  };
}
```

### 3. Set the API key

For local development:
```bash
echo 'YOUR_PROVIDER_API_KEY=...' >> worker/.dev.vars
```

For production:
```bash
npx wrangler secret put YOUR_PROVIDER_API_KEY
```

### 4. Add it to the frontend dropdown

In `index.html`, add an `<option>` to the `#settings-provider` select:

```html
<option value="yourprovider">yourprovider</option>
```

### 5. Test it

```bash
cd worker && npx wrangler dev --port 8787
```

```bash
curl -X POST http://localhost:8787/orbits \
  -H "Content-Type: application/json" \
  -H "X-User-Api-Key: your-key-here" \
  -d '{"context": "The ship hung in the sky in much the same way that bricks do not.", "count": 3, "provider": "yourprovider"}'
```

You should get back `{ "orbits": [...], "provider": "yourprovider", "model": "..." }`.

## Development setup

Two terminals:

**Terminal 1 — worker:**
```bash
cd worker
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars
chmod 600 .dev.vars
npx wrangler dev --port 8787
```

**Terminal 2 — frontend:**
```bash
python3 -m http.server 8000
```

Open `http://localhost:8000`. The frontend auto-detects localhost and routes to the local worker.

## Project structure

```
marginalia/
  index.html              # single-page app
  css/style.css            # illuminated manuscript theme
  js/app.js                # all frontend logic (no build step)
  og.png                   # OpenGraph preview image
  worker/
    src/worker.js           # Cloudflare Worker — adapters + prompts
    wrangler.toml           # worker config + AI binding
    .dev.vars               # local secrets (gitignored)
```

## Design constraints

These are load-bearing decisions, not preferences. Please preserve them in any contribution:

- **No drift.** Marginalia don't move. Peripheral motion is interruption.
- **No auto-refresh.** The user owns the rate of arrival. First load can be automatic; every subsequent set is user-triggered.
- **Reader-not-author voice.** The system prompt casts the model as a reader, not an editor or assistant. Do not add "match the author's register" — it produces author-echo.
- **No build step.** Vanilla JS, vanilla CSS. No bundler, no framework, no transpilation.
- **Illuminated manuscript aesthetic.** EB Garamond, parchment/ink/rubric palette. Contributions should feel like they belong in the same book.

## What else is welcome

- Bug fixes
- Accessibility improvements
- Mobile/touch refinements
- Translations of the landing/about text
- System prompt experiments (open an issue first — the prompts are carefully tuned)

## License

MIT. See LICENSE.
