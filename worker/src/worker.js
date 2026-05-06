// Marginalia worker — model-agnostic reader-marginalia generator.
//
// POST /orbits   body: { context, count?, provider?, model? }
//                resp: { orbits: [{ fragment, expansion }] }
// GET  /         resp: "marginalia worker ok"
//
// Adding a new provider:
//   1. Write an async function `callX({ systemPrompt, userMessage, model, env })`
//      that calls the provider's chat-completion endpoint and returns the
//      model's text response. Throw on error.
//   2. Add an entry to the getProviders(env) map: name → { defaultModel, call }.
//   3. Set the provider's API key as a worker secret (e.g.
//      `wrangler secret put OPENAI_API_KEY`).
//   4. Frontend can then request it via `provider` in the request body
//      (default is whichever DEFAULT_PROVIDER points at — currently anthropic).
//
// Heritage: this code was iterated with Claude (Sonnet 4.6) and the default
// adapter calls Claude Haiku 4.5 — that's what the system prompt was tuned
// against. The architecture is intentionally provider-agnostic; Anthropic is
// the first adapter, not the only one.

const SYSTEM = `You are a reader marking up the margins of a book the author has handed you in working draft.

You are NOT the author. You read as readers actually read — bringing your own knowledge, blind spots, obsessions, and references. The author already has their own next thoughts; your job is to surface the readings they would otherwise never see.

Generate the marginalia the author asks for. Vary the perspectives they come FROM:
- some from a reader who knows MORE than the author about a specific corner (etymology, comparative myth, music theory, sports, science, history, theology, law, anything)
- some from a reader who knows LESS and asks what a curious outsider would ask
- some from a reader who DISAGREES or notices a weak seam
- some from a reader who CONNECTS the passage to a completely different domain or tradition the author hasn't cited

Each fragment: ≤ 8 words. Specific to this passage. Not a completion of the author's sentence. Not a "have you considered…?" coaching question — you are a reader, not a coach.

Each expansion: a single sentence, ≤ 30 words. A real reader's marginal note — agreement, disagreement, surprise, curiosity, parallel, citation — not a critic's verdict and not a polished restatement of what the author already wrote.

Do NOT return fragments that all sound like the author's own next thought. The author can already think those. Range across the kinds of readers a draft might encounter — scholarly, naive, hostile, enthusiastic, cross-disciplinary.

Output strict JSON only — no prose before or after, no code fences:
{ "orbits": [ { "fragment": "...", "expansion": "..." }, ... ] }`;

// ── Provider adapters ────────────────────────────────────────────

async function callAnthropic({ systemPrompt, userMessage, model, env }) {
  if (!env.ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY not set");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  if (!r.ok) {
    const detail = await r.text();
    throw new Error(`anthropic ${r.status}: ${detail.slice(0, 300)}`);
  }

  const data = await r.json();
  return data.content?.[0]?.text || "";
}

// ── OpenAI sketch ─ uncomment + add OPENAI_API_KEY secret to enable ──
//
// async function callOpenAI({ systemPrompt, userMessage, model, env }) {
//   if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
//   const r = await fetch("https://api.openai.com/v1/chat/completions", {
//     method: "POST",
//     headers: {
//       "Content-Type": "application/json",
//       "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
//     },
//     body: JSON.stringify({
//       model,
//       max_tokens: 1500,
//       response_format: { type: "json_object" },
//       messages: [
//         { role: "system", content: systemPrompt },
//         { role: "user", content: userMessage },
//       ],
//     }),
//   });
//   if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 300)}`);
//   const data = await r.json();
//   return data.choices?.[0]?.message?.content || "";
// }

// ── Ollama (local) sketch ─ point OLLAMA_HOST at your machine ──
//
// async function callOllama({ systemPrompt, userMessage, model, env }) {
//   const host = env.OLLAMA_HOST || "http://localhost:11434";
//   const r = await fetch(`${host}/api/chat`, {
//     method: "POST",
//     headers: { "Content-Type": "application/json" },
//     body: JSON.stringify({
//       model,
//       stream: false,
//       format: "json",
//       messages: [
//         { role: "system", content: systemPrompt },
//         { role: "user", content: userMessage },
//       ],
//     }),
//   });
//   if (!r.ok) throw new Error(`ollama ${r.status}: ${(await r.text()).slice(0, 300)}`);
//   const data = await r.json();
//   return data.message?.content || "";
// }

// ── Provider registry ────────────────────────────────────────────

function getProviders(env) {
  return {
    anthropic: {
      defaultModel: env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      call: callAnthropic,
    },
    // openai:  { defaultModel: env.OPENAI_MODEL  || "gpt-4o-mini",            call: callOpenAI },
    // ollama:  { defaultModel: env.OLLAMA_MODEL  || "llama3.2",               call: callOllama },
  };
}

const DEFAULT_PROVIDER = "anthropic";

// ── HTTP helpers ─────────────────────────────────────────────────

function corsHeadersFor(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || "*");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

function json(body, init, cors) {
  return new Response(JSON.stringify(body), {
    ...(init || {}),
    headers: { ...(cors || {}), "Content-Type": "application/json" },
  });
}

// ── Request handler ──────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const cors = corsHeadersFor(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: cors });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response("marginalia worker ok", { headers: cors });
    }

    if (request.method !== "POST" || url.pathname !== "/orbits") {
      return json({ error: "not found" }, { status: 404 }, cors);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid json" }, { status: 400 }, cors); }

    const context = String(body.context || "").slice(-1500);
    const count = Math.min(6, Math.max(1, parseInt(body.count, 10) || 6));
    if (context.trim().length < 50) {
      return json({ orbits: [] }, {}, cors);
    }

    // Resolve provider + model
    const PROVIDERS = getProviders(env);
    const providerName = body.provider || env.DEFAULT_PROVIDER || DEFAULT_PROVIDER;
    const adapter = PROVIDERS[providerName];
    if (!adapter) {
      return json({
        error: `unknown provider: ${providerName}`,
        available: Object.keys(PROVIDERS),
      }, { status: 400 }, cors);
    }
    const model = body.model || adapter.defaultModel;

    const userMessage = `The author hands you this page from their working draft:\n---\n${context}\n---\n\nWrite ${count} marginalia. JSON only.`;

    let text;
    try {
      text = await adapter.call({ systemPrompt: SYSTEM, userMessage, model, env });
    } catch (err) {
      return json({
        error: "provider call failed",
        provider: providerName,
        model,
        detail: String(err.message || err),
      }, { status: 502 }, cors);
    }

    let parsed;
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return json({
        error: "model returned non-JSON",
        provider: providerName,
        model,
        raw: text.slice(0, 500),
      }, { status: 502 }, cors);
    }

    const orbits = Array.isArray(parsed.orbits) ? parsed.orbits : [];
    return json({ orbits, provider: providerName, model }, {}, cors);
  },
};
