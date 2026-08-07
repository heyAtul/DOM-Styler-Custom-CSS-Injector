/*
 * background/service-worker.js — picker injection and the capture handoff.
 *
 * Classic worker (not type: module), because it loads the shared storage module via
 * importScripts. Paths are absolute from the extension root.
 *
 * MV3 kills this worker after ~30s idle, so it holds NO durable state in module scope: every
 * listener is registered synchronously at top level, and anything that must survive lives in
 * chrome.storage.
 */
importScripts('/lib/storage.js');

const Storage = globalThis.DomStylerStorage;

const CONTENT_SCRIPTS = [
  'lib/storage.js',
  'lib/css.js',
  'content/selector-engine.js',
  'content/applier.js',
];

/* ---------------------------------------------------------------- badge */

async function setBadge(text) {
  try {
    await chrome.action.setBadgeText({ text: text || '' });
    if (text) await chrome.action.setBadgeBackgroundColor({ color: '#2f6feb' });
  } catch (e) { /* badge is cosmetic */ }
}

/* ---------------------------------------------------------------- injection */

/** True if the applier is already live in this tab. */
async function applierPresent(tabId) {
  try {
    const res = await chrome.tabs.sendMessage(tabId, { type: 'DS_PING' });
    return !!(res && res.applier);
  } catch (e) {
    return false;
  }
}

/*
 * The manifest content scripts only run on navigations that happen AFTER install/reload, so any
 * tab that was already open has no applier. Inject them on demand rather than making the user
 * reload every tab.
 */
async function ensureContentScripts(tabId) {
  if (await applierPresent(tabId)) return true;
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPTS,
  });
  return applierPresent(tabId);
}

async function startPicker(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (!tab || !tab.url) return { ok: false, error: 'No page in that tab' };
  if (Storage.isRestrictedUrl(tab.url)) {
    return { ok: false, error: 'This page is off-limits to extensions (' + shortScheme(tab.url) + ')' };
  }

  try {
    await ensureContentScripts(tabId);
  } catch (e) {
    return { ok: false, error: 'Could not run on this page: ' + e.message };
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['content/picker.css'] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content/picker.js'] });
  } catch (e) {
    return { ok: false, error: 'Could not start the picker: ' + e.message };
  }

  await Storage.clearPendingCapture();
  await setBadge('');
  return { ok: true };
}

function shortScheme(url) {
  try {
    return new URL(url).protocol.replace(':', '');
  } catch (e) {
    return 'unknown';
  }
}

/* ---------------------------------------------------------------- broadcast */

/** Tell every tab whose url could be affected to re-read and re-apply. */
async function broadcastRulesChanged(scopeKey) {
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return;
  }
  for (const tab of tabs) {
    if (!tab.id || !tab.url || Storage.isRestrictedUrl(tab.url)) continue;
    if (scopeKey && !Storage.candidateScopeKeys(tab.url).includes(scopeKey)) continue;
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'DS_RULES_CHANGED' });
    } catch (e) {
      // No applier in that tab (never navigated since install). Nothing to update.
    }
  }
}

/* ---------------------------------------------------------------- messages
 *
 * Note the shape of every handler: an async function is NOT passed to addListener directly,
 * because it would return a Promise where Chrome expects the literal `true` and the response
 * would never be delivered. Instead each branch kicks off a promise and returns true.
 */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return undefined;

  switch (msg.type) {
    case 'DS_START_PICKER': {
      (async () => {
        try {
          const tabId = msg.tabId || (sender.tab && sender.tab.id);
          if (!tabId) return sendResponse({ ok: false, error: 'No target tab' });
          sendResponse(await startPicker(tabId));
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    case 'DS_PICKED': {
      (async () => {
        try {
          const payload = msg.payload || {};
          // The popup is almost certainly closed — clicking the page dismissed it — so the
          // capture is parked in storage and collected when the popup next opens.
          await Storage.setPendingCapture({
            ...payload,
            tabId: sender.tab ? sender.tab.id : null,
            at: Date.now(),
          });
          await setBadge('1');
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    case 'DS_PICKER_CANCELLED': {
      (async () => {
        await Storage.clearPendingCapture();
        await setBadge('');
        sendResponse({ ok: true });
      })();
      return true;
    }

    case 'DS_RULES_SAVED': {
      (async () => {
        await setBadge('');
        await broadcastRulesChanged(msg.scopeKey || null);
        sendResponse({ ok: true });
      })();
      return true;
    }

    /*
     * DevTools pages cannot call chrome.tabs.*, so the sidebar routes anything tab-directed
     * through here.
     */
    case 'DS_DEVTOOLS_CAPTURE': {
      (async () => {
        try {
          const tabId = msg.tabId;
          if (!tabId) return sendResponse({ ok: false, error: 'no inspected tab' });
          const tab = await chrome.tabs.get(tabId);
          if (!tab || !tab.url || Storage.isRestrictedUrl(tab.url)) {
            return sendResponse({ ok: false, error: 'this page is off-limits to extensions' });
          }
          await ensureContentScripts(tabId);
          const res = await chrome.tabs.sendMessage(tabId, {
            type: 'DS_CAPTURE_MARKED',
            attr: msg.attr,
          });
          sendResponse(res || { ok: false, error: 'no response from the page' });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    case 'DS_OPEN_OPTIONS': {
      (async () => {
        try {
          await chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    case 'DS_RELAY_TO_TAB': {
      (async () => {
        try {
          if (!msg.tabId || !msg.message) return sendResponse({ ok: false, error: 'bad relay' });
          const res = await chrome.tabs.sendMessage(msg.tabId, msg.message);
          sendResponse(res || { ok: true });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    case 'DS_ENSURE_SCRIPTS': {
      (async () => {
        try {
          const tabId = msg.tabId;
          if (!tabId) return sendResponse({ ok: false, error: 'No target tab' });
          const tab = await chrome.tabs.get(tabId);
          if (!tab || !tab.url || Storage.isRestrictedUrl(tab.url)) {
            return sendResponse({ ok: false, error: 'restricted' });
          }
          sendResponse({ ok: await ensureContentScripts(tabId) });
        } catch (e) {
          sendResponse({ ok: false, error: e.message });
        }
      })();
      return true;
    }

    default:
      return undefined;
  }
});

/* ---------------------------------------------------------------- lifecycle */

chrome.runtime.onInstalled.addListener(() => {
  Storage.ensureDefaults().catch((e) => console.warn('[DOM Styler] init failed', e));
  setBadge('');
});

chrome.runtime.onStartup.addListener(() => {
  Storage.ensureDefaults().catch(() => {});
  setBadge('');
});

/* A stale capture badge outliving its usefulness is confusing; clear it when the tab navigates. */
chrome.tabs.onRemoved.addListener(async (tabId) => {
  try {
    const pending = await Storage.getPendingCapture();
    if (pending && pending.tabId === tabId) {
      await Storage.clearPendingCapture();
      await setBadge('');
    }
  } catch (e) { /* ignore */ }
});
