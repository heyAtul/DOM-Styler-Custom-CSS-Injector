/*
 * lib/storage.js — the single storage module, shared by all three extension contexts.
 *
 * Loaded as a CLASSIC script in each of them, which is why it assigns to globalThis
 * instead of exporting:
 *   - service worker : importScripts('/lib/storage.js')
 *   - popup          : <script src="../lib/storage.js">
 *   - content scripts: first entry in the manifest js array
 *
 * Read paths never throw. A corrupt or absent key yields a safe empty default, because a
 * storage hiccup must not stop the applier from running on the page. Validation happens on
 * the write path instead, where there is a user to report it to.
 */
(function () {
  'use strict';

  if (globalThis.DomStylerStorage) return;

  const SCHEMA_VERSION = 1;

  const K_SETTINGS = 'settings';
  const K_PENDING = 'pendingCapture';
  const RULES_PREFIX = 'rules:';

  const MATCH_MODES = ['host', 'domain', 'url'];

  const DEFAULT_SETTINGS = {
    schemaVersion: SCHEMA_VERSION,
    enabled: true,
    defaultMatchMode: 'host',
  };

  /*
   * Second-level suffixes where the registrable domain is the last THREE labels, not two.
   * A full Public Suffix List is ~200 KB and cannot be fetched (no remote code), so this
   * covers the common cases and 'domain' mode degrades to a slightly-too-broad scope
   * elsewhere. 'host' mode is the default precisely because it needs none of this.
   */
  const THREE_LABEL_SUFFIXES = new Set([
    'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk',
    'co.jp', 'or.jp', 'ne.jp', 'ac.jp', 'go.jp',
    'co.in', 'net.in', 'org.in', 'firm.in', 'gen.in', 'ind.in', 'ac.in', 'edu.in', 'gov.in',
    'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au',
    'co.nz', 'net.nz', 'org.nz', 'ac.nz', 'govt.nz',
    'com.br', 'net.br', 'org.br', 'gov.br',
    'co.za', 'org.za', 'net.za', 'gov.za',
    'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn',
    'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk', 'com.tw', 'com.my',
    'co.kr', 'or.kr', 'ne.kr',
    'co.il', 'org.il', 'net.il',
  ]);

  /* Pages where content scripts cannot run, or must not. */
  const BLOCKED_SCHEMES = ['chrome:', 'chrome-extension:', 'moz-extension:', 'edge:',
    'about:', 'data:', 'view-source:', 'devtools:', 'chrome-search:', 'chrome-untrusted:'];
  const BLOCKED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com', 'addons.mozilla.org',
    'microsoftedge.microsoft.com'];

  function parseUrl(url) {
    if (typeof url !== 'string' || !url) return null;
    try {
      return new URL(url);
    } catch (e) {
      return null;
    }
  }

  /** True for pages the extension must refuse to operate on. */
  function isRestrictedUrl(url) {
    const u = parseUrl(url);
    if (!u) return true;
    if (BLOCKED_SCHEMES.includes(u.protocol)) return true;
    if (u.protocol === 'https:' && BLOCKED_HOSTS.includes(u.hostname)) return true;
    // The Web Store path form, which Chrome blocks regardless of host permissions.
    if (u.hostname === 'chrome.google.com' && u.pathname.startsWith('/webstore')) return true;
    return !(u.protocol === 'http:' || u.protocol === 'https:' || u.protocol === 'file:');
  }

  /** Registrable-ish domain: example.com from www.shop.example.com. */
  function registrableDomain(hostname) {
    if (!hostname) return '';
    // An IP literal has no registrable domain; use it whole.
    if (/^\[?[0-9a-f:.]+\]?$/i.test(hostname) && /\d/.test(hostname)) return hostname;
    const parts = hostname.split('.').filter(Boolean);
    if (parts.length <= 2) return hostname;
    const lastTwo = parts.slice(-2).join('.');
    if (THREE_LABEL_SUFFIXES.has(lastTwo)) return parts.slice(-3).join('.');
    return lastTwo;
  }

  /**
   * scopeKeyFor(url, mode) -> 'host:www.example.com' | 'domain:example.com' | 'url:https://…'
   * Returns null when the url cannot carry rules at all.
   */
  function scopeKeyFor(url, mode) {
    const u = parseUrl(url);
    if (!u || isRestrictedUrl(url)) return null;
    const m = MATCH_MODES.includes(mode) ? mode : 'host';
    if (m === 'host') return 'host:' + u.hostname;
    if (m === 'domain') return 'domain:' + registrableDomain(u.hostname);
    return 'url:' + u.origin + u.pathname + u.search;
  }

  /**
   * Every scope key that could hold rules for this url, MOST SPECIFIC FIRST.
   * The applier reads all of them; ordering matters only for later-wins CSS cascade intent.
   */
  function candidateScopeKeys(url) {
    const out = [];
    for (const mode of ['url', 'host', 'domain']) {
      const k = scopeKeyFor(url, mode);
      if (k && !out.includes(k)) out.push(k);
    }
    return out;
  }

  function humanScope(scopeKey) {
    if (typeof scopeKey !== 'string') return '';
    const i = scopeKey.indexOf(':');
    if (i < 0) return scopeKey;
    const mode = scopeKey.slice(0, i);
    const val = scopeKey.slice(i + 1);
    if (mode === 'domain') return '*.' + val;
    return val;
  }

  function storageKey(scopeKey) {
    return RULES_PREFIX + scopeKey;
  }

  function newRuleId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function') {
      return 'r-' + globalThis.crypto.randomUUID();
    }
    // randomUUID needs a secure context; every context we run in has one, but stay safe.
    const a = new Uint8Array(16);
    globalThis.crypto.getRandomValues(a);
    return 'r-' + Array.from(a, (b) => b.toString(16).padStart(2, '0')).join('');
  }

  async function rawGet(key, fallback) {
    try {
      const got = await chrome.storage.local.get(key);
      const v = got && got[key];
      return v === undefined || v === null ? fallback : v;
    } catch (e) {
      console.warn('[Custom CSS Injector] storage read failed for', key, e);
      return fallback;
    }
  }

  async function rawSet(key, value) {
    await chrome.storage.local.set({ [key]: value });
  }

  /* ---------------------------------------------------------------- validation */

  function isPlainObject(v) {
    return !!v && typeof v === 'object' && !Array.isArray(v);
  }

  /** Coerce anything stored under a rules key into a well-formed Rule[]. Never throws. */
  function normalizeRuleList(raw, scopeKey) {
    if (!Array.isArray(raw)) return [];
    const out = [];
    for (const r of raw) {
      const norm = normalizeRule(r, scopeKey);
      if (norm) out.push(norm);
    }
    return out;
  }

  function normalizeRule(r, scopeKey) {
    if (!isPlainObject(r)) return null;
    if (typeof r.css !== 'string') return null;
    if (!isPlainObject(r.fingerprint)) return null;
    const id = typeof r.id === 'string' && r.id ? r.id : newRuleId();
    return {
      id,
      // The key a rule is FILED UNDER is authoritative; a stale or imported scopeKey on the
      // object itself must not win, or the rule becomes invisible to the scope that holds it.
      scopeKey: scopeKey || (typeof r.scopeKey === 'string' ? r.scopeKey : ''),
      matchMode: MATCH_MODES.includes(r.matchMode) ? r.matchMode : 'host',
      label: typeof r.label === 'string' ? r.label : '',
      css: r.css,
      enabled: r.enabled !== false,
      fingerprint: r.fingerprint,
      createdAt: Number.isFinite(r.createdAt) ? r.createdAt : Date.now(),
      updatedAt: Number.isFinite(r.updatedAt) ? r.updatedAt : Date.now(),
      lastResolved: isPlainObject(r.lastResolved) ? r.lastResolved : null,
    };
  }

  /* ---------------------------------------------------------------- settings */

  async function getSettings() {
    const s = await rawGet(K_SETTINGS, null);
    if (!isPlainObject(s)) return { ...DEFAULT_SETTINGS };
    return {
      schemaVersion: Number.isFinite(s.schemaVersion) ? s.schemaVersion : SCHEMA_VERSION,
      enabled: s.enabled !== false,
      defaultMatchMode: MATCH_MODES.includes(s.defaultMatchMode) ? s.defaultMatchMode : 'host',
    };
  }

  async function setSettings(patch) {
    const cur = await getSettings();
    const next = { ...cur, ...(isPlainObject(patch) ? patch : {}) };
    next.schemaVersion = SCHEMA_VERSION;
    next.enabled = next.enabled !== false;
    if (!MATCH_MODES.includes(next.defaultMatchMode)) next.defaultMatchMode = 'host';
    await rawSet(K_SETTINGS, next);
    return next;
  }

  async function ensureDefaults() {
    const existing = await rawGet(K_SETTINGS, null);
    if (!isPlainObject(existing)) await rawSet(K_SETTINGS, { ...DEFAULT_SETTINGS });
    return migrate();
  }

  /** No-op today; the hook exists so a future schema bump has somewhere to live. */
  async function migrate() {
    const s = await getSettings();
    if (s.schemaVersion === SCHEMA_VERSION) return s;
    return setSettings({ schemaVersion: SCHEMA_VERSION });
  }

  /* ---------------------------------------------------------------- rules */

  async function getRules(scopeKey) {
    if (!scopeKey) return [];
    return normalizeRuleList(await rawGet(storageKey(scopeKey), []), scopeKey);
  }

  async function setRules(scopeKey, rules) {
    if (!scopeKey) throw new Error('setRules: missing scopeKey');
    const clean = normalizeRuleList(rules, scopeKey);
    if (clean.length === 0) {
      await chrome.storage.local.remove(storageKey(scopeKey));
      return [];
    }
    await rawSet(storageKey(scopeKey), clean);
    return clean;
  }

  /** All rules that could apply to a url, tagged with the scope they came from. */
  async function getRulesForUrl(url) {
    const keys = candidateScopeKeys(url);
    if (!keys.length) return [];
    const out = [];
    for (const k of keys) {
      for (const r of await getRules(k)) out.push(r);
    }
    return out;
  }

  async function addRule(scopeKey, partial) {
    const rules = await getRules(scopeKey);
    const now = Date.now();
    const rule = normalizeRule({
      ...partial,
      id: newRuleId(),
      scopeKey,
      createdAt: now,
      updatedAt: now,
      lastResolved: null,
    }, scopeKey);
    if (!rule) throw new Error('addRule: rule needs a css string and a fingerprint object');
    rules.push(rule);
    await setRules(scopeKey, rules);
    return rule;
  }

  async function updateRule(scopeKey, ruleId, patch) {
    const rules = await getRules(scopeKey);
    const i = rules.findIndex((r) => r.id === ruleId);
    if (i < 0) return null;
    const merged = normalizeRule({ ...rules[i], ...patch, id: ruleId, updatedAt: Date.now() }, scopeKey);
    if (!merged) throw new Error('updateRule: patch produced an invalid rule');
    rules[i] = merged;
    await setRules(scopeKey, rules);
    return merged;
  }

  async function toggleRule(scopeKey, ruleId, enabled) {
    const rules = await getRules(scopeKey);
    const i = rules.findIndex((r) => r.id === ruleId);
    if (i < 0) return null;
    rules[i].enabled = enabled === undefined ? !rules[i].enabled : !!enabled;
    rules[i].updatedAt = Date.now();
    await setRules(scopeKey, rules);
    return rules[i];
  }

  async function deleteRule(scopeKey, ruleId) {
    const rules = await getRules(scopeKey);
    const next = rules.filter((r) => r.id !== ruleId);
    if (next.length === rules.length) return false;
    await setRules(scopeKey, next);
    return true;
  }

  /**
   * Diagnostics written by the applier. Kept on the rule so the popup can show which rules
   * are actually landing. Throttling is the applier's job, not this function's.
   */
  async function setLastResolved(scopeKey, ruleId, info) {
    const rules = await getRules(scopeKey);
    const i = rules.findIndex((r) => r.id === ruleId);
    if (i < 0) return;
    rules[i].lastResolved = {
      at: Date.now(),
      matched: !!(info && info.matched),
      score: info && Number.isFinite(info.score) ? info.score : null,
      via: info && typeof info.via === 'string' ? info.via : null,
      reason: info && typeof info.reason === 'string' ? info.reason : null,
    };
    // Written directly, bypassing setRules' full re-validation: this is a hot-ish path.
    await rawSet(storageKey(scopeKey), rules);
  }

  /* ---------------------------------------------------------------- across all scopes
   * The rules manager needs every rule the extension holds, and bulk edits over an arbitrary
   * selection that can span scopes. Doing that through the per-rule functions would mean one
   * storage round-trip per rule, so these read every scope once and write only what changed.
   */

  async function getAllScopes() {
    let all;
    try {
      all = await chrome.storage.local.get(null);
    } catch (e) {
      console.warn('[Custom CSS Injector] could not enumerate storage', e);
      return {};
    }
    const out = {};
    for (const [k, v] of Object.entries(all)) {
      if (!k.startsWith(RULES_PREFIX)) continue;
      const scopeKey = k.slice(RULES_PREFIX.length);
      const list = normalizeRuleList(v, scopeKey);
      if (list.length) out[scopeKey] = list;
    }
    return out;
  }

  /** Every rule, flat, each carrying the scope it is filed under. */
  async function getAllRules() {
    const scopes = await getAllScopes();
    const out = [];
    for (const [scopeKey, list] of Object.entries(scopes)) {
      for (const r of list) out.push({ ...r, scopeKey });
    }
    return out;
  }

  /**
   * Apply `mutate` to every rule whose id is in `ids`, across every scope.
   * Return null from mutate to delete the rule. Returns how many were touched.
   */
  async function bulkUpdate(ids, mutate) {
    const wanted = new Set(Array.isArray(ids) ? ids : []);
    if (!wanted.size) return 0;

    const scopes = await getAllScopes();
    const writes = {};
    const removals = [];
    let touched = 0;

    for (const [scopeKey, list] of Object.entries(scopes)) {
      let changed = false;
      const next = [];
      for (const r of list) {
        if (!wanted.has(r.id)) { next.push(r); continue; }
        changed = true;
        touched++;
        const res = mutate(r);
        if (res) next.push(res);
      }
      if (!changed) continue;
      if (next.length) writes[storageKey(scopeKey)] = next;
      else removals.push(storageKey(scopeKey));
    }

    if (Object.keys(writes).length) await chrome.storage.local.set(writes);
    if (removals.length) await chrome.storage.local.remove(removals);
    return touched;
  }

  function bulkDelete(ids) {
    return bulkUpdate(ids, () => null);
  }

  function bulkSetEnabled(ids, enabled) {
    return bulkUpdate(ids, (r) => ({ ...r, enabled: !!enabled, updatedAt: Date.now() }));
  }

  /** Move rules to a different match mode, recomputing nothing — the scope key stays as filed. */
  function bulkSetMatchMode(ids, mode) {
    const m = MATCH_MODES.includes(mode) ? mode : 'host';
    return bulkUpdate(ids, (r) => ({ ...r, matchMode: m, updatedAt: Date.now() }));
  }

  /* ---------------------------------------------------------------- pending capture
   * Clicking an element on the page dismisses the popup, so a capture cannot be handed to a
   * live popup. It is parked here and collected when the popup next opens.
   */

  async function getPendingCapture() {
    const p = await rawGet(K_PENDING, null);
    return isPlainObject(p) ? p : null;
  }

  async function setPendingCapture(capture) {
    await rawSet(K_PENDING, capture);
  }

  async function clearPendingCapture() {
    try {
      await chrome.storage.local.remove(K_PENDING);
    } catch (e) {
      console.warn('[Custom CSS Injector] failed to clear pending capture', e);
    }
  }

  /* ---------------------------------------------------------------- export / import */

  /** exportAll() exports everything; exportAll(ids) exports only those rules. */
  async function exportAll(ids) {
    const filter = Array.isArray(ids) && ids.length ? new Set(ids) : null;
    const scopes = {};
    for (const [scopeKey, list] of Object.entries(await getAllScopes())) {
      const keep = filter ? list.filter((r) => filter.has(r.id)) : list;
      if (keep.length) scopes[scopeKey] = keep;
    }
    return {
      format: 'dom-styler-export',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: Date.now(),
      settings: await getSettings(),
      scopes,
    };
  }

  /**
   * Validates before writing anything. Returns a report rather than throwing on bad data,
   * because the input is a user-supplied file.
   */
  async function importAll(payload, { merge = true } = {}) {
    if (!isPlainObject(payload)) throw new Error('Import file is not a JSON object');
    if (payload.format !== 'dom-styler-export') {
      throw new Error('Not a Custom CSS Injector export file (missing format marker)');
    }
    if (!isPlainObject(payload.scopes)) throw new Error('Import file has no scopes object');

    const report = { scopes: 0, rules: 0, skipped: 0 };
    const writes = {};

    for (const [scopeKey, list] of Object.entries(payload.scopes)) {
      if (typeof scopeKey !== 'string' || !scopeKey.includes(':')) {
        report.skipped += Array.isArray(list) ? list.length : 1;
        continue;
      }
      const incoming = normalizeRuleList(list, scopeKey);
      report.skipped += (Array.isArray(list) ? list.length : 0) - incoming.length;
      if (!incoming.length) continue;

      let final = incoming;
      if (merge) {
        const existing = await getRules(scopeKey);
        const seen = new Set(existing.map((r) => r.id));
        final = existing.concat(incoming.filter((r) => !seen.has(r.id)));
      }
      writes[storageKey(scopeKey)] = final;
      report.scopes += 1;
      report.rules += incoming.length;
    }

    if (Object.keys(writes).length) await chrome.storage.local.set(writes);
    if (isPlainObject(payload.settings)) {
      await setSettings({ defaultMatchMode: payload.settings.defaultMatchMode });
    }
    return report;
  }

  globalThis.DomStylerStorage = {
    SCHEMA_VERSION,
    MATCH_MODES,
    RULES_PREFIX,
    // url / scope
    isRestrictedUrl,
    registrableDomain,
    scopeKeyFor,
    candidateScopeKeys,
    humanScope,
    newRuleId,
    // settings
    getSettings,
    setSettings,
    ensureDefaults,
    // rules
    getRules,
    setRules,
    getRulesForUrl,
    addRule,
    updateRule,
    toggleRule,
    deleteRule,
    setLastResolved,
    // across all scopes (the rules manager)
    getAllScopes,
    getAllRules,
    bulkUpdate,
    bulkDelete,
    bulkSetEnabled,
    bulkSetMatchMode,
    // capture handoff
    getPendingCapture,
    setPendingCapture,
    clearPendingCapture,
    // backup
    exportAll,
    importAll,
  };
})();
