# Marginalia

Non-chat AI thinking surface. You write in the center; Claude generates orbital fragments that drift in the margins, each ready to expand to a sentence on hover.

> *What Clippy could have been if Microsoft had respected the writer's attention.*

## Phase 1A — orbits only

This phase ships:
- Paste/type into the central canvas
- 6 orbital fragments drift in the margin (cream italic small-caps on dark)
- Hover an orbit → drift pauses + parchment expansion bubble fades in
- Frozen during typing; resumes ~600 ms after last keystroke
- Regenerates ~1 s after first sustained pause, then every ~12 s

Pin / weave / silence affordances and the gesture layer arrive in Phase 1B+.

## Run locally

You need two terminals.

### Terminal 1 — Cloudflare Worker (Anthropic proxy)

First-time setup:

    cd ~/marginalia/worker
    echo 'ANTHROPIC_API_KEY=sk-ant-…' > .dev.vars
    chmod 600 .dev.vars

Then on every dev session:

    npx wrangler dev

Worker is now at `http://localhost:8787`.
- `GET  /` → `marginalia worker ok`
- `POST /orbits` → `{ orbits: [{ fragment, expansion }] }`

### Terminal 2 — frontend

    cd ~/marginalia
    python3 -m http.server 8000

Open `http://localhost:8000`.

## Test substrate

Paste a real piece of in-progress writing. Lorem ipsum will lie about whether the orbits are useful — they need real cognitive density to evaluate against.

## Behavioral targets (Phase 1A)

- 6 orbits per regen cycle
- Fragment ≤ 8 words; expansion ≤ 30 words; both come from the same Haiku call
- Idle threshold: 600 ms after last keystroke
- First regen: ≥ 1 s after first idle (so a pasted draft surfaces orbits quickly)
- Subsequent regen: every 12 s of sustained idle
- Drift: ~8 px/s; freezes during typing; freezes when a single orbit is hovered
- Bounce off field edges + canvas frame (orbits never drift over the writing area)
- Context window sent to worker: trailing 1500 chars of canvas

## What to evaluate (the test script for Joe)

1. Paste in a real scroll draft (or any dense in-progress writing).
2. Wait. Watch the first cycle of orbits arrive (~1.5 s).
3. **First question — register fit:** do the fragments sound like marginalia in *your* voice, or do they sound like generic AI prompts? Don't grade individual fragments — grade the average across all six.
4. **Second question — drift feel:** is the motion meditative, or fidgety? When you stop typing and look up, does the field feel alive or busy?
5. **Third question — hover-expand:** when you hover an orbit, does the expansion *earn* the fragment? I.e., do you read the sentence and think "yes, that's what the fragment was pointing at" — or does it feel like a mismatch?
6. Type for 30 s, stop, watch one full regen cycle (12 s pause). Does the fresh set feel responsive to where you ended up in the prose, or does it feel like it's still chasing the start?
7. Cost check: open `wrangler dev` terminal — note request count. We should see one request per regen cycle, not per keystroke.

Report back with: what feels right, what feels wrong, what surprised you, and one thing you wish were different. That's the input I need before Phase 1B.
