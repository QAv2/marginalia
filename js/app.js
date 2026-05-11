// Marginalia — Phase 1A + 1B-pin + 1B-stance.
//
// Six fixed margin slots (3 left, 3 right). User-summoned only.
// Click any orbit's fragment to pin/unpin — pinned orbits survive across
// summons; only unpinned slots get replaced. The worker is asked for
// exactly the number of fresh fragments needed, saving tokens when most
// slots are pinned.
//
// Stance toggle (drafting / reading): drafting fills all six slots with
// probing reader-of-working-draft fragments; reading fills three sparse
// reader-of-finished-piece fragments and leaves the other slots empty.

const WORKER_URL = (location.hostname === "localhost" || location.hostname === "127.0.0.1")
  ? "http://localhost:8787/orbits"
  : "https://marginalia-api.qav2.workers.dev/orbits";

const IDLE_MS        = 600;
const FIRST_REGEN_MS = 1000;
const CONTEXT_CHARS  = 1500;
const FADE_OUT_MS    = 280;
const NUM_SLOTS      = 6;

// Mode config — count is the target *total* of occupied slots (pinned + fresh).
const MODE_COUNTS = { drafting: 6, reading: 3 };
const DEFAULT_MODE = "drafting";

// Slot fill preference: alternate left-right so reading-mode 3-fills land
// balanced (top-left, top-right, mid-left) instead of all on one side.
const SLOT_PREFERENCE = [0, 3, 1, 4, 2, 5];

const $canvas      = document.getElementById("canvas");
const $field       = document.getElementById("orbit-field");
const $frame       = document.getElementById("canvas-frame");
const $status      = document.getElementById("status");
const $statusState = document.getElementById("status-state");
const $statusN     = document.getElementById("status-orbits");
const $dismiss     = document.getElementById("dismiss");
const $summon      = document.getElementById("summon");
const $modeToggle  = document.getElementById("mode-toggle");
const $formPicker  = document.getElementById("form-picker");
const $formToggle  = document.getElementById("form-toggle");
const $formMenu    = document.getElementById("form-menu");
const $trialIndicator = document.getElementById("trial-indicator");
const $settingsToggle = document.getElementById("settings-toggle");
const $settingsPanel  = document.getElementById("settings-panel");
const $settingsProvider = document.getElementById("settings-provider");
const $settingsModel    = document.getElementById("settings-model");
const $settingsApiKey   = document.getElementById("settings-apikey");
const $fileInput = document.getElementById("file-input");
const $fileLoad  = document.getElementById("file-load");
const $fileSave  = document.getElementById("file-save");

// Each slot is null OR { el, fragment, expansion, pinned, hovered, leaveTimer }
let slots = new Array(NUM_SLOTS).fill(null);
let typing = false;
let typingTimer = null;
let regenTimer = null;
let regenInflight = false;
let silencedUntil = 0;
let mode = (() => {
  const stored = localStorage.getItem("marginalia_mode");
  return MODE_COUNTS[stored] ? stored : DEFAULT_MODE;
})();
let form = localStorage.getItem("marginalia_form") || "";
let userProvider = localStorage.getItem("marginalia_provider") || "";
let userModel = localStorage.getItem("marginalia_model") || "";
let userApiKey = localStorage.getItem("marginalia_apikey") || "";

// ── Trial budget ────────────────────────────────────────────────
// Haiku 4.5 pricing: $0.80/MTok input, $4.00/MTok output.
const TRIAL_BUDGET_CENTS = 5;
const HAIKU_INPUT_COST  = 0.80 / 1_000_000;  // dollars per token
const HAIKU_OUTPUT_COST = 4.00 / 1_000_000;

function getTrialSpent() {
  return parseFloat(localStorage.getItem("marginalia_trial_spent") || "0");
}

function addTrialCost(usage) {
  if (!usage) return;
  const cost = (usage.input_tokens * HAIKU_INPUT_COST) + (usage.output_tokens * HAIKU_OUTPUT_COST);
  const total = getTrialSpent() + cost;
  localStorage.setItem("marginalia_trial_spent", total.toFixed(6));
  return total;
}

function trialRemaining() {
  return Math.max(0, (TRIAL_BUDGET_CENTS / 100) - getTrialSpent());
}

function isTrialExhausted() {
  return trialRemaining() <= 0;
}

function isByok() {
  return userApiKey.length > 0;
}

const APPROX_COST_PER_SUMMON = 0.002;

