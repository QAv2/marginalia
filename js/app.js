// Marginalia — Phase 1A (still-marginalia revision).
//
// Pivot from first iteration:
//   Drift removed. Continuous motion in the user's periphery was hostile to
//   focused attention while reading/writing. Marginalia in real books do not
//   move; they sit in the gutter and wait. We honor that.
//
// Now:
//   - 6 fixed slots (3 left margin, 3 right margin)
//   - Layout stable across regen cycles — eye learns to ignore until summoned
//   - Old orbits fade out → DOM swap → new orbits fade in on regen
//   - Hover unchanged (drift pause is moot now; expansion bubble fades in)

const WORKER_URL = (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  ? "http://localhost:8787/orbits"
  : "https://marginalia-api.qav2.workers.dev/orbits";
const IDLE_MS        = 600;        // typing settles after this many ms of no input
const FIRST_REGEN_MS = 1000;       // first orbit set arrives ~1s after pasting/pause
const REGEN_MS       = 12000;      // subsequent regen cadence
const CONTEXT_CHARS  = 1500;
const FADE_OUT_MS    = 280;        // matches CSS .orbit opacity transition

const $canvas      = document.getElementById("canvas");
const $field       = document.getElementById("orbit-field");
const $frame       = document.getElementById("canvas-frame");
const $status      = document.getElementById("status");
const $statusState = document.getElementById("status-state");
const $statusN     = document.getElementById("status-orbits");
const $summon      = document.getElementById("summon");

let orbits = [];
let typing = false;
let typingTimer = null;
let regenTimer = null;
let lastRegen = 0;
let regenInflight = false;

function setStatus(state, n, isError = false) {
  $statusState.textContent = state;
  if (n !== undefined) $statusN.textContent = `${n} orbit${n === 1 ? "" : "s"}`;
  $status.classList.toggle("error", isError);
}

function getCursorOffsetInCanvas() {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!$canvas.contains(range.startContainer)) return null;
  const measure = document.createRange();
  measure.selectNodeContents($canvas);
  measure.setEnd(range.startContainer, range.startOffset);
  return measure.toString().length;
}

function getContext() {
  const text = $canvas.innerText || "";
  if (text.length <= CONTEXT_CHARS) return text;

  const cursor = getCursorOffsetInCanvas();
  if (cursor === null) {
    // No active cursor in canvas → trailing window
    return text.slice(-CONTEXT_CHARS);
  }
  // Cursor present → window centered on cursor (clamped to text bounds)
  const half = Math.floor(CONTEXT_CHARS / 2);
  let start = Math.max(0, cursor - half);
  let end = Math.min(text.length, start + CONTEXT_CHARS);
  start = Math.max(0, end - CONTEXT_CHARS); // re-clamp if end hit the tail
  return text.slice(start, end);
}

// ── Typing / idle / regen scheduling ─────────────────────────────

$canvas.addEventListener("input", () => {
  if (!typing) setStatus("typing", orbits.length);
  typing = true;
  cancelRegen();
  clearTimeout(typingTimer);
  typingTimer = setTimeout(onIdle, IDLE_MS);
});

// Strip rich formatting on paste — pasted text inherits the manuscript style.
$canvas.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData("text/plain");
  document.execCommand("insertText", false, text);
});

function onIdle() {
  typing = false;
  setStatus("idle", orbits.length);
  // Auto-summon happens ONCE — on the first idle when we have context but no
  // orbits yet. After that, the user owns the refresh rate via the summon
  // button. The mind needs time to process; we don't refresh on a timer.
  if (orbits.length > 0) return;
  if (getContext().trim().length < 50) return;
  scheduleRegen(FIRST_REGEN_MS);
}

function scheduleRegen(delayMs) {
  cancelRegen();
  regenTimer = setTimeout(() => {
    regenTimer = null;
    if (!typing) regenerate();
  }, delayMs);
}

function cancelRegen() {
  if (regenTimer) { clearTimeout(regenTimer); regenTimer = null; }
}

// ── Slot placement (3 left, 3 right) ─────────────────────────────

