/**
 * Frappe Smart Translator — popup.js
 * Handles all popup UI interactions, state sync, and messaging.
 */

// ─────────────────────────────────────────────────────────────────────────────
// LANGUAGE REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

const LANGUAGES = [
  { code: "ur", label: "اردو",    name: "Urdu",    flag: "🇵🇰", dir: "rtl" },
  { code: "ar", label: "العربية", name: "Arabic",   flag: "🇸🇦", dir: "rtl" },
  { code: "hi", label: "हिन्दी",  name: "Hindi",   flag: "🇮🇳", dir: "ltr" },
  { code: "es", label: "Español", name: "Spanish",  flag: "🇪🇸", dir: "ltr" },
  { code: "fr", label: "Français",name: "French",   flag: "🇫🇷", dir: "ltr" },
  { code: "de", label: "Deutsch", name: "German",   flag: "🇩🇪", dir: "ltr" },
  { code: "zh", label: "中文",    name: "Chinese",  flag: "🇨🇳", dir: "ltr" },
  { code: "tr", label: "Türkçe", name: "Turkish",  flag: "🇹🇷", dir: "ltr" },
];

// ─────────────────────────────────────────────────────────────────────────────
// DOM REFS
// ─────────────────────────────────────────────────────────────────────────────

const $ = (id) => document.getElementById(id);

const el = {
  toggle:       $("enableToggle"),
  langGrid:     $("langGrid"),
  translateBtn: $("translateBtn"),
  clearBtn:     $("clearCacheBtn"),
  statusBar:    $("statusBar"),
  statusDot:    $("statusDot"),
  statusText:   $("statusText"),
  toast:        $("toast"),
};

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

const popupState = {
  enabled: false,
  language: "ur",
  toastTimer: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGING HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function sendToContent(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "FST_RELAY_TO_TAB", payload },
      (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, reason: chrome.runtime.lastError.message });
        } else {
          resolve(response || { ok: false });
        }
      }
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE HELPERS
// ─────────────────────────────────────────────────────────────────────────────

async function loadSettings() {
  return new Promise((resolve) => {
    chrome.storage.local.get(["fst_enabled", "fst_language", "fst_cache"], resolve);
  });
}

async function saveSettings(data) {
  return new Promise((resolve) => chrome.storage.local.set(data, resolve));
}

// ─────────────────────────────────────────────────────────────────────────────
// UI BUILDERS
// ─────────────────────────────────────────────────────────────────────────────

function buildLanguageGrid(selectedCode) {
  el.langGrid.innerHTML = "";

  for (const lang of LANGUAGES) {
    const btn = document.createElement("button");
    btn.className = "lang-chip" + (lang.code === selectedCode ? " selected" : "");
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", String(lang.code === selectedCode));
    btn.setAttribute("data-lang", lang.code);
    btn.title = lang.name;
    btn.innerHTML = `
      <span class="lang-flag">${lang.flag}</span>
      <span class="lang-native">${lang.label}</span>
      <span class="lang-name">${lang.name}</span>
    `;
    btn.addEventListener("click", () => onLanguageSelect(lang.code));
    el.langGrid.appendChild(btn);
  }
}

function setStatus(active, text) {
  el.statusDot.className = "status-dot" + (active ? " active" : "");
  el.statusText.textContent = text;
  el.statusBar.className = "status-bar" + (active ? " active" : "");
}

function setToggleUI(enabled) {
  el.toggle.checked = enabled;
  el.translateBtn.disabled = !enabled;
  if (enabled) {
    el.translateBtn.classList.remove("disabled");
    setStatus(true, "Translator active");
  } else {
    el.translateBtn.classList.add("disabled");
    setStatus(false, "Translator inactive");
  }
}

function showToast(message, type = "info") {
  el.toast.textContent = message;
  el.toast.className = `toast show ${type}`;
  clearTimeout(popupState.toastTimer);
  popupState.toastTimer = setTimeout(() => {
    el.toast.className = "toast";
  }, 3000);
}

function setTranslating(loading) {
  if (loading) {
    el.translateBtn.classList.add("loading");
    el.translateBtn.querySelector("span:last-child").textContent = "Translating…";
    el.translateBtn.disabled = true;
  } else {
    el.translateBtn.classList.remove("loading");
    el.translateBtn.querySelector("span:last-child").textContent = "Translate Page";
    el.translateBtn.disabled = !popupState.enabled;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// EVENT HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

async function onToggleChange() {
  const enabled = el.toggle.checked;
  popupState.enabled = enabled;

  await saveSettings({ fst_enabled: enabled });
  setToggleUI(enabled);

  const response = await sendToContent({ type: "FST_TOGGLE", enabled });
  if (!response.ok && response.reason !== "disabled") {
    showToast("⚠️ Could not reach page. Reload and try again.", "warning");
  } else {
    showToast(enabled ? "✅ Translator enabled" : "⏸ Translator paused", "success");
  }
}

async function onLanguageSelect(code) {
  if (code === popupState.language) return;

  popupState.language = code;
  await saveSettings({ fst_language: code });

  // Update UI
  buildLanguageGrid(code);
  showToast(`🌐 Language set to ${LANGUAGES.find((l) => l.code === code)?.name}`, "info");

  if (popupState.enabled) {
    const response = await sendToContent({ type: "FST_SET_LANGUAGE", lang: code });
    if (!response?.ok) {
      showToast("⚠️ Could not update page language.", "warning");
    }
  }
}

async function onTranslatePage() {
  if (!popupState.enabled) return;
  setTranslating(true);

  const response = await sendToContent({ type: "FST_TRANSLATE_PAGE" });

  setTranslating(false);
  if (response?.ok) {
    showToast("✨ Page translated!", "success");
  } else {
    showToast("⚠️ Translation failed. Check API or reload.", "error");
  }
}

async function onClearCache() {
  await saveSettings({ fst_cache: {} });
  showToast("🗑️ Cache cleared.", "info");
}

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  const settings = await loadSettings();

  popupState.enabled = settings.fst_enabled ?? false;
  popupState.language = settings.fst_language ?? "ur";

  const cacheCount = Object.keys(settings.fst_cache || {}).length;

  // Build UI
  setToggleUI(popupState.enabled);
  buildLanguageGrid(popupState.language);

  if (cacheCount > 0) {
    el.clearBtn.title = `Clear cache (${cacheCount} entries)`;
  }

  // Sync with live content script state
  const liveState = await sendToContent({ type: "FST_GET_STATE" });
  if (liveState?.ok !== false) {
    // Content script responded — trust its state as ground truth
    if (typeof liveState?.enabled === "boolean") {
      popupState.enabled = liveState.enabled;
      setToggleUI(liveState.enabled);
      el.toggle.checked = liveState.enabled;
    }
    setStatus(true, "Page detected ✓");
  } else {
    setStatus(false, "No compatible page found");
    showToast("Navigate to a Frappe/ERPNext page first.", "warning");
  }

  // Bind events
  el.toggle.addEventListener("change", onToggleChange);
  el.translateBtn.addEventListener("click", onTranslatePage);
  el.clearBtn.addEventListener("click", onClearCache);
}

document.addEventListener("DOMContentLoaded", init);
