// Marginalia worker — orbital fragment generation.
//
// POST /orbits   body: { context: string }
//                resp: { orbits: [ { fragment, expansion } ] }
// GET  /         resp: "marginalia worker ok"

const SYSTEM = `You are a reader marking up the margins of a book the author has handed you in working draft.

You are NOT the author. You read as readers actually read — bringing your own knowledge, blind spots, obsessions, and references. The author already has their own next thoughts; your job is to surface the readings they would otherwise never see.

Generate 6 marginalia. Vary the perspectives they come FROM:
- some from a reader who knows MORE than the author about a specific corner (etymology, comparative myth, music theory, sports, science, history, theology, law, anything)
- some from a reader who knows LESS and asks what a curious outsider would ask
- some from a reader who DISAGREES or notices a weak seam
- some from a reader who CONNECTS the passage to a completely different domain or tradition the author hasn't cited

Each fragment: ≤ 8 words. Specific to this passage. Not a completion of the author's sentence. Not a "have you considered…?" coaching question — you are a reader, not a coach.

Each expansion: a single sentence, ≤ 30 words. A real reader's marginal note — agreement, disagreement, surprise, curiosity, parallel, citation — not a critic's verdict and not a polished restatement of what the author already wrote.

Do NOT return 6 fragments that all sound like the author's own next thought. The author can already think those. Range across the kinds of readers a draft might encounter — scholarly, naive, hostile, enthusiastic, cross-disciplinary.

Output strict JSON only — no prose before or after, no code fences:
{ "orbits": [ { "fragment": "...", "expansion": "..." }, ... ] }`;

function corsHeadersFor(request, env) {
  const origin = request.headers.get("Origin") || "";
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
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

    if (!env.ANTHROPIC_API_KEY) {
      return json({ error: "ANTHROPIC_API_KEY not set" }, { status: 500 }, cors);
    }

    let body;
    try { body = await request.json(); }
    catch { return json({ error: "invalid json" }, { status: 400 }, cors); }

    const context = String(body.context || "").slice(-1500);
    if (context.trim().length < 50) {
      return json({ orbits: [] }, {}, cors);
    }

    let upstream;
    try {
      upstream = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: env.ANTHROPIC_MODEL || "claude-haiku-4-5-20251001",
          max_tokens: 1500,
          system: SYSTEM,
          messages: [{
            role: "user",
            content: `The author hands you this page from their working draft:\n---\n${context}\n---\n\nWrite 6 marginalia. JSON only.`,
          }],
        }),
      });
    } catch (err) {
      return json({ error: "fetch failed", detail: String(err) }, { status: 502 }, cors);
    }

    if (!upstream.ok) {
      const detail = await upstream.text();
      return json({ error: "anthropic error", status: upstream.status, detail }, { status: 502 }, cors);
    }

    const data = await upstream.json();
    const text = data.content?.[0]?.text || "";

    let parsed;
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "").trim();
      parsed = JSON.parse(cleaned);
    } catch {
      return json({ error: "parse error", raw: text }, { status: 502 }, cors);
    }

    const orbits = Array.isArray(parsed.orbits) ? parsed.orbits : [];
    return json({ orbits }, {}, cors);
  },
};
