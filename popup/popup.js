/*
 * popup/popup.js — the UI.
 *
 * Every string that reaches the DOM here originates from the page the user visited (selectors,
 * class names, text snippets) or from a file they imported, so it is all built with
 * createElement/textContent. There is no innerHTML in this file, and the extension CSP forbids
 * inline script, which is why popup.html has none.
 */
(function () {
  'use strict';

  const Storage = globalThis.DomStylerStorage;
  const Css = globalThis.DomStylerCss;

  const $ = (id) => document.getElementById(id);

  const el = {
    scope: $('scope'),
    globalEnabled: $('global-enabled'),
    banner: $('banner'),
    pickBtn: $('pick-btn'),
    matchMode: $('match-mode'),
    capture: $('capture'),
    captureDesc: $('capture-desc'),
    captureMeta: $('capture-meta'),
    captureDetail: $('capture-detail'),
    captureDetailBody: $('capture-detail-body'),
    captureDiscard: $('capture-discard'),
    cssInput: $('css-input'),
    cssError: $('css-error'),
    saveBtn: $('save-btn'),
    rulesCount: $('rules-count'),
    rulesList: $('rules-list'),
    rulesEmpty: $('rules-empty'),
    viewAllBtn: $('view-all-btn'),
    exportBtn: $('export-btn'),
    importBtn: $('import-btn'),
    importFile: $('import-file'),
    toast: $('toast'),
  };

  let tab = null;
  let pending = null;         // the parked capture, if any
  let editingRuleId = null;   // set when the CSS box is editing an existing rule
  let previewTimer = null;
  let statuses = new Map();

  /* ---------------------------------------------------------------- helpers */

  function toast(text, bad) {
    el.toast.textContent = text;
    el.toast.classList.toggle('bad', !!bad);
    el.toast.hidden = false;
    setTimeout(() => { el.toast.hidden = true; }, 1900);
  }

  function banner(text, bad) {
    if (!text) {
      el.banner.hidden = true;
      return;
    }
    el.banner.textContent = text;
    el.banner.classList.toggle('bad', !!bad);
    el.banner.hidden = false;
  }

  function tag(text, cls) {
    const s = document.createElement('span');
    s.className = 'tag' + (cls ? ' ' + cls : '');
    s.textContent = text;
    return s;
  }

  function currentScopeKey() {
    if (!tab || !tab.url) return null;
    return Storage.scopeKeyFor(tab.url, el.matchMode.value);
  }

  async function sendToTab(msg) {
    if (!tab || !tab.id) return null;
    try {
      return await chrome.tabs.sendMessage(tab.id, msg);
    } catch (e) {
      return null;   // no applier in this tab
    }
  }

  async function sendToWorker(msg) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  /* ---------------------------------------------------------------- init */

  async function init() {
    bind();

    const settings = await Storage.getSettings();
    el.globalEnabled.checked = settings.enabled;
    el.matchMode.value = settings.defaultMatchMode;

    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = tabs && tabs[0];

    if (!tab || !tab.url) {
      banner('No active page.', true);
      el.pickBtn.disabled = true;
      return;
    }

    if (Storage.isRestrictedUrl(tab.url)) {
      el.scope.textContent = 'restricted page';
      banner('Extensions cannot run on this page, so nothing can be picked or styled here.', true);
      el.pickBtn.disabled = true;
      return;
    }

    renderScope();

    /*
     * A tab that was already open when the extension was installed or reloaded never ran the
     * manifest content scripts, so it has no applier: status would read "not checked yet" and
     * live preview would silently do nothing. Inject on demand instead of asking for a reload.
     */
    const ready = await sendToWorker({ type: 'DS_ENSURE_SCRIPTS', tabId: tab.id });
    if (!ready || !ready.ok) {
      banner('Styling is not active on this tab yet — reload the page to apply saved rules.', false);
    }

    pending = await Storage.getPendingCapture();
    renderCapture();
    await refreshStatuses();
    await renderRules();
  }

  function renderScope() {
    const key = currentScopeKey();
    const human = key ? Storage.humanScope(key) : '';
    el.scope.textContent = human;
    el.scope.title = key || '';
  }

  function bind() {
    el.pickBtn.addEventListener('click', onPick);
    el.matchMode.addEventListener('change', async () => {
      await Storage.setSettings({ defaultMatchMode: el.matchMode.value });
      renderScope();
      await renderRules();
    });
    el.globalEnabled.addEventListener('change', async () => {
      await Storage.setSettings({ enabled: el.globalEnabled.checked });
      await sendToWorker({ type: 'DS_RULES_SAVED' });
      toast(el.globalEnabled.checked ? 'styling on' : 'styling off');
    });
    el.captureDiscard.addEventListener('click', discardCapture);
    el.saveBtn.addEventListener('click', save);
    el.cssInput.addEventListener('input', onCssInput);
    el.cssInput.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });
    el.viewAllBtn.addEventListener('click', () => {
      // Every rule on every site, with filters and bulk actions — too much for a 392px popup.
      chrome.runtime.openOptionsPage();
      window.close();
    });
    el.exportBtn.addEventListener('click', doExport);
    el.importBtn.addEventListener('click', () => el.importFile.click());
    el.importFile.addEventListener('change', doImport);

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !el.capture.hidden) {
        e.preventDefault();
        discardCapture();
      }
    });

    // Leaving the popup must not leave a preview stuck on the page.
    window.addEventListener('unload', () => {
      if (previewTimer) clearTimeout(previewTimer);
      if (tab && tab.id) {
        try {
          chrome.tabs.sendMessage(tab.id, { type: 'DS_PREVIEW_CLEAR' }, () => {
            void chrome.runtime.lastError;
          });
        } catch (e) { /* closing anyway */ }
      }
    });
  }

  /* ---------------------------------------------------------------- picking */

  async function onPick() {
    el.pickBtn.disabled = true;
    const res = await sendToWorker({ type: 'DS_START_PICKER', tabId: tab.id });
    el.pickBtn.disabled = false;
    if (!res || !res.ok) {
      banner((res && res.error) || 'Could not start the picker.', true);
      return;
    }
    banner('');
    // Clicking the page dismisses the popup, so this window is about to disappear. The capture
    // is parked in storage by the service worker and collected next time the popup opens.
    window.close();
  }

  function renderCapture() {
    if (!pending || !pending.fingerprint) {
      el.capture.hidden = true;
      return;
    }
    el.capture.hidden = false;
    el.captureDesc.textContent = pending.describe || '(element)';
    el.captureDesc.title = pending.describe || '';

    el.captureMeta.textContent = '';
    const fp = pending.fingerprint;

    if (fp.idOk) el.captureMeta.appendChild(tag('unique id: ' + fp.id, 'ok'));
    else if (fp.id) el.captureMeta.appendChild(tag('id "' + fp.id + '" not reliable', 'warn'));
    else el.captureMeta.appendChild(tag('no id', 'warn'));

    if (pending.verified) {
      const pct = Math.round((pending.verifyScore || 0) * 100);
      el.captureMeta.appendChild(tag('re-found ' + pct + '% via ' + pending.verifyVia, 'ok'));
    } else {
      el.captureMeta.appendChild(tag('could not re-find: ' + (pending.verifyReason || '?'), 'bad'));
    }

    if (pending.rect) el.captureMeta.appendChild(tag(pending.rect.w + '×' + pending.rect.h));
    if (fp.hosts) el.captureMeta.appendChild(tag('inside shadow DOM', 'warn'));

    renderCaptureDetail(fp);

    if (pending.url && tab && pending.url !== tab.url) {
      banner('This element was picked on a different page than the one open now.', false);
    }

    el.cssInput.focus();
  }

  /* The uniqueness data, spelled out — this is what makes the rule survive an id change. */
  function renderCaptureDetail(fp) {
    const body = el.captureDetailBody;
    body.textContent = '';

    function line(label, value) {
      if (value === '' || value === null || value === undefined) return;
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = label + ': ';
      d.append(b, document.createTextNode(String(value)));
      body.appendChild(d);
    }

    line('tag', '<' + fp.tag + '>' + (fp.ns !== 'html' ? ' (' + fp.ns + ')' : ''));
    if (fp.id) line('id', fp.id + (fp.idOk ? ' (unique, stable)' : fp.idDup ? ' (DUPLICATED in page)' : ' (looks generated)'));
    if (fp.tid) line(fp.tid[0], fp.tid[1]);
    if (fp.cls && fp.cls.length) line('stable classes', '.' + fp.cls.join('.') + (fp.clsN > fp.cls.length ? '  (' + (fp.clsN - fp.cls.length) + ' more ignored as generated/utility)' : ''));
    const an = fp.attrs ? Object.keys(fp.attrs) : [];
    for (const n of an) line(n, fp.attrs[n]);
    if (fp.txt) line('text', '"' + fp.txt + '"' + (fp.txtLen > fp.txt.length ? ' …' : ''));

    line('position', 'child #' + fp.nci + ' of ' + fp.sibCount + ', ' + fp.tag + ' #' + fp.noti + ' of ' + fp.sameTagCount + ', depth ' + fp.depth);

    if (fp.path && fp.path.length) {
      const names = ['parent', 'grandparent', 'great-grandparent', 'gg-grandparent', 'ggg-grandparent'];
      fp.path.forEach((p, i) => {
        const bits = ['<' + p.tag + '>'];
        if (p.id) bits.push('#' + p.id);
        if (p.tid) bits.push('[' + p.tid[0] + '=' + p.tid[1] + ']');
        if (p.cls && p.cls.length) bits.push('.' + p.cls.join('.'));
        bits.push('child #' + p.nci + ', ' + p.ecnt + ' children');
        line(names[i] || 'ancestor ' + (i + 1), bits.join(' '));
      });
    }

    if (fp.sibP) line('prev sibling', '<' + fp.sibP.tag + '>' + (fp.sibP.txt ? ' "' + fp.sibP.txt + '"' : ''));
    if (fp.sibN) line('next sibling', '<' + fp.sibN.tag + '>' + (fp.sibN.txt ? ' "' + fp.sibN.txt + '"' : ''));
    if (fp.anchor) line('anchor', fp.anchor.sel + '  (' + fp.anchor.up + ' level' + (fp.anchor.up === 1 ? '' : 's') + ' up)');

    if (fp.sel && fp.sel.length) {
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = 'selectors tried, in order:';
      d.appendChild(b);
      body.appendChild(d);
      fp.sel.forEach((c, i) => {
        const s = document.createElement('div');
        s.textContent = '  ' + (i + 1) + '. ' + c.s + '   [' + c.k + (c.n > 1 ? ', matches ' + c.n : '') + ']';
        body.appendChild(s);
      });
    } else {
      line('selectors', 'none — position-only match (weak)');
    }
  }

  async function discardCapture() {
    pending = null;
    editingRuleId = null;
    el.cssInput.value = '';
    el.cssError.hidden = true;
    await Storage.clearPendingCapture();
    await sendToTab({ type: 'DS_PREVIEW_CLEAR' });
    el.capture.hidden = true;
  }

  /* ---------------------------------------------------------------- css editing */

  function onCssInput() {
    const marker = Css.markerFor(editingRuleId || 'preview');
    const compiled = Css.compile(el.cssInput.value, marker);
    if (compiled.errors.length) {
      el.cssError.textContent = compiled.errors.join('; ');
      el.cssError.hidden = false;
    } else {
      el.cssError.hidden = true;
    }

    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      const fp = pending ? pending.fingerprint : null;
      if (!fp) return;
      sendToTab({ type: 'DS_PREVIEW', css: el.cssInput.value, fingerprint: fp });
    }, 220);
  }

  async function save() {
    const css = el.cssInput.value.trim();
    if (!css) {
      toast('nothing to save', true);
      return;
    }
    const compiled = Css.compile(css, Css.markerFor('x'));
    if (!compiled.ok) {
      el.cssError.textContent = compiled.errors.join('; ');
      el.cssError.hidden = false;
      toast('fix the CSS first', true);
      return;
    }

    const scopeKey = currentScopeKey();
    if (!scopeKey) {
      toast('cannot save on this page', true);
      return;
    }

    try {
      if (editingRuleId) {
        await Storage.updateRule(scopeKey, editingRuleId, { css });
      } else {
        if (!pending || !pending.fingerprint) {
          toast('pick an element first', true);
          return;
        }
        await Storage.addRule(scopeKey, {
          css,
          fingerprint: pending.fingerprint,
          label: pending.describe || '',
          matchMode: el.matchMode.value,
          enabled: true,
        });
      }
    } catch (e) {
      toast('save failed: ' + e.message, true);
      return;
    }

    await sendToTab({ type: 'DS_PREVIEW_CLEAR' });
    await Storage.clearPendingCapture();
    await sendToWorker({ type: 'DS_RULES_SAVED', scopeKey });

    pending = null;
    editingRuleId = null;
    el.cssInput.value = '';
    el.capture.hidden = true;
    toast('saved');
    await refreshStatuses();
    await renderRules();
  }

  /* ---------------------------------------------------------------- rules list */

  async function refreshStatuses() {
    statuses = new Map();
    const res = await sendToTab({ type: 'DS_GET_STATUS' });
    if (res && res.ok && Array.isArray(res.statuses)) {
      for (const s of res.statuses) statuses.set(s.id, s);
    }
  }

  async function renderRules() {
    const scopeKey = currentScopeKey();
    const rules = scopeKey ? await Storage.getRules(scopeKey) : [];

    el.rulesCount.textContent = rules.length ? 'Rules (' + rules.length + ')' : 'Rules';
    el.rulesList.textContent = '';
    el.rulesEmpty.hidden = rules.length > 0;

    for (const rule of rules) {
      el.rulesList.appendChild(renderRule(rule, scopeKey));
    }
  }

  function renderRule(rule, scopeKey) {
    const li = document.createElement('li');
    if (!rule.enabled) li.className = 'off';

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = rule.enabled;
    cb.title = 'Enable or disable this rule';
    cb.addEventListener('change', async () => {
      await Storage.toggleRule(scopeKey, rule.id, cb.checked);
      await sendToWorker({ type: 'DS_RULES_SAVED', scopeKey });
      await renderRules();
    });

    const body = document.createElement('div');
    body.className = 'rule-body';

    const sel = document.createElement('div');
    sel.className = 'rule-sel';
    sel.textContent = rule.label || '(element)';
    sel.title = rule.label || '';

    const css = document.createElement('div');
    css.className = 'rule-css';
    const oneLine = rule.css.replace(/\s+/g, ' ').trim();
    css.textContent = oneLine;
    css.title = rule.css;

    const status = document.createElement('div');
    status.className = 'rule-status';
    const live = statuses.get(rule.id);
    const info = live || rule.lastResolved;
    if (!info) {
      status.appendChild(tag('not checked yet'));
    } else if (info.matched) {
      const pct = Number.isFinite(info.score) ? Math.round(info.score * 100) + '%' : '';
      status.appendChild(tag('matching' + (pct ? ' ' + pct : '') + (info.via ? ' · ' + info.via : ''), 'ok'));
    } else {
      status.appendChild(tag('not matching' + (info.reason ? ' · ' + reasonText(info.reason) : ''), 'bad'));
    }
    if (rule.matchMode !== 'host') status.appendChild(tag(rule.matchMode));

    body.append(sel, css, status);

    const actions = document.createElement('div');
    actions.className = 'rule-actions';

    const edit = document.createElement('button');
    edit.className = 'link';
    edit.textContent = 'edit';
    edit.addEventListener('click', () => startEdit(rule));

    const del = document.createElement('button');
    del.className = 'link';
    del.textContent = 'delete';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this rule?\n\n' + (rule.label || '') + '\n' + oneLine)) return;
      await Storage.deleteRule(scopeKey, rule.id);
      await sendToWorker({ type: 'DS_RULES_SAVED', scopeKey });
      toast('deleted');
      await renderRules();
    });

    actions.append(edit, del);
    li.append(cb, body, actions);
    return li;
  }

  function reasonText(code) {
    switch (code) {
      case 'NO_MATCH': return 'element not on the page';
      case 'AMBIGUOUS': return 'several elements match equally';
      case 'LOW_CONFIDENCE': return 'best match too different';
      case 'WEAK_FINGERPRINT': return 'structure changed';
      case 'SHADOW_UNREACHABLE': return 'shadow root gone';
      case 'BACKOFF': return 'retrying';
      case 'UNSUPPORTED_FINGERPRINT': return 'saved by a newer version — update the extension';
      default: return code;
    }
  }

  function startEdit(rule) {
    editingRuleId = rule.id;
    pending = { fingerprint: rule.fingerprint, describe: rule.label, verified: true, verifyVia: 'saved', verifyScore: 1 };
    el.capture.hidden = false;
    el.captureDesc.textContent = rule.label || '(element)';
    el.captureMeta.textContent = '';
    el.captureMeta.appendChild(tag('editing saved rule'));
    renderCaptureDetail(rule.fingerprint);
    el.cssInput.value = rule.css;
    el.cssInput.focus();
    onCssInput();
  }

  /* ---------------------------------------------------------------- export / import */

  async function doExport() {
    try {
      const data = await Storage.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'custom-css-injector-rules.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      const n = Object.values(data.scopes).reduce((s, l) => s + l.length, 0);
      toast('exported ' + n + ' rule' + (n === 1 ? '' : 's'));
    } catch (e) {
      toast('export failed: ' + e.message, true);
    }
  }

  async function doImport(ev) {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    try {
      const text = await file.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch (e) {
        throw new Error('that file is not valid JSON');
      }
      const report = await Storage.importAll(payload, { merge: true });
      await sendToWorker({ type: 'DS_RULES_SAVED' });
      toast('imported ' + report.rules + ' rule' + (report.rules === 1 ? '' : 's')
        + (report.skipped ? ', skipped ' + report.skipped : ''));
      await renderRules();
    } catch (e) {
      banner('Import failed: ' + e.message, true);
    }
  }

  init().catch((e) => {
    banner('Custom CSS Injector failed to start: ' + e.message, true);
    console.error(e);
  });
})();
