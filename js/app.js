// Marginalia — Phase 1A + 1B-pin.
//
// Six fixed margin slots (3 left, 3 right). User-summoned only.
// Click any orbit's fragment to pin/unpin — pinned orbits survive across
// summons; only unpinned slots get replaced. The worker is asked for
// exactly the number of fresh fragments needed (1-6), saving tokens when
// most slots are pinned.

const WORKER_URL = (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  ? "http://localhost:8787/orbits"
  : "https://marginalia-api.qav2.workers.dev/orbits";

const IDLE_MS        = 600;
const FIRST_REGEN_MS = 1000;
const REGEN_MS       = 12000;
const CONTEXT_CHARS  = 1500;
const FADE_OUT_MS    = 280;
const NUM_SLOTS      = 6;

const $canvas      = document.getElementById("canvas");
const $field       = document.getElementById("orbit-field");
const $frame       = document.getElementById("canvas-frame");
const $status      = document.getElementById("status");
const $statusState = document.getElementById("status-state");
const $statusN     = document.getElementById("status-orbits");
const $summon      = document.getElementById("summon");

// Each slot is null OR { el, fragment, expansion, pinned, hovered, leaveTimer }
let slots = new Array(NUM_SLOTS).fill(null);
let typing = false;
let typingTimer = null;
let regenTimer = null;
let lastRegen = 0;
let regenInflight = false;

// ── Slot accessors ───────────────────────────────────────────────

function getOrbitCount() {
  return slots.filter(Boolean).length;
}

function getPinnedCount() {
  return slots.filter((s) => s && s.pinned).length;
}

function getRefreshableSlotIndices() {
  // Slots that are either empty OR occupied by an unpinned orbit.
  // These are the slots a regen will touch.
  const indices = [];
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (!slots[i] || !slots[i].pinned) indices.push(i);
  }
  return indices;
}

function setStatus(state, n, isError = false) {
  $statusState.textContent = state;
  if (n !== undefined) $statusN.textContent = `${n} orbit${n === 1 ? "" : "s"}`;
  $status.classList.toggle("error", isError);
}

function updateSummonState() {
  const allPinned = getPinnedCount() === NUM_SLOTS;
  $summon.disabled = regenInflight || allPinned;
}

// ── Cursor-aware context ─────────────────────────────────────────

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
    return text.slice(-CONTEXT_CHARS);
  }
  const half = Math.floor(CONTEXT_CHARS / 2);
  let start = Math.max(0, cursor - half);
  let end = Math.min(text.length, start + CONTEXT_CHARS);
  start = Math.max(0, end - CONTEXT_CHARS);
  return text.slice(start, end);
}

// ── Typing / idle / regen scheduling ─────────────────────────────

$canvas.addEventListener("input", () => {
  if (!typing) setStatus("typing", getOrbitCount());
  typing = true;
  cancelRegen();
  clearTimeout(typingTimer);
  typingTimer = setTimeout(onIdle, IDLE_MS);
});

$canvas.addEventListener("paste", (e) => {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData("text/plain");
  document.execCommand("insertText", false, text);
});

function onIdle() {
  typing = false;
  setStatus("idle", getOrbitCount());
  // Auto-summon happens ONCE — only when all slots are empty AND we have
  // context. If even one orbit (pinned or unpinned) exists, the user owns
  // the refresh rate via the summon button.
  if (getOrbitCount() > 0) return;
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

  const fieldH = fieldRect.height;
  const rowCenter = (fieldH / 4) * (row + 1); // 25%, 50%, 75%
  const y = Math.max(12, Math.min(fieldH - orbitH - 12, rowCenter - orbitH / 2));

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
  el.draggable = false;

  const frag = document.createElement("div");
  frag.className = "orbit-fragment";
  frag.textContent = fragment;
  frag.draggable = false;
  el.appendChild(frag);

  const exp = document.createElement("div");
  exp.className = "orbit-expansion";
  exp.textContent = expansion;
  exp.draggable = false;
  el.appendChild(exp);

  // Belt + suspenders against browsers that still try to start a drag
  // (Firefox in particular ignores -webkit-user-drag).
  el.addEventListener("dragstart", (e) => e.preventDefault());

  $field.appendChild(el);

  const o = { el, fragment, expansion, pinned: false, hovered: false, leaveTimer: null };

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

  // Click on the FRAGMENT toggles pin. Click on the bubble selects text
  // (so you can highlight a phrase from the expansion without accidentally
  // pinning/unpinning).
  frag.addEventListener("click", (e) => {
    e.stopPropagation();
    o.pinned = !o.pinned;
    el.classList.toggle("pinned", o.pinned);
    updateSummonState();
    setStatus(typing ? "typing" : "idle", getOrbitCount());
  });

  return o;
}

function fadeOutUnpinned() {
  const targets = slots.filter((s) => s && !s.pinned);
  return new Promise((resolve) => {
    if (targets.length === 0) return resolve();
    for (const o of targets) o.el.classList.remove("visible");
    setTimeout(resolve, FADE_OUT_MS);
  });
}

function clearUnpinnedSlots() {
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (slots[i] && !slots[i].pinned) {
      slots[i].el.remove();
      slots[i] = null;
    }
  }
}

// ── Regenerate ───────────────────────────────────────────────────

async function regenerate() {
  if (regenInflight) return;

  const targetSlots = getRefreshableSlotIndices();
  if (targetSlots.length === 0) {
    setStatus("all pinned", getOrbitCount());
    return;
  }

  regenInflight = true;
  $summon.disabled = true;
  setStatus("listening", getOrbitCount());

  try {
    const r = await fetch(WORKER_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ context: getContext(), count: targetSlots.length }),
    });
    if (!r.ok) {
      const detail = await r.text();
      throw new Error(`worker ${r.status}: ${detail.slice(0, 120)}`);
    }
    const data = await r.json();
    const items = (data.orbits || [])
      .filter((it) => it && it.fragment && it.expansion)
      .slice(0, targetSlots.length);

    await fadeOutUnpinned();
    clearUnpinnedSlots();

    for (let i = 0; i < items.length; i++) {
      const slotIndex = targetSlots[i];
      const o = makeOrbit(items[i]);
      slots[slotIndex] = o;
      requestAnimationFrame(() => {
        placeOrbitInSlot(o, slotIndex);
        requestAnimationFrame(() => o.el.classList.add("visible"));
      });
    }

    lastRegen = performance.now();
    setStatus(typing ? "typing" : "idle", getOrbitCount());
  } catch (err) {
    console.error("[marginalia] regen failed", err);
    setStatus(err.message.slice(0, 80), getOrbitCount(), true);
    lastRegen = performance.now();
  } finally {
    regenInflight = false;
    updateSummonState();
  }
}

// ── Summon button (user-triggered refresh) ───────────────────────

$summon.addEventListener("click", () => {
  if (regenInflight) return;
  if (getPinnedCount() === NUM_SLOTS) {
    setStatus("all pinned", getOrbitCount());
    return;
  }
  if (getContext().trim().length < 50) {
    setStatus("nothing to whisper to", getOrbitCount());
    return;
  }
  cancelRegen();
  regenerate();
});

// ── Resize: re-pin slots so orbits don't drift off-margin ────────

window.addEventListener("resize", () => {
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (slots[i]) placeOrbitInSlot(slots[i], i);
  }
});

setStatus("ready", 0);