function getSlotPosition(slotIndex, orbitW, orbitH) {
  const fieldRect = $field.getBoundingClientRect();
  const frameRect = $frame.getBoundingClientRect();
  const cL = frameRect.left  - fieldRect.left;
  const cR = frameRect.right - fieldRect.left;

  const isLeft = slotIndex < 3;
  const row = slotIndex % 3;

  // Vertical: 3 evenly-spaced rows centered in the field
  const fieldH = fieldRect.height;
  const rowCenter = (fieldH / 4) * (row + 1); // 25%, 50%, 75%
  const y = Math.max(12, Math.min(fieldH - orbitH - 12, rowCenter - orbitH / 2));

  // Horizontal: centered within the available margin band
  let x;
  if (isLeft) {
    const marginW = Math.max(0, cL);
    x = Math.max(12, (marginW - orbitW) / 2);
  } else {
    const marginW = Math.max(0, fieldRect.width - cR);
    x = cR + Math.max(12, (marginW - orbitW) / 2);
  }

  return { x, y };
}

function placeOrbitInSlot(o, slotIndex) {
  const w = o.el.offsetWidth || 200;
  const h = o.el.offsetHeight || 30;
  const { x, y } = getSlotPosition(slotIndex, w, h);
  o.el.style.transform = `translate(${x}px, ${y}px)`;
}

// ── Orbit DOM ────────────────────────────────────────────────────

function makeOrbit({ fragment, expansion }) {
  const el = document.createElement("div");
  el.className = "orbit";

  const frag = document.createElement("div");
  frag.className = "orbit-fragment";
  frag.textContent = fragment;
  el.appendChild(frag);

  const exp = document.createElement("div");
  exp.className = "orbit-expansion";
  exp.textContent = expansion;
  el.appendChild(exp);

  $field.appendChild(el);

  const o = { el, fragment, expansion, hovered: false, leaveTimer: null };

  // Hover with a 250ms grace period: lets you move the mouse from the
  // fragment to the expansion bubble (across the visual gap) without the
  // bubble vanishing before you can read it.
  el.addEventListener("mouseenter", () => {
    if (o.leaveTimer) { clearTimeout(o.leaveTimer); o.leaveTimer = null; }
    o.hovered = true;
    el.classList.add("active");
  });
  el.addEventListener("mouseleave", () => {
    o.leaveTimer = setTimeout(() => {
      o.hovered = false;
      el.classList.remove("active");
      o.leaveTimer = null;
    }, 250);
  });

  return o;
}

function fadeOutAll() {
  return new Promise((resolve) => {
    if (orbits.length === 0) return resolve();
    for (const o of orbits) o.el.classList.remove("visible");
    setTimeout(resolve, FADE_OUT_MS);
  });
}

function clearOrbitsImmediate() {
  for (const o of orbits) o.el.remove();
  orbits = [];
}

// ── Regenerate ───────────────────────────────────────────────────

async function regenerate() {
  if (regenInflight) return;
  regenInflight = true;
  $summon.disabled = true;
  setStatus("listening", orbits.length);

  try {
    const r = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: getContext() }),
    });
    if (!r.ok) {
      const detail = await r.text();
      throw new Error(`worker ${r.status}: ${detail.slice(0, 120)}`);
    }
    const data = await r.json();
    const items = (data.orbits || [])
      .filter((it) => it && it.fragment && it.expansion)
      .slice(0, 6);

    await fadeOutAll();
    clearOrbitsImmediate();

    for (let i = 0; i < items.length; i++) {
      const o = makeOrbit(items[i]);
      orbits.push(o);
      // Two rAFs: one for the browser to render with opacity 0 at slot,
      // one for the transition to fire when .visible is added.
      requestAnimationFrame(() => {
        placeOrbitInSlot(o, i);
        requestAnimationFrame(() => o.el.classList.add("visible"));
      });
    }

    lastRegen = performance.now();
    setStatus(typing ? "typing" : "idle", orbits.length);
  } catch (err) {
    console.error("[marginalia] regen failed", err);
    setStatus(err.message.slice(0, 80), orbits.length, true);
    lastRegen = performance.now(); // back off on failure too; don't hammer
  } finally {
    regenInflight = false;
    $summon.disabled = false;
  }
}

// ── Summon button (user-triggered refresh) ───────────────────────

$summon.addEventListener("click", () => {
  if (regenInflight) return;
  if (getContext().trim().length < 50) {
    setStatus("nothing to whisper to", orbits.length);
    return;
  }
  cancelRegen(); // any pending auto-first-load can yield to the explicit ask
  regenerate();
});

// ── Resize: re-pin slots so orbits don't drift off-margin ────────

window.addEventListener("resize", () => {
  for (let i = 0; i < orbits.length; i++) {
    placeOrbitInSlot(orbits[i], i);
  }
});

setStatus("ready", 0);