function updateTrialDisplay() {
  if (!$trialIndicator) return;
  if (isByok()) {
    $trialIndicator.textContent = "using your key";
    $trialIndicator.classList.remove("exhausted");
    return;
  }
  const remaining = trialRemaining();
  if (remaining <= 0) {
    $trialIndicator.textContent = "trial complete · free model active";
    $trialIndicator.classList.add("exhausted");
  } else {
    const summonsLeft = Math.max(1, Math.round(remaining / APPROX_COST_PER_SUMMON));
    $trialIndicator.textContent = `~${summonsLeft} free summons remaining`;
    $trialIndicator.classList.remove("exhausted");
  }
}

// ── Slot accessors ───────────────────────────────────────────────

function getOrbitCount() {
  return slots.filter(Boolean).length;
}

function getPinnedCount() {
  return slots.filter((s) => s && s.pinned).length;
}

function getModeBudget() {
  return MODE_COUNTS[mode] || NUM_SLOTS;
}

function getRefreshableSlotIndices() {
  // How many fresh orbits we want to add: mode budget minus pinned, floored at 0.
  // (Pinned orbits exceed budget? Honor the user's pins; fetch nothing new.)
  const want = Math.max(0, getModeBudget() - getPinnedCount());
  if (want === 0) return [];
  const candidates = SLOT_PREFERENCE.filter((i) => !slots[i] || !slots[i].pinned);
  return candidates.slice(0, want);
}

function setStatus(state, n, isError = false) {
  $statusState.textContent = state;
  if (n !== undefined) $statusN.textContent = `${n} orbit${n === 1 ? "" : "s"}`;
  $status.classList.toggle("error", isError);
}

function updateSummonState() {
  const budgetReached = getPinnedCount() >= getModeBudget();
  $summon.disabled = regenInflight || budgetReached;
  if ($dismiss) $dismiss.hidden = getOrbitCount() === 0;
}

function renderModeLabel() {
  if ($modeToggle) $modeToggle.textContent = mode;
}

function renderFormLabel() {
  if (!$formToggle) return;
  const label = form || "—";
  // Preserve the caret element by rebuilding the button's text node carefully.
  $formToggle.innerHTML = `${label} <span class="form-caret">▴</span>`;
  // Mark the matching menu item as selected.
  if ($formMenu) {
    for (const li of $formMenu.querySelectorAll("li")) {
      li.classList.toggle("selected", li.dataset.form === form);
    }
  }
}

function closeFormMenu() {
  if (!$formPicker || !$formMenu) return;
  $formMenu.hidden = true;
  $formPicker.classList.remove("open");
  if ($formToggle) $formToggle.setAttribute("aria-expanded", "false");
}

function openFormMenu() {
  if (!$formPicker || !$formMenu) return;
  $formMenu.hidden = false;
  $formPicker.classList.add("open");
  if ($formToggle) $formToggle.setAttribute("aria-expanded", "true");
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
  if (Date.now() < silencedUntil) return;
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

function isMobile() {
  return window.innerWidth <= 768;
}

function placeOrbitInSlot(o, slotIndex) {
  if (isMobile()) return; // CSS handles layout via flexbox on narrow screens
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
  exp.draggable = false;

  const expText = document.createElement("span");
  expText.textContent = expansion;
  exp.appendChild(expText);

  const copyBtn = document.createElement("button");
  copyBtn.className = "orbit-copy";
  copyBtn.type = "button";
  copyBtn.textContent = "copy";
  copyBtn.addEventListener("click", (e) => {
    e.stopPropagation();
    const text = `${fragment} — ${expansion}`;
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = "copied";
      setTimeout(() => { copyBtn.textContent = "copy"; }, 1200);
    });
  });
  exp.appendChild(copyBtn);

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

function clearAllSlots() {
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (slots[i]) {
      slots[i].el.remove();
      slots[i] = null;
    }
  }
  setStatus("cleared", 0);
  updateSummonState();
}

// ── Dismiss button ──────────────────────────────────────────────

if ($dismiss) {
  $dismiss.addEventListener("click", () => {
    if (getOrbitCount() === 0) return;
    clearAllSlots();
  });
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
    const headers = { "Content-Type": "application/json" };
    if (userApiKey) headers["X-User-Api-Key"] = userApiKey;
    const payload = { context: getContext(), count: targetSlots.length, mode, form };

    // Provider resolution: BYOK key → user's chosen provider.
    // No BYOK + trial exhausted → free model. Otherwise → shared Anthropic.
    if (isByok()) {
      if (userProvider) payload.provider = userProvider;
    } else if (isTrialExhausted()) {
      payload.provider = "free";
    }
    if (userModel) payload.model = userModel;

    const r = await fetch(WORKER_URL, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });
    if (!r.ok) {
      const detail = await r.text();
      throw new Error(`worker ${r.status}: ${detail.slice(0, 120)}`);
    }
    const data = await r.json();
    const items = (data.orbits || [])
      .filter((it) => it && it.fragment && it.expansion)
      .slice(0, targetSlots.length);

    // Track cost against trial budget (only for shared-key requests).
    if (!isByok() && data.usage) {
      addTrialCost(data.usage);
      updateTrialDisplay();
    }

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

    setStatus(typing ? "typing" : "idle", getOrbitCount());
  } catch (err) {
    console.error("[marginalia] regen failed", err);
    setStatus(err.message.slice(0, 80), getOrbitCount(), true);
  } finally {
    regenInflight = false;
    updateSummonState();
  }
}

