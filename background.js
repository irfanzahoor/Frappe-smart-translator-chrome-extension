/**
 * Frappe Smart Translator — background.js  v3.0
 * ─────────────────────────────────────────────────────────────────────────────
 * ALL Google Translate API calls go through here (service worker has no CORS
 * restrictions). Content script sends FST_TRANSLATE_TEXT messages here.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ── Defaults on install ──────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(({ reason }) => {
  if (reason === "install") {
    chrome.storage.local.set({
      fst_enabled:  false,
      fst_language: "ur",
      fst_cache:    {},
    });
    console.log("[FST] Installed — defaults set.");
  }
});

// ── Keep service worker alive ────────────────────────────────────────────────
chrome.alarms.create("fst_keepalive", { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(() => {});

// ── Central message handler ──────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // ── 1. Translate a batch of texts via Google Translate ────────────────────
  if (msg.type === "FST_TRANSLATE_BATCH") {
    translateBatch(msg.texts, msg.lang)
      .then(results => sendResponse({ ok: true, results }))
      .catch(err   => sendResponse({ ok: false, error: err.message, results: msg.texts }));
    return true; // async
  }

  // ── 2. Relay popup → content script ──────────────────────────────────────
  if (msg.type === "FST_RELAY_TO_TAB") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0];
      if (!tab?.id) { sendResponse({ ok: false, reason: "no_tab" }); return; }
      chrome.tabs.sendMessage(tab.id, msg.payload, (resp) => {
        if (chrome.runtime.lastError) {
          sendResponse({ ok: false, reason: chrome.runtime.lastError.message });
        } else {
          sendResponse(resp || { ok: true });
        }
      });
    });
    return true;
  }

  // ── 3. Storage helpers ────────────────────────────────────────────────────
  if (msg.type === "FST_STORAGE_GET") {
    chrome.storage.local.get(msg.keys, data => sendResponse({ ok: true, data }));
    return true;
  }
  if (msg.type === "FST_STORAGE_SET") {
    chrome.storage.local.set(msg.data, () => sendResponse({ ok: true }));
    return true;
  }
});

// ── Google Translate — runs in service worker (no CORS issues here) ──────────

async function translateBatch(texts, targetLang) {
  const CONCURRENCY = 5;
  const results = new Array(texts.length);

  for (let i = 0; i < texts.length; i += CONCURRENCY) {
    const slice   = texts.slice(i, i + CONCURRENCY);
    const settled = await Promise.allSettled(
      slice.map(t => translateOne(t, targetLang))
    );
    settled.forEach((r, idx) => {
      results[i + idx] = r.status === "fulfilled" ? r.value : slice[idx];
    });
  }
  return results;
}

async function translateOne(text, targetLang) {
  const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=${encodeURIComponent(targetLang)}&dt=t&q=${encodeURIComponent(text)}`;

  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

  const json = await resp.json();
  // json[0] = [ ["translated","original"], ... ]
  const translated = (json[0] || []).map(c => c?.[0] ?? "").join("").trim();
  return translated || text;
}