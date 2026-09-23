# 🌐 Frappe Smart Translator

A production-ready Chrome Extension (Manifest V3) that dynamically translates the UI of
Frappe-based applications (ERPNext, HRMS, etc.) into multiple languages — without breaking layouts or data fields.

---

## 📁 Folder Structure

```
frappe-smart-translator/
├── manifest.json          # MV3 extension manifest
├── content.js             # Main translation engine (DOM scanner + cache + observer)
├── background.js          # MV3 service worker (storage relay, keepalive)
├── popup.html             # Extension popup UI
├── popup.js               # Popup interactions and messaging
├── styles.css             # Popup styles + injected indicator styles
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── README.md
```

---

## 🚀 Installation (Developer Mode)

1. Open Chrome and navigate to `chrome://extensions/`
2. Enable **Developer mode** (top-right toggle)
3. Click **"Load unpacked"**
4. Select the `frappe-smart-translator/` folder
5. The extension is now active — pin it for easy access

---

## 🎯 How to Use

1. Navigate to any ERPNext / Frappe page
2. Click the extension icon to open the popup
3. Enable the toggle → **"Enable Translator"**
4. Select your target language from the grid
5. Click **"Translate Page"** or wait for auto-translation

The extension will auto-detect new UI elements loaded dynamically by Frappe's frontend.

---

## 🌍 Supported Languages

| Language | Code | Script |
|----------|------|--------|
| Urdu     | `ur` | RTL    |
| Arabic   | `ar` | RTL    |
| Hindi    | `hi` | LTR    |
| Spanish  | `es` | LTR    |
| French   | `fr` | LTR    |
| German   | `de` | LTR    |
| Chinese  | `zh` | LTR    |
| Turkish  | `tr` | LTR    |

---

## ⚙️ Architecture

### Translation API (Modular)
- **Default**: [MyMemory API](https://mymemory.translated.net/) — free, no key required
- **Fallback**: Returns original text on failure (UI never breaks)
- **Extensible**: Swap to Google Translate, DeepL, or LibreTranslate by editing `TranslationAPI` in `content.js`

### Caching
- Two-layer cache: in-memory `Map` + `chrome.storage.local`
- Structure: `{ "en_text": { "ur": "...", "ar": "...", "hi": "..." } }`
- Persists across sessions; "Clear Cache" button resets it

### DOM Safety Rules
- Only modifies text nodes inside: `span, label, button, a, li, td, th, h1-h6, p, small, strong, em, b, i`
- Skips: `input, textarea, select, code, pre, script, style, svg`
- Skips: editable elements (`contenteditable`), numbers, URLs, IDs/codes
- Skips strings longer than 50 characters (avoids paragraphs)

### Dynamic Content (Frappe)
- `MutationObserver` watches `document.body` for new DOM nodes
- Throttled (200ms) + debounced (400ms) to avoid thrashing
- Only re-translates newly added subtrees, not the entire page

---

## 🔧 Configuration

Edit the `CONFIG` object in `content.js` to tune behaviour:

```js
const CONFIG = {
  MAX_TEXT_LENGTH: 50,      // Max characters to translate
  MIN_TEXT_LENGTH: 2,       // Min characters (skip single letters)
  DEBOUNCE_MS: 400,         // MutationObserver debounce
  OBSERVER_THROTTLE_MS: 200,
  BATCH_SIZE: 20,           // API requests per batch
  DEFAULT_LANG: "ur",       // Default language
};
```

---

## 🔌 Swapping the Translation API

To use Google Translate instead of MyMemory:

1. Uncomment the `_googleTranslateBatch` method in `content.js`
2. Add your API key to `chrome.storage` via the popup settings (add an input field in `popup.html`)
3. Update `translateBatch()` to call `_googleTranslateBatch` instead of `_myMemoryBatch`

---

## 🏗️ SaaS Roadmap

| Feature | Status |
|---------|--------|
| Multi-language cache | ✅ Done |
| MutationObserver dynamic UI | ✅ Done |
| Per-domain settings | 🔜 Planned |
| Custom glossary (override translations) | 🔜 Planned |
| Team shared cache (Supabase/Firestore) | 🔜 Planned |
| Premium API key management | 🔜 Planned |
| Analytics dashboard | 🔜 Planned |

---

## 🛡️ Safety Guarantees

- **Never modifies** input fields, textareas, or editable content
- **Never breaks** DOM structure (only `nodeValue` of text nodes is changed)
- **Full restore** — disabling the toggle reverts all translations instantly
- **No data sent** to translation API except UI label text (no user data, no form values)

---

## 📄 License

MIT — free to use, modify, and build your SaaS product on top of.
