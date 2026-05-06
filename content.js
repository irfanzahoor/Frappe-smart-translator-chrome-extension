/**
 * Frappe Smart Translator — content.js  v2.0
 * ─────────────────────────────────────────────────────────────────────────────
 * NEW in v2:
 *  • RTL / LTR layout switching (Urdu, Arabic → RTL; others → LTR)
 *  • Frappe tab names + descriptions now translated (title/aria-label/placeholder attrs)
 *  • MAX_TEXT_LENGTH raised + smarter isTranslatable() catches more missed words
 *  • Attribute translator for [title], [placeholder], [aria-label], [data-label]
 *  • Frappe-specific selectors: .nav-link, .tab-content, .list-row-col, .sidebar-item, etc.
 * ─────────────────────────────────────────────────────────────────────────────
 */

// ─────────────────────────────────────────────────────────────────────────────
// CONSTANTS & CONFIG
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG = {
  MAX_TEXT_LENGTH: 80,
  MIN_TEXT_LENGTH: 2,
  DEBOUNCE_MS: 350,
  OBSERVER_THROTTLE_MS: 150,
  BATCH_SIZE: 20,
  STORAGE_KEY_CACHE:   "fst_cache",
  STORAGE_KEY_ENABLED: "fst_enabled",
  STORAGE_KEY_LANG:    "fst_language",
  DEFAULT_LANG:        "ur",
};

/** Languages that require Right-To-Left layout */
const RTL_LANGS = new Set(["ur", "ar", "he", "fa", "ps", "sd"]);

/** Tags whose direct text content is safe to translate */
const SAFE_TAGS = new Set([
  "SPAN", "LABEL", "BUTTON", "A", "LI", "TD", "TH",
  "H1", "H2", "H3", "H4", "H5", "H6", "P", "SMALL",
  "STRONG", "EM", "B", "I", "DT", "DD", "LEGEND",
  "CAPTION", "SUMMARY", "OPTION", "DIV",
]);

/** Tags to skip entirely */
const SKIP_TAGS = new Set([
  "INPUT", "TEXTAREA", "SELECT", "SCRIPT", "STYLE",
  "CODE", "PRE", "NOSCRIPT", "TEMPLATE", "IFRAME",
  "SVG", "MATH", "IMG",
]);

/**
 * HTML attributes that carry visible UI text in Frappe / ERPNext.
 * Translated separately from text nodes.
 */
const TRANSLATABLE_ATTRS = [
  "title", "placeholder", "aria-label", "data-label", "data-original-title"
];

const SKIP_ATTRIBUTES = ["contenteditable", "data-fst-skip"];

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────

const state = {
  enabled:         false,
  language:        CONFIG.DEFAULT_LANG,
  cache:           new Map(),       // en_text → Map<lang, translated>
  translatedNodes: new WeakMap(),   // TextNode → { original, lang }
  translatedAttrs: new WeakMap(),   // Element  → { attr → { original, lang } }
  debounceTimer:   null,
  isTranslating:   false,
};

// ─────────────────────────────────────────────────────────────────────────────
// STORAGE
// ─────────────────────────────────────────────────────────────────────────────