// ── Summon button (user-triggered refresh) ───────────────────────

$summon.addEventListener("click", () => {
  if (regenInflight) return;
  if (getPinnedCount() >= getModeBudget()) {
    setStatus("at capacity", getOrbitCount());
    return;
  }
  if (getContext().trim().length < 50) {
    setStatus("nothing to whisper to", getOrbitCount());
    return;
  }
  cancelRegen();
  regenerate();
});

// ── Mode toggle (drafting ↔ reading) ─────────────────────────────

if ($modeToggle) {
  $modeToggle.addEventListener("click", () => {
    if (regenInflight) return;
    mode = mode === "drafting" ? "reading" : "drafting";
    localStorage.setItem("marginalia_mode", mode);
    renderModeLabel();
    updateSummonState();
    // Switching stance is a user-initiated action, so an immediate refresh
    // is appropriate (matches the "user owns rate of arrival" rule —
    // toggling IS the user trigger). Only fire if there's text to read.
    if (getContext().trim().length >= 50 && getPinnedCount() < getModeBudget()) {
      regenerate();
    } else {
      // Still clear over-budget unpinned orbits so the visual matches mode.
      clearUnpinnedSlots();
      setStatus(typing ? "typing" : "idle", getOrbitCount());
    }
  });
}

// ── Form picker (optional vocabulary-of-attention hint) ──────────

if ($formToggle && $formMenu) {
  $formToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if ($formMenu.hidden) openFormMenu();
    else closeFormMenu();
  });

  $formMenu.addEventListener("click", (e) => {
    const li = e.target.closest("li[data-form]");
    if (!li) return;
    e.stopPropagation();
    const next = li.dataset.form;
    // Click the currently-selected option to unselect (back to no hint).
    const newForm = (next === form) ? "" : next;
    closeFormMenu();
    if (newForm === form) return; // no-op (e.g. clicking "—" while already none)

    form = newForm;
    if (form) localStorage.setItem("marginalia_form", form);
    else localStorage.removeItem("marginalia_form");
    renderFormLabel();

    // Form change is a user-initiated action — re-summon to apply, same
    // pacing rule as mode toggle.
    if (regenInflight) return;
    if (getContext().trim().length >= 50 && getPinnedCount() < getModeBudget()) {
      regenerate();
    }
  });

  document.addEventListener("click", (e) => {
    if (!$formPicker.contains(e.target)) closeFormMenu();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (!$formMenu.hidden) closeFormMenu();
      if ($settingsPanel && !$settingsPanel.hidden) closeSettings();
      if ($about && !$about.hidden) $about.hidden = true;
    }
  });
}

// ── Settings panel (BYOK) ───────────────────────────────────────

function initSettings() {
  if ($settingsProvider) $settingsProvider.value = userProvider || "anthropic";
  if ($settingsModel) $settingsModel.value = userModel;
  if ($settingsApiKey) $settingsApiKey.value = userApiKey;
}

function closeSettings() {
  if ($settingsPanel) $settingsPanel.hidden = true;
  if ($settingsToggle) $settingsToggle.classList.remove("active");
}

function openSettings() {
  if ($settingsPanel) $settingsPanel.hidden = false;
  if ($settingsToggle) $settingsToggle.classList.add("active");
}

if ($settingsToggle) {
  $settingsToggle.addEventListener("click", (e) => {
    e.stopPropagation();
    if ($settingsPanel.hidden) openSettings();
    else closeSettings();
  });
}

if ($settingsProvider) {
  $settingsProvider.addEventListener("change", () => {
    userProvider = $settingsProvider.value;
    if (userProvider && userProvider !== "anthropic") {
      localStorage.setItem("marginalia_provider", userProvider);
    } else {
      userProvider = "";
      localStorage.removeItem("marginalia_provider");
    }
  });
}

if ($settingsModel) {
  $settingsModel.addEventListener("input", () => {
    userModel = $settingsModel.value.trim();
    if (userModel) localStorage.setItem("marginalia_model", userModel);
    else localStorage.removeItem("marginalia_model");
  });
}

