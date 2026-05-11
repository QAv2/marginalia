// Marginalia worker — model-agnostic reader-marginalia generator.
//
// POST /orbits   body: { context, count?, mode?, provider?, model? }
//                       mode: "drafting" (default) | "reading"
//                resp: { orbits: [{ fragment, expansion }], mode, provider, model }
// GET  /         resp: "marginalia worker ok"
//
// Two stances:
//   - DRAFTING: working-draft reader. Six probing fragments, varied skeptical
//     and curious perspectives. The default — the author is mid-piece and
//     wants the readings they would otherwise never see.
//   - READING:  finished-piece reader. Three sparse fragments weighted toward
//     recognition, association, and earned appreciation. The right stance for
//     a piece that is done; the wrong stance for a piece in motion.
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
// adapter calls Claude Haiku 4.5 — that's what the system prompts were tuned
// against. The architecture is intentionally provider-agnostic; Anthropic is
// the first adapter, not the only one.

const SYSTEM_DRAFTING = `You are a reader marking up the margins of a book the author has handed you in working draft.

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

const SYSTEM_READING = `You are a real reader marking up the margins of a finished piece the author has handed you.

This is not a working draft. The author is not asking for edits, corrections, fact-checks, or seam-hunting. They are asking for the marginalia a reader leaves in their own copy — the notes that stay with the reader and the author never sees.

What that looks like:
- recognition — naming a structural move the piece is making, that the author may have made by instinct ("the inversion at the center is the whole engine")
- association — a passage, tradition, or current the piece resonates with ("this echoes Borges in 'The Garden of Forking Paths'")
- appreciation — terse, earned, the gutter checkmark ("yes" / "this lands" / "exactly")
- attentive observation — the quiet note a careful reader would write to themselves about a voice, a choice, an inheritance

What you DO NOT write:
- corrections, fact-checks, "actually, X is Y not Z"
- "have you considered" coaching questions
- weak-seam hunting or naive-reader gotcha
- anything an editor or critic would write — this piece is finished, the stance is reader

Range across reader registers — scholarly, instinctive, cross-disciplinary, enthusiastic — but always read WITH the piece, not against it. If a fragment sounds like an editor, rewrite it.

Each fragment: ≤ 8 words. Specific to this passage.
Each expansion: 1–2 sentences, ≤ 50 words. A reader's voice in the gutter — not a critic's verdict.

Marginalia in this mode is sparse and earned — fewer fragments than drafting-mode by design. Coverage is not the goal; resonance is.

Output strict JSON only — no prose before or after, no code fences:
{ "orbits": [ { "fragment": "...", "expansion": "..." }, ... ] }`;

const MODES = {
  drafting: { system: SYSTEM_DRAFTING, defaultCount: 6, frame: (ctx, n) =>
    `The author hands you this page from their working draft:\n---\n${ctx}\n---\n\nWrite ${n} marginalia. JSON only.` },
  reading:  { system: SYSTEM_READING,  defaultCount: 3, frame: (ctx, n) =>
    `The author hands you this finished page and asks: what would a real reader write in the gutters?\n---\n${ctx}\n---\n\nWrite ${n} reader-marginalia (recognition, association, appreciation — not editorial). JSON only.` },
};

const DEFAULT_MODE = "drafting";

// Form hints — optional vocabulary-of-attention block appended to the active
// stance system prompt when the user picks a form. Stance controls reader
// orientation (probing vs. appreciative); form controls reader vocabulary
// (what readers of THIS kind of text specifically attend to). Absent form
// signal → no append, default behavior preserved.
const FORM_HINTS = {
  "creative writing": `The piece is creative writing. A reader of creative work attends to: voice, image, cadence, structural moves, mythic or symbolic logic. Read the music alongside the meaning — what the prose is doing, not just what it says.`,
  "fiction": `The piece is fiction. A reader of fiction attends to: character motivation, scene logic, dialogue rhythm, what is withheld vs. revealed, the relationship between narration and character, the choice of which moment to enter and which to leave.`,
  "poetry": `The piece is poetry. A reader of poetry attends to: line break, sound, image, the gap, the gesture of white space, syntactic torque, what the form is enacting alongside what it states. The page is part of the poem.`,
  "essay": `The piece is an essay (lyric, argumentative, or critical). A reader of essays attends to: how the position is earned, the relationship between voice and claim, the texture of digression and return, the moves that make a turn feel inevitable.`,
  "memoir": `The piece is memoir or personal nonfiction. A reader of memoir attends to: voice, truth-telling, the relationship between the reflecting self and the remembered self, what is named and what is left unsaid, interiority and craft together.`,
  "research paper": `The piece is academic or research writing. A reader of research attends to: the claim/evidence chain, methodology, scope of conclusions, prior art, where the argument is strongest and where it depends on assumed context.`,
  "technical writing": `The piece is technical writing (documentation, spec, explainer). A reader of technical writing attends to: clarity, precision, edge cases, definition order, what an unfamiliar reader would need that is currently assumed, where examples earn their place.`,
  "journalism": `The piece is journalism or reportage. A reader of journalism attends to: sourcing, accuracy, the narrative arc imposed on facts, scene vs. summary, where the writer's frame is visible and where it disappears.`,
};

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
  const text = data.content?.[0]?.text || "";
  const usage = data.usage
    ? { input_tokens: data.usage.input_tokens, output_tokens: data.usage.output_tokens }
    : null;
  return { text, usage };
}