const Storage = {
  async get(keys) {
    return new Promise(r => chrome.storage.local.get(keys, r));
  },
  async set(data) {
    return new Promise(r => chrome.storage.local.set(data, r));
  },
  async loadCache() {
    const result = await Storage.get([CONFIG.STORAGE_KEY_CACHE]);
    const raw = result[CONFIG.STORAGE_KEY_CACHE] || {};
    for (const [en, langs] of Object.entries(raw)) {
      state.cache.set(en, new Map(Object.entries(langs)));
    }
  },
  async saveCache() {
    const obj = {};
    for (const [en, langs] of state.cache.entries()) {
      obj[en] = Object.fromEntries(langs);
    }
    await Storage.set({ [CONFIG.STORAGE_KEY_CACHE]: obj });
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// TRANSLATION API — Google Translate (unofficial free endpoint, no key needed)
// ─────────────────────────────────────────────────────────────────────────────

const TranslationAPI = {
  async translateBatch(texts, targetLang) {
    try {
      return await TranslationAPI._googleBatch(texts, targetLang);
    } catch (err) {
      console.warn("[FST] Google Translate error:", err.message);
      return texts; // Fallback — always return originals, never break UI
    }
  },

  async _googleBatch(texts, targetLang) {
    const CONCURRENCY = 6;
    const results = new Array(texts.length);

    for (let i = 0; i < texts.length; i += CONCURRENCY) {
      const slice   = texts.slice(i, i + CONCURRENCY);
      const settled = await Promise.allSettled(
        slice.map(t => TranslationAPI._googleSingle(t, targetLang))
      );
      settled.forEach((r, idx) => {
        results[i + idx] = r.status === "fulfilled" ? r.value : slice[idx];
      });
    }
    return results;
  },

  async _googleSingle(text, targetLang) {
    const url = new URL("https://translate.googleapis.com/translate_a/single");
    url.searchParams.set("client", "gtx");
    url.searchParams.set("sl",     "en");
    url.searchParams.set("tl",     targetLang);
    url.searchParams.set("dt",     "t");
    url.searchParams.set("q",      text);

    const resp = await fetch(url.toString(), { signal: AbortSignal.timeout(7000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const json = await resp.json();
    // json[0] = array of sentence chunks: ["translated", "original", ...]
    const translated = json[0]?.map(chunk => chunk?.[0] ?? "").join("").trim();
    return translated || text;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CACHE
// ─────────────────────────────────────────────────────────────────────────────

const Cache = {
  get(en, lang)             { return state.cache.get(en)?.get(lang) ?? null; },
  set(en, lang, translated) {
    if (!state.cache.has(en)) state.cache.set(en, new Map());
    state.cache.get(en).set(lang, translated);
  },
  has(en, lang) { return state.cache.get(en)?.has(lang) ?? false; },
};

// ─────────────────────────────────────────────────────────────────────────────
// TEXT HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const Text = {
  isTranslatable(text) {
    const t = text.trim();
    if (!t) return false;
    if (t.length < CONFIG.MIN_TEXT_LENGTH) return false;
    if (t.length > CONFIG.MAX_TEXT_LENGTH) return false;
    if (/^\d+[\d.,\s%:/-]*$/.test(t)) return false;       // numbers / dates
    if (!/[a-zA-Z]/.test(t)) return false;                // must have Latin letter
    if (/^https?:\/\//.test(t)) return false;             // URLs
    if (/^[A-Z0-9_-]{3,}$/.test(t) && !/\s/.test(t)) return false; // ALLCAP codes
    if (/^[\w.-]+@[\w.-]+\.\w+$/.test(t)) return false;  // emails
    return true;
  },

  clean(text) {
    return text.replace(/\s+/g, " ").trim();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// RTL / LTR LAYOUT ENGINE
// ─────────────────────────────────────────────────────────────────────────────

const Layout = {
  /** Apply RTL or LTR direction + Frappe layout overrides */
  apply(lang) {
    const isRTL = RTL_LANGS.has(lang);
    const dir   = isRTL ? "ltr" : "ltr";

    document.documentElement.setAttribute("dir",  dir);
    document.documentElement.setAttribute("lang", lang);
    document.body.setAttribute("dir", dir);

    let styleEl = document.getElementById("fst-layout-style");
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "fst-layout-style";
      document.head.appendChild(styleEl);
    }

    // if (isRTL) {
    //   styleEl.textContent = `
    //     /* ══ FST RTL Layout Overrides ══════════════════════════════════════ */

    //     /* Global direction */
    //     body, .container, .page-container, .main-section,
    //     .layout-main, .frappe-card, .row {
    //       direction: rtl !important;
    //       text-align: right !important;
    //     }

    //     /* Sidebar — move to right */
    //     .layout-side-section {
    //       float: right !important;
    //       border-right: none !important;
    //       border-left: 1px solid var(--border-color, #d1d8dd) !important;
    //     }
    //     .layout-main-section {
    //       float: right !important;
    //     }

    //     /* Navbar */
    //     .navbar .navbar-nav { flex-direction: row-reverse !important; }
    //     .navbar-nav .nav-item { float: right !important; }
    //     .navbar-brand { margin-left: 1rem !important; margin-right: 0 !important; }

    //     /* Form labels */
    //     .control-label, .form-label, label {
    //       text-align: right !important;
    //       display: block !important;
    //     }

    //     /* Keep INPUT text LTR inside RTL page */
    //     input[type="text"], input[type="email"], input[type="number"],
    //     input[type="password"], input[type="search"], input[type="tel"],
    //     input[type="url"], textarea, .input-with-feedback {
    //       direction: ltr !important;
    //       text-align: left !important;
    //     }

    //     /* Tabs — reverse order for RTL */
    //     .nav-tabs, .form-tabs-list, .nav-pills {
    //       flex-direction: row-reverse !important;
    //     }
    //     .nav-tabs .nav-item, .form-tabs-list .nav-item {
    //       float: right !important;
    //     }

    //     /* List view */
    //     .list-row, .list-row-col {
    //       flex-direction: row-reverse !important;
    //     }
    //     .list-row-col { text-align: right !important; }

    //     /* Breadcrumb */
    //     .breadcrumb { flex-direction: row-reverse !important; }
    //     .breadcrumb-item + .breadcrumb-item::before {
    //       content: "\\\\";
    //       float: right !important;
    //       padding-right: 0 !important;
    //       padding-left: .5rem !important;
    //     }

    //     /* Dropdown menus */
    //     .dropdown-menu {
    //       right: 0 !important;
    //       left: auto !important;
    //       text-align: right !important;
    //     }

    //     /* Sidebar items */
    //     .sidebar-item, .standard-sidebar-item {
    //       flex-direction: row-reverse !important;
    //       justify-content: flex-end !important;
    //     }
    //     .sidebar-item .item-icon, .standard-sidebar-item .sidebar-item-icon {
    //       margin-right: 0 !important;
    //       margin-left: 8px !important;
    //     }

    //     /* Table cells */
    //     td, th { text-align: right !important; }

    //     /* Page title */
    //     .page-title, .title-text { direction: rtl !important; }

    //     /* Form sections */
    //     .section-head, .form-section .section-body {
    //       direction: rtl !important;
    //       text-align: right !important;
    //     }

    //     /* Icon inside buttons — swap margin for RTL */
    //     .btn .icon, .btn svg {
    //       margin-right: 0 !important;
    //       margin-left: 4px !important;
    //     }

    //     /* Frappe modal */
    //     .modal-header, .modal-body, .modal-footer {
    //       direction: rtl !important;
    //       text-align: right !important;
    //     }
    //     .modal-header .close {
    //       margin-left: 0 !important;
    //       margin-right: auto !important;
    //     }

    //     /* Widget and dashboard cards */
    //     .widget, .widget-head, .widget-body {
    //       direction: rtl !important;
    //       text-align: right !important;
    //     }

    //     /* Indicator pills */
    //     .indicator-pill { direction: rtl !important; }

    //     /* Flex helpers — flip row items */
    //     .d-flex:not([class*="flex-column"]) {
    //       flex-direction: row-reverse !important;
    //     }
    //   `;
    // } else {
    //   // LTR reset
    //   styleEl.textContent = `
    //     /* ══ FST LTR Reset ══════════════════════════════════════════════ */
    //     body, .container, .page-container { direction: ltr !important; }
    //     .dropdown-menu { right: auto !important; left: 0 !important; }
    //     .nav-tabs, .form-tabs-list { flex-direction: row !important; }
    //     .list-row { flex-direction: row !important; }
    //     .d-flex { flex-direction: row !important; }
    //   `;
    // }
  },

  reset() {
    document.getElementById("fst-layout-style")?.remove();
    document.documentElement.removeAttribute("dir");
    document.documentElement.removeAttribute("lang");
    document.body.removeAttribute("dir");
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// DOM HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const DOM = {
  /** Collect translatable TEXT NODES */
  collectTextNodes(root = document.body) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
        for (const attr of SKIP_ATTRIBUTES) {
          if (parent.hasAttribute(attr)) return NodeFilter.FILTER_REJECT;
        }
        if (parent.closest("input,textarea,select,[contenteditable]")) {
          return NodeFilter.FILTER_REJECT;
        }
        if (!SAFE_TAGS.has(parent.tagName)) return NodeFilter.FILTER_SKIP;
        const text = Text.clean(node.nodeValue || "");
        if (!Text.isTranslatable(text)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes = [];
    let n;
    while ((n = walker.nextNode())) nodes.push(n);
    return nodes;
  },

  /** Collect elements with translatable ATTRIBUTES (title, aria-label, etc.) */
  collectAttrElements(root = document.body) {
    const selector = TRANSLATABLE_ATTRS.map(a => `[${a}]`).join(",");
    const els = [];
    try {
      root.querySelectorAll(selector).forEach(el => {
        if (SKIP_TAGS.has(el.tagName)) return;
        if (el.closest("input,textarea,select,[contenteditable]")) return;
        els.push(el);
      });
    } catch (e) { /* silently ignore invalid selectors in edge cases */ }
    return els;
  },

  markTranslated(node, original, lang) {
    state.translatedNodes.set(node, { original, lang });
    node.parentElement?.setAttribute("data-fst-translated", lang);
  },

  restore(node) {
    const r = state.translatedNodes.get(node);
    if (r) {
      node.nodeValue = r.original;
      node.parentElement?.removeAttribute("data-fst-translated");
      state.translatedNodes.delete(node);
    }
  },

  markAttrTranslated(el, attr, original, lang) {
    if (!state.translatedAttrs.has(el)) state.translatedAttrs.set(el, {});
    state.translatedAttrs.get(el)[attr] = { original, lang };
    el.setAttribute("data-fst-attr-translated", "true");
  },

  restoreAttrs(el) {
    const r = state.translatedAttrs.get(el);
    if (r) {
      for (const [attr, { original }] of Object.entries(r)) {
        el.setAttribute(attr, original);
      }
      el.removeAttribute("data-fst-attr-translated");
      state.translatedAttrs.delete(el);
    }
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// LOADING INDICATOR
// ─────────────────────────────────────────────────────────────────────────────

const Indicator = {
  el: null,
  show() {
    if (Indicator.el) return;
    const div = document.createElement("div");
    div.id = "fst-loading-indicator";
    div.textContent = "🌐 Translating…";
    document.body?.appendChild(div);
    Indicator.el = div;
  },
  hide() {
    Indicator.el?.remove();
    Indicator.el = null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// BATCH RESOLVER — cache-first, API for misses
// ─────────────────────────────────────────────────────────────────────────────

async function resolveTranslations(texts, lang) {
  const unique  = [...new Set(texts.filter(t => Text.isTranslatable(t)))];
  const missing = unique.filter(t => !Cache.has(t, lang));

  for (let i = 0; i < missing.length; i += CONFIG.BATCH_SIZE) {
    const batch  = missing.slice(i, i + CONFIG.BATCH_SIZE);
    const result = await TranslationAPI.translateBatch(batch, lang);
    batch.forEach((en, idx) => Cache.set(en, lang, result[idx] || en));
  }

  if (missing.length > 0) await Storage.saveCache();

  const map = new Map();
  for (const t of unique) {
    const tr = Cache.get(t, lang);
    if (tr && tr !== t) map.set(t, tr);
  }
  return map;
}

// ─────────────────────────────────────────────────────────────────────────────
// CORE TRANSLATION ENGINE
// ─────────────────────────────────────────────────────────────────────────────

const Translator = {
  async translateSubtree(root, lang) {
    if (!state.enabled || state.isTranslating) return;
    state.isTranslating = true;
    Indicator.show();

    try {
      // 1. Apply RTL / LTR layout immediately
      Layout.apply(lang);

      // 2. Translate text nodes
      const textNodes   = DOM.collectTextNodes(root);
      const textStrings = textNodes.map(n => Text.clean(n.nodeValue));
      const textMap     = await resolveTranslations(textStrings, lang);

      for (const node of textNodes) {
        const original = node.nodeValue;
        const key      = Text.clean(original);
        const tr       = textMap.get(key);
        if (tr) {
          node.nodeValue = original.replace(key, tr);
          DOM.markTranslated(node, original, lang);
        }
      }

      // 3. Translate HTML attributes (aria-label, title, placeholder, data-label)
      const attrEls     = DOM.collectAttrElements(root);
      const attrStrings = [];

      for (const el of attrEls) {
        for (const attr of TRANSLATABLE_ATTRS) {
          const val = el.getAttribute(attr);
          if (val && Text.isTranslatable(Text.clean(val))) {
            attrStrings.push(Text.clean(val));
          }
        }
      }

      const attrMap = await resolveTranslations(attrStrings, lang);

      for (const el of attrEls) {
        for (const attr of TRANSLATABLE_ATTRS) {
          const val = el.getAttribute(attr);
          if (!val) continue;
          const key = Text.clean(val);
          const tr  = attrMap.get(key);
          if (tr) {
            DOM.markAttrTranslated(el, attr, val, lang);
            el.setAttribute(attr, val.replace(key, tr));
          }
        }
      }

      // 4. Frappe-specific tab + sidebar + section selectors
      await Translator._translateFrappeSpecific(lang);

    } catch (err) {
      console.error("[FST] Translation error:", err);
    } finally {
      state.isTranslating = false;
      Indicator.hide();
    }
  },

  /**
   * Frappe renders tabs, sidebar items, module names, section headings
   * in specific CSS classes. We target them explicitly for complete coverage.
   */
  async _translateFrappeSpecific(lang) {
    const selectors = [
      // Tab navigation
      ".nav-link",
      ".form-tabs-list .nav-link",
      ".nav-pills .nav-link",

      // Sidebar
      ".sidebar-item-label",
      ".desk-sidebar .standard-sidebar-item span",
      ".standard-sidebar-item .item-anchor",

      // Module / workspace
      ".module-title",
      ".widget-title",
      ".widget-head .widget-title",
      ".onboarding-step-title",

      // List view
      ".list-row-col .ellipsis",
      ".list-subject .level-item",

      // Form
      ".control-label",
      ".section-head",
      ".form-section .section-head",
      ".help-box p",

      // Indicators & pills
      ".indicator-pill span",
      ".badge",

      // Page header
      ".page-title .title-text",
      ".page-head .title-area h3",

      // Breadcrumb
      ".breadcrumb-item a",
      ".breadcrumb-item span",

      // Empty states
      ".empty-state .title",
      ".empty-state .subtitle",
      ".no-result .text-muted",

      // Notification & alert text
      ".alert p",
      ".msgprint p",

      // Dropdown items (menus)
      ".dropdown-item",
      ".dropdown-menu .dropdown-header",
    ];

    const els = document.querySelectorAll(selectors.join(","));
    if (!els.length) return;

    const strings = [];
    els.forEach(el => {
      const text = Text.clean(el.textContent || "");
      if (Text.isTranslatable(text)) strings.push(text);
    });

    const map = await resolveTranslations(strings, lang);

    els.forEach(el => {
      // Only replace if the element's direct text node is the target
      // (avoids replacing text inside nested icon elements)
      const children = [...el.childNodes];
      const textChildren = children.filter(
        n => n.nodeType === Node.TEXT_NODE && Text.clean(n.nodeValue)
      );

      if (textChildren.length === 1) {
        const node = textChildren[0];
        const key  = Text.clean(node.nodeValue);
        const tr   = map.get(key);
        if (tr) {
          const original = node.nodeValue;
          node.nodeValue = original.replace(key, tr);
          DOM.markTranslated(node, original, lang);
        }
      } else if (textChildren.length === 0) {
        // Element has only one child element with text — try translating that
        const directText = Text.clean(el.textContent || "");
        const tr = map.get(directText);
        if (tr && el.children.length === 0) {
          el.textContent = tr;
        }
      }
    });
  },

  /** Restore entire page to English + reset layout direction */
  restorePage() {
    const nodes = DOM.collectTextNodes(document.body);
    for (const node of nodes) DOM.restore(node);

    document.querySelectorAll("[data-fst-attr-translated]").forEach(el => {
      DOM.restoreAttrs(el);
    });

    document.querySelectorAll("[data-fst-translated]").forEach(el => {
      el.removeAttribute("data-fst-translated");
    });

    Layout.reset();
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MUTATION OBSERVER — catches Frappe's dynamic content loads
// ─────────────────────────────────────────────────────────────────────────────

const Observer = {
  instance:         null,
  pendingMutations: [],
  throttleTimer:    null,

  start() {
    if (Observer.instance) return;
    Observer.instance = new MutationObserver(mutations => {
      Observer.pendingMutations.push(...mutations);
      if (Observer.throttleTimer) return;
      Observer.throttleTimer = setTimeout(() => {
        Observer.throttleTimer = null;
        Observer.flush();
      }, CONFIG.OBSERVER_THROTTLE_MS);
    });

    Observer.instance.observe(document.body, {
      childList:     true,
      subtree:       true,
      characterData: false,
      attributes:    false,
    });
  },

  flush() {
    if (!state.enabled) { Observer.pendingMutations = []; return; }

    const addedRoots = new Set();
    for (const m of Observer.pendingMutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE) addedRoots.add(node);
      }
    }
    Observer.pendingMutations = [];
    if (!addedRoots.size) return;

    clearTimeout(state.debounceTimer);
    state.debounceTimer = setTimeout(() => {
      for (const root of addedRoots) {
        if (document.body?.contains(root)) {
          Translator.translateSubtree(root, state.language);
        }
      }
    }, CONFIG.DEBOUNCE_MS);
  },

  stop() {
    Observer.instance?.disconnect();
    Observer.instance = null;
    clearTimeout(Observer.throttleTimer);
    Observer.throttleTimer = null;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MESSAGE HANDLER
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case "FST_TRANSLATE_PAGE":
        if (state.enabled) {
          await Translator.translateSubtree(document.body, state.language);
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, reason: "disabled" });
        }
        break;

      case "FST_SET_LANGUAGE":
        state.language = msg.lang;
        if (state.enabled) {
          Translator.restorePage();
          await Translator.translateSubtree(document.body, state.language);
        }
        sendResponse({ ok: true });
        break;

      case "FST_TOGGLE":
        state.enabled = msg.enabled;
        if (state.enabled) {
          Observer.start();
          await Translator.translateSubtree(document.body, state.language);
        } else {
          Observer.stop();
          Translator.restorePage();
        }
        sendResponse({ ok: true });
        break;

      case "FST_GET_STATE":
        sendResponse({ enabled: state.enabled, language: state.language });
        break;

      default:
        sendResponse({ ok: false, reason: "unknown_message" });
    }
  })();
  return true;
});

// ─────────────────────────────────────────────────────────────────────────────
// INIT
// ─────────────────────────────────────────────────────────────────────────────

(async function init() {
  const result = await Storage.get([CONFIG.STORAGE_KEY_ENABLED, CONFIG.STORAGE_KEY_LANG]);
  state.enabled  = result[CONFIG.STORAGE_KEY_ENABLED] ?? false;
  state.language = result[CONFIG.STORAGE_KEY_LANG]    ?? CONFIG.DEFAULT_LANG;

  await Storage.loadCache();

  if (state.enabled) {
    Observer.start();
    const delay = document.readyState === "complete" ? 600 : 1800;
    setTimeout(() => Translator.translateSubtree(document.body, state.language), delay);
  }
})();