if ($settingsApiKey) {
  $settingsApiKey.addEventListener("input", () => {
    userApiKey = $settingsApiKey.value.trim();
    if (userApiKey) localStorage.setItem("marginalia_apikey", userApiKey);
    else localStorage.removeItem("marginalia_apikey");
    updateTrialDisplay();
  });
}

document.addEventListener("click", (e) => {
  if ($settingsPanel && !$settingsPanel.hidden &&
      !$settingsPanel.contains(e.target) &&
      e.target !== $settingsToggle) {
    closeSettings();
  }
});

initSettings();

// ── Keyboard shortcuts ──────────────────────────────────────────
//   Cmd+.         → silence (clear all, suppress auto-summon 5 min)
//   Cmd+Shift+S   → summon

const SILENCE_DURATION_MS = 5 * 60 * 1000;

document.addEventListener("keydown", (e) => {
  const meta = e.metaKey || e.ctrlKey;

  if (meta && e.key === ".") {
    e.preventDefault();
    clearAllSlots();
    silencedUntil = Date.now() + SILENCE_DURATION_MS;
    cancelRegen();
    setStatus("silenced", 0);
    return;
  }

  if (meta && e.shiftKey && (e.key === "S" || e.key === "s")) {
    e.preventDefault();
    silencedUntil = 0;
    $summon.click();
    return;
  }
});

// ── Resize: re-pin slots so orbits don't drift off-margin ────────

window.addEventListener("resize", () => {
  for (let i = 0; i < NUM_SLOTS; i++) {
    if (slots[i]) placeOrbitInSlot(slots[i], i);
  }
});

renderModeLabel();
renderFormLabel();
updateTrialDisplay();
setStatus("ready", 0);

// ── File load / save ────────────────────────────────────────────

let currentFileName = "marginalia.md";

if ($fileLoad && $fileInput) {
  $fileLoad.addEventListener("click", () => $fileInput.click());
  $fileInput.addEventListener("change", () => {
    const file = $fileInput.files[0];
    if (!file) return;
    currentFileName = file.name;
    const reader = new FileReader();
    reader.onload = (e) => {
      $canvas.innerText = e.target.result;
      setStatus("loaded", 0);
    };
    reader.readAsText(file);
    $fileInput.value = "";
  });
}

if ($fileSave) {
  $fileSave.addEventListener("click", () => {
    const text = $canvas.innerText || "";
    if (!text.trim()) return;
    const blob = new Blob([text], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = currentFileName;
    a.click();
    URL.revokeObjectURL(url);
  });
}

// ── About overlay ───────────────────────────────────────────────

const $about = document.getElementById("about");
const $aboutLink = document.getElementById("about-link");
const $aboutClose = document.getElementById("about-close");

if ($aboutLink) {
  $aboutLink.addEventListener("click", (e) => {
    e.preventDefault();
    if ($about) $about.hidden = false;
  });
}

if ($aboutClose) {
  $aboutClose.addEventListener("click", () => {
    if ($about) $about.hidden = true;
  });
}

if ($about) {
  $about.addEventListener("click", (e) => {
    if (e.target === $about) $about.hidden = true;
  });
}

// ── Landing overlay (first visit only) ──────────────────────────

const $landing = document.getElementById("landing");
const $landingEnter = document.getElementById("landing-enter");
const $landingReadmore = document.getElementById("landing-readmore");
const $landingDeep = document.getElementById("landing-deep");
const $landingDeepBack = document.getElementById("landing-deep-back");
const $landingDeepEnter = document.getElementById("landing-deep-enter");
const $landingCard = document.getElementById("landing-card");

function dismissLanding() {
  if ($landing) $landing.hidden = true;
  localStorage.setItem("marginalia_welcomed", "1");
  $canvas.focus();
}

if ($landing && !localStorage.getItem("marginalia_welcomed")) {
  $landing.hidden = false;

  if ($landingEnter) $landingEnter.addEventListener("click", dismissLanding);
  if ($landingDeepEnter) $landingDeepEnter.addEventListener("click", dismissLanding);

  if ($landingReadmore) {
    $landingReadmore.addEventListener("click", (e) => {
      e.preventDefault();
      if ($landingCard) $landingCard.hidden = true;
      if ($landingDeep) $landingDeep.hidden = false;
    });
  }

  if ($landingDeepBack) {
    $landingDeepBack.addEventListener("click", () => {
      if ($landingDeep) $landingDeep.hidden = true;
      if ($landingCard) $landingCard.hidden = false;
    });
  }
}