async function callOpenAI({ systemPrompt, userMessage, model, env }) {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 1500,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userMessage },
      ],
    }),
  });
  if (!r.ok) throw new Error(`openai ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  const text = data.choices?.[0]?.message?.content || "";
  const usage = data.usage
    ? { input_tokens: data.usage.prompt_tokens, output_tokens: data.usage.completion_tokens }
    : null;
  return { text, usage };
}

async function callWorkersAI({ systemPrompt, userMessage, model, env }) {
  if (!env.AI) throw new Error("Workers AI binding not configured");
  const response = await env.AI.run(model, {
    messages: [
      { role: "system", content: systemPrompt + "\n\nIMPORTANT: Output strict JSON only — no prose, no code fences, no markdown. Just the raw JSON object." },
      { role: "user", content: userMessage },
    ],
  });
  return { text: response.response || "", usage: null };
}

// ── Provider registry ────────────────────────────────────────────

const WORKERS_AI_MODEL = "@cf/meta/llama-3.1-8b-instruct";

function getProviders(env, userApiKey = "") {
  const envWithUserKey = userApiKey
    ? { ...env, ANTHROPIC_API_KEY: userApiKey, OPENAI_API_KEY: userApiKey }
    : env;
  const providers = {
    anthropic: {
      defaultModel: env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
      call: (opts) => callAnthropic({ ...opts, env: envWithUserKey }),
    },
  };
  if (userApiKey || env.OPENAI_API_KEY) {
    providers.openai = {
      defaultModel: env.OPENAI_MODEL || "gpt-4o-mini",
      call: (opts) => callOpenAI({ ...opts, env: envWithUserKey }),
    };
  }
  if (env.AI) {
    providers.free = {
      defaultModel: WORKERS_AI_MODEL,
      call: (opts) => callWorkersAI({ ...opts, env }),
    };
  }
  return providers;
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
    "Access-Control-Allow-Headers": "Content-Type, X-User-Api-Key",
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
      return json({
        ok: true,
        modes: Object.keys(MODES),
        forms: Object.keys(FORM_HINTS),
        providers: Object.keys(getProviders(env, "")),
        byokProviders: ["anthropic", "openai"],
        defaultProvider: DEFAULT_PROVIDER,
        defaultMode: DEFAULT_MODE,
      }, {}, cors);
    }

    if (request.method !== "POST" || url.pathname !== "/orbits") {
      return json({ error: "not found" }, { status: 404 }, cors);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid json" }, { status: 400 }, cors); }

    const context = String(body.context || "").slice(-1500);
    if (context.trim().length < 50) {
      return json({ orbits: [] }, {}, cors);
    }

    // Resolve mode
    const modeName = MODES[body.mode] ? body.mode : DEFAULT_MODE;
    const mode = MODES[modeName];
    const count = Math.min(6, Math.max(1, parseInt(body.count, 10) || mode.defaultCount));

    // Resolve optional form hint (appended to system prompt if recognized)
    const formName = (body.form && FORM_HINTS[body.form]) ? body.form : "";
    const systemPrompt = formName
      ? `${mode.system}\n\n${FORM_HINTS[formName]}`
      : mode.system;

    // Resolve provider + model.
    // BYOK: if the client sends an X-User-Api-Key header, use it instead of
    // the worker's own secret. The key is forwarded to the provider and never
    // stored. This lets users bring their own billing without touching the
    // shared quota.
    const userApiKey = request.headers.get("X-User-Api-Key") || "";
    const PROVIDERS = getProviders(env, userApiKey);
    const providerName = body.provider || env.DEFAULT_PROVIDER || DEFAULT_PROVIDER;
    const adapter = PROVIDERS[providerName];
    if (!adapter) {
      return json({
        error: `unknown provider: ${providerName}`,
        available: Object.keys(PROVIDERS),
      }, { status: 400 }, cors);
    }
    const model = body.model || adapter.defaultModel;

    const userMessage = mode.frame(context, count);

    let result;
    try {
      result = await adapter.call({ systemPrompt, userMessage, model, env });
    } catch (err) {
      return json({
        error: "provider call failed",
        provider: providerName,
        model,
        mode: modeName,
        form: formName,
        detail: String(err.message || err),
      }, { status: 502 }, cors);
    }

    const text = typeof result === "string" ? result : result.text;
    const usage = (typeof result === "object" && result.usage) ? result.usage : null;

    let parsed;
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return json({
        error: "model returned non-JSON",
        provider: providerName,
        model,
        mode: modeName,
        raw: text.slice(0, 500),
      }, { status: 502 }, cors);
    }

    const orbits = Array.isArray(parsed.orbits) ? parsed.orbits : [];
    const resp = { orbits, provider: providerName, model, mode: modeName, form: formName };
    if (usage) resp.usage = usage;
    return json(resp, {}, cors);
  },
};
