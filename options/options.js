/*
 * options/options.js — the full-page rules manager: every rule the extension holds, in one table,
 * with filters, multi-select, bulk enable/disable/delete/export, and inline editing.
 *
 * Same rule as the popup: rule labels, selectors and CSS all originate from pages the user
 * visited, so every node here is built with createElement/textContent. No innerHTML.
 *
 * On the "Last seen" column: it reports the lastResolved diagnostic the applier wrote the last
 * time a page in that scope was open. It is deliberately labelled "last seen" rather than
 * "matching", because this page cannot check a rule against a tab that is not open.
 */
(function () {
  'use strict';

  const Storage = globalThis.DomStylerStorage;
  const Css = globalThis.DomStylerCss;

  const $ = (id) => document.getElementById(id);
  const el = {
    summary: $('summary'),
    globalEnabled: $('global-enabled'),
    exportAll: $('export-all'),
    importAll: $('import-all'),
    importFile: $('import-file'),
    banner: $('banner'),
    fText: $('f-text'),
    fScope: $('f-scope'),
    fMode: $('f-mode'),
    fEnabled: $('f-enabled'),
    fStatus: $('f-status'),
    fClear: $('f-clear'),
    bulk: $('bulk'),
    bulkCount: $('bulk-count'),
    bulkEnable: $('bulk-enable'),
    bulkDisable: $('bulk-disable'),
    bulkExport: $('bulk-export'),
    bulkDelete: $('bulk-delete'),
    bulkClear: $('bulk-clear'),
    selectAll: $('select-all'),
    rows: $('rows'),
    empty: $('empty'),
    toast: $('toast'),
  };

  let all = [];                       // every rule, flat
  let shown = [];                     // after filtering + sorting
  const selected = new Set();         // rule ids
  let sortKey = 'scope';
  let sortDir = 1;
  let editingId = null;

  /* ---------------------------------------------------------------- helpers */

  function toast(text, bad) {
    el.toast.textContent = text;
    el.toast.classList.toggle('bad', !!bad);
    el.toast.hidden = false;
    setTimeout(() => { el.toast.hidden = true; }, 2000);
  }

  function banner(text) {
    if (!text) { el.banner.hidden = true; return; }
    el.banner.textContent = text;
    el.banner.hidden = false;
  }

  function tag(text, cls) {
    const s = document.createElement('span');
    s.className = 'tag' + (cls ? ' ' + cls : '');
    s.textContent = text;
    return s;
  }

  function oneLine(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function ago(ts) {
    if (!Number.isFinite(ts)) return '';
    const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's ago';
    const m = Math.round(s / 60);
    if (m < 60) return m + 'm ago';
    const h = Math.round(m / 60);
    if (h < 24) return h + 'h ago';
    const d = Math.round(h / 24);
    if (d < 30) return d + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  function statusOf(rule) {
    const lr = rule.lastResolved;
    if (!lr) return 'unknown';
    return lr.matched ? 'ok' : 'bad';
  }

  function reasonText(code) {
    switch (code) {
      case 'NO_MATCH': return 'element not on the page';
      case 'AMBIGUOUS': return 'several elements matched equally';
      case 'LOW_CONFIDENCE': return 'best match too different';
      case 'WEAK_FINGERPRINT': return 'structure changed';
      case 'SHADOW_UNREACHABLE': return 'shadow root gone';
      case 'BACKOFF': return 'retrying';
      case 'UNSUPPORTED_FINGERPRINT': return 'saved by a newer version';
      default: return code || 'unknown';
    }
  }

  async function notifyChanged(scopeKey) {
    try {
      await chrome.runtime.sendMessage({ type: 'DS_RULES_SAVED', scopeKey: scopeKey || null });
    } catch (e) { /* worker asleep; pages pick it up on next load */ }
  }

  /* ---------------------------------------------------------------- load */

  async function load() {
    try {
      all = await Storage.getAllRules();
    } catch (e) {
      banner('Could not read saved rules: ' + e.message);
      all = [];
    }
    const settings = await Storage.getSettings();
    el.globalEnabled.checked = settings.enabled;

    // Rebuild the site filter, preserving the current choice if it still exists.
    const keys = Array.from(new Set(all.map((r) => r.scopeKey))).sort();
    const keep = el.fScope.value;
    el.fScope.textContent = '';
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = 'All sites (' + keys.length + ')';
    el.fScope.appendChild(optAll);
    for (const k of keys) {
      const o = document.createElement('option');
      o.value = k;
      const n = all.filter((r) => r.scopeKey === k).length;
      o.textContent = Storage.humanScope(k) + '  (' + n + ')';
      el.fScope.appendChild(o);
    }
    el.fScope.value = keys.includes(keep) ? keep : '';

    // Drop selections for rules that no longer exist.
    const live = new Set(all.map((r) => r.id));
    for (const id of Array.from(selected)) if (!live.has(id)) selected.delete(id);

    render();
  }

  /* ---------------------------------------------------------------- filter + sort */

  function applyFilters() {
    const q = el.fText.value.trim().toLowerCase();
    const scope = el.fScope.value;
    const mode = el.fMode.value;
    const enab = el.fEnabled.value;
    const stat = el.fStatus.value;

    shown = all.filter((r) => {
      if (scope && r.scopeKey !== scope) return false;
      if (mode && r.matchMode !== mode) return false;
      if (enab === 'on' && !r.enabled) return false;
      if (enab === 'off' && r.enabled) return false;
      if (stat && statusOf(r) !== stat) return false;
      if (q) {
        const hay = (r.label + ' ' + r.css + ' ' + Storage.humanScope(r.scopeKey)).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    const val = (r) => {
      switch (sortKey) {
        case 'scope': return Storage.humanScope(r.scopeKey).toLowerCase();
        case 'label': return (r.label || '').toLowerCase();
        case 'css': return oneLine(r.css).toLowerCase();
        case 'status': return statusOf(r);
        case 'updatedAt': return r.updatedAt || 0;
        default: return '';
      }
    };
    shown.sort((a, b) => {
      const x = val(a);
      const y = val(b);
      if (x < y) return -sortDir;
      if (x > y) return sortDir;
      return (a.label || '').localeCompare(b.label || '');
    });
  }

  /* ---------------------------------------------------------------- render */

  function render() {
    applyFilters();

    el.summary.textContent = all.length
      ? all.length + ' rule' + (all.length === 1 ? '' : 's')
        + ' across ' + new Set(all.map((r) => r.scopeKey)).size + ' site'
        + (new Set(all.map((r) => r.scopeKey)).size === 1 ? '' : 's')
        + (shown.length !== all.length ? '  ·  ' + shown.length + ' shown' : '')
      : 'no rules yet';

    el.rows.textContent = '';
    for (const rule of shown) {
      el.rows.appendChild(rowFor(rule));
      if (rule.id === editingId) el.rows.appendChild(editorFor(rule));
    }

    if (!all.length) {
      el.empty.hidden = false;
      el.empty.textContent = 'No rules saved yet. Open a page, pick an element, and write some CSS.';
    } else if (!shown.length) {
      el.empty.hidden = false;
      el.empty.textContent = 'No rules match these filters.';
    } else {
      el.empty.hidden = true;
    }

    const shownIds = shown.map((r) => r.id);
    const selShown = shownIds.filter((id) => selected.has(id)).length;
    el.selectAll.checked = shownIds.length > 0 && selShown === shownIds.length;
    el.selectAll.indeterminate = selShown > 0 && selShown < shownIds.length;

    el.bulk.hidden = selected.size === 0;
    el.bulkCount.textContent = selected.size + ' selected';

    for (const th of document.querySelectorAll('th.sortable')) {
      th.classList.remove('sorted-asc', 'sorted-desc');
      if (th.dataset.sort === sortKey) {
        th.classList.add(sortDir === 1 ? 'sorted-asc' : 'sorted-desc');
      }
    }
  }

  function rowFor(rule) {
    const tr = document.createElement('tr');
    if (!rule.enabled) tr.classList.add('off');
    if (selected.has(rule.id)) tr.classList.add('sel');

    // select
    const tdCb = document.createElement('td');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = selected.has(rule.id);
    cb.title = 'Select for bulk actions';
    cb.addEventListener('change', () => {
      if (cb.checked) selected.add(rule.id);
      else selected.delete(rule.id);
      render();
    });
    tdCb.appendChild(cb);

    // enabled
    const tdOn = document.createElement('td');
    const on = document.createElement('input');
    on.type = 'checkbox';
    on.checked = rule.enabled;
    on.title = rule.enabled ? 'Disable this rule' : 'Enable this rule';
    on.addEventListener('change', async () => {
      await Storage.toggleRule(rule.scopeKey, rule.id, on.checked);
      await notifyChanged(rule.scopeKey);
      await load();
    });
    tdOn.appendChild(on);

    // site
    const tdSite = document.createElement('td');
    tdSite.className = 'site';
    tdSite.appendChild(document.createTextNode(Storage.humanScope(rule.scopeKey)));
    const mode = document.createElement('span');
    mode.className = 'mode';
    mode.textContent = rule.matchMode === 'host' ? 'hostname'
      : rule.matchMode === 'domain' ? 'domain + subdomains' : 'exact page';
    tdSite.appendChild(mode);
    tdSite.title = rule.scopeKey;

    // element
    const tdEl = document.createElement('td');
    tdEl.className = 'elem';
    tdEl.textContent = rule.label || '(element)';
    tdEl.title = rule.label || '';

    // css
    const tdCss = document.createElement('td');
    tdCss.className = 'css';
    tdCss.textContent = oneLine(rule.css);
    tdCss.title = rule.css;

    // last seen
    const tdStat = document.createElement('td');
    const lr = rule.lastResolved;
    if (!lr) {
      tdStat.appendChild(tag('never checked'));
    } else if (lr.matched) {
      const pct = Number.isFinite(lr.score) ? ' ' + Math.round(lr.score * 100) + '%' : '';
      tdStat.appendChild(tag('matched' + pct, 'ok'));
      const w = document.createElement('span');
      w.className = 'when';
      w.textContent = (lr.via ? lr.via + ' · ' : '') + ago(lr.at);
      tdStat.appendChild(w);
    } else {
      tdStat.appendChild(tag('no match', 'bad'));
      const w = document.createElement('span');
      w.className = 'when';
      w.textContent = reasonText(lr.reason) + ' · ' + ago(lr.at);
      tdStat.appendChild(w);
    }

    // updated
    const tdUpd = document.createElement('td');
    tdUpd.textContent = ago(rule.updatedAt);
    tdUpd.title = Number.isFinite(rule.updatedAt) ? new Date(rule.updatedAt).toLocaleString() : '';

    // actions
    const tdAct = document.createElement('td');
    const acts = document.createElement('div');
    acts.className = 'acts';
    const edit = document.createElement('button');
    edit.textContent = rule.id === editingId ? 'close' : 'edit';
    edit.addEventListener('click', () => {
      editingId = rule.id === editingId ? null : rule.id;
      render();
    });
    const del = document.createElement('button');
    del.className = 'danger';
    del.textContent = 'delete';
    del.addEventListener('click', async () => {
      if (!confirm('Delete this rule?\n\n' + (rule.label || '') + '\n' + oneLine(rule.css))) return;
      await Storage.deleteRule(rule.scopeKey, rule.id);
      selected.delete(rule.id);
      if (editingId === rule.id) editingId = null;
      await notifyChanged(rule.scopeKey);
      toast('deleted');
      await load();
    });
    acts.append(edit, del);
    tdAct.appendChild(acts);

    tr.append(tdCb, tdOn, tdSite, tdEl, tdCss, tdStat, tdUpd, tdAct);
    return tr;
  }

  /* ---------------------------------------------------------------- inline editor */

  function editorFor(rule) {
    const tr = document.createElement('tr');
    tr.className = 'editor';
    const td = document.createElement('td');
    td.colSpan = 8;

    const wrap = document.createElement('div');
    wrap.className = 'ed';

    const hd = document.createElement('div');
    hd.className = 'ed-hd';
    hd.appendChild(document.createTextNode('Editing CSS for '));
    const code = document.createElement('code');
    code.textContent = rule.label || '(element)';
    hd.appendChild(code);
    hd.appendChild(document.createTextNode(' on ' + Storage.humanScope(rule.scopeKey)));

    const ta = document.createElement('textarea');
    ta.value = rule.css;
    ta.spellcheck = false;

    const err = document.createElement('div');
    err.className = 'ed-err';
    err.hidden = true;

    function validate() {
      const c = Css.compile(ta.value, Css.markerFor(rule.id));
      if (c.errors.length) {
        err.textContent = c.errors.join('; ');
        err.hidden = false;
        return false;
      }
      err.hidden = true;
      return true;
    }
    ta.addEventListener('input', validate);

    const row = document.createElement('div');
    row.className = 'ed-row';
    const save = document.createElement('button');
    save.className = 'primary';
    save.textContent = 'Save';
    save.addEventListener('click', async () => {
      if (!validate()) { toast('fix the CSS first', true); return; }
      const css = ta.value.trim();
      if (!css) { toast('CSS cannot be empty — delete the rule instead', true); return; }
      await Storage.updateRule(rule.scopeKey, rule.id, { css });
      await notifyChanged(rule.scopeKey);
      editingId = null;
      toast('saved');
      await load();
    });
    const cancel = document.createElement('button');
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => { editingId = null; render(); });
    const hint = document.createElement('span');
    hint.className = 'hint';
    hint.textContent = '⌘/Ctrl + Enter saves · Esc closes';
    row.append(save, cancel, hint);

    ta.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save.click(); }
      if (e.key === 'Escape') { e.preventDefault(); cancel.click(); }
    });

    const details = document.createElement('details');
    const sum = document.createElement('summary');
    sum.textContent = 'uniqueness data';
    const detail = document.createElement('div');
    detail.className = 'ed-detail';
    renderFingerprint(detail, rule.fingerprint);
    details.append(sum, detail);

    wrap.append(hd, ta, err, row, details);
    td.appendChild(wrap);
    tr.appendChild(td);
    setTimeout(() => ta.focus(), 0);
    return tr;
  }

  /* The same breakdown the popup and sidebar show, so all three agree. */
  function renderFingerprint(body, fp) {
    body.textContent = '';
    if (!fp) { body.textContent = '(no fingerprint stored)'; return; }

    function line(label, value) {
      if (value === '' || value === null || value === undefined) return;
      const d = document.createElement('div');
      const b = document.createElement('b');
      b.textContent = label + ': ';
      d.append(b, document.createTextNode(String(value)));
      body.appendChild(d);
    }

    line('tag', '<' + fp.tag + '>' + (fp.ns && fp.ns !== 'html' ? ' (' + fp.ns + ')' : ''));
    if (fp.id) {
      line('id', fp.id + (fp.idOk ? ' (unique, stable)'
        : fp.idDup ? ' (DUPLICATED in page)' : ' (looks generated)'));
    }
    if (fp.tid) line(fp.tid[0], fp.tid[1]);
    if (fp.cls && fp.cls.length) {
      line('stable classes', '.' + fp.cls.join('.')
        + (fp.clsN > fp.cls.length ? '  (' + (fp.clsN - fp.cls.length) + ' more ignored)' : ''));
    }
    for (const n of fp.attrs ? Object.keys(fp.attrs) : []) line(n, fp.attrs[n]);
    if (fp.txt) line('text', '"' + fp.txt + '"' + (fp.txtLen > fp.txt.length ? ' …' : ''));
    if (!fp.singleton) {
      line('position', 'child #' + fp.nci + ' of ' + fp.sibCount
        + ', ' + fp.tag + ' #' + fp.noti + ' of ' + fp.sameTagCount + ', depth ' + fp.depth);
    }
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
    if (fp.anchor) line('anchor', fp.anchor.sel + '  (' + fp.anchor.up + ' up)');

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

  /* ---------------------------------------------------------------- bulk actions */

  function selectedScopes() {
    const ids = new Set(selected);
    return Array.from(new Set(all.filter((r) => ids.has(r.id)).map((r) => r.scopeKey)));
  }

  async function bulk(fn, verb) {
    const ids = Array.from(selected);
    if (!ids.length) return;
    const scopes = selectedScopes();
    const n = await fn(ids);
    for (const s of scopes) await notifyChanged(s);
    toast(verb + ' ' + n + ' rule' + (n === 1 ? '' : 's'));
    await load();
  }

  el.bulkEnable.addEventListener('click', () => bulk((ids) => Storage.bulkSetEnabled(ids, true), 'enabled'));
  el.bulkDisable.addEventListener('click', () => bulk((ids) => Storage.bulkSetEnabled(ids, false), 'disabled'));

  el.bulkDelete.addEventListener('click', async () => {
    const n = selected.size;
    if (!n) return;
    if (!confirm('Delete ' + n + ' rule' + (n === 1 ? '' : 's') + '? This cannot be undone.')) return;
    const ids = Array.from(selected);
    const scopes = selectedScopes();
    const done = await Storage.bulkDelete(ids);
    selected.clear();
    editingId = null;
    for (const s of scopes) await notifyChanged(s);
    toast('deleted ' + done + ' rule' + (done === 1 ? '' : 's'));
    await load();
  });

  el.bulkExport.addEventListener('click', () => download(Array.from(selected)));
  el.bulkClear.addEventListener('click', () => { selected.clear(); render(); });

  el.selectAll.addEventListener('change', () => {
    const ids = shown.map((r) => r.id);
    if (el.selectAll.checked) for (const id of ids) selected.add(id);
    else for (const id of ids) selected.delete(id);
    render();
  });

  /* ---------------------------------------------------------------- export / import */

  async function download(ids) {
    try {
      const data = await Storage.exportAll(ids);
      const count = Object.values(data.scopes).reduce((s, l) => s + l.length, 0);
      if (!count) { toast('nothing to export', true); return; }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = ids && ids.length ? 'dom-styler-selected.json' : 'dom-styler-rules.json';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      toast('exported ' + count + ' rule' + (count === 1 ? '' : 's'));
    } catch (e) {
      toast('export failed: ' + e.message, true);
    }
  }

  el.exportAll.addEventListener('click', () => download(null));
  el.importAll.addEventListener('click', () => el.importFile.click());
  el.importFile.addEventListener('change', async (ev) => {
    const file = ev.target.files && ev.target.files[0];
    ev.target.value = '';
    if (!file) return;
    banner('');
    try {
      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch (e) {
        throw new Error('that file is not valid JSON');
      }
      const report = await Storage.importAll(payload, { merge: true });
      await notifyChanged(null);
      toast('imported ' + report.rules + ' rule' + (report.rules === 1 ? '' : 's')
        + (report.skipped ? ', skipped ' + report.skipped : ''));
      await load();
    } catch (e) {
      banner('Import failed: ' + e.message);
    }
  });

  /* ---------------------------------------------------------------- filters + sort wiring */

  let debounce = null;
  el.fText.addEventListener('input', () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => { debounce = null; render(); }, 130);
  });
  for (const s of [el.fScope, el.fMode, el.fEnabled, el.fStatus]) {
    s.addEventListener('change', render);
  }
  el.fClear.addEventListener('click', () => {
    el.fText.value = '';
    el.fScope.value = '';
    el.fMode.value = '';
    el.fEnabled.value = '';
    el.fStatus.value = '';
    render();
  });

  for (const th of document.querySelectorAll('th.sortable')) {
    th.addEventListener('click', () => {
      const k = th.dataset.sort;
      if (sortKey === k) sortDir = -sortDir;
      else { sortKey = k; sortDir = 1; }
      render();
    });
  }

  el.globalEnabled.addEventListener('change', async () => {
    await Storage.setSettings({ enabled: el.globalEnabled.checked });
    await notifyChanged(null);
    toast(el.globalEnabled.checked ? 'styling on' : 'styling off');
  });

  /* Another window may have changed things; keep this page honest. */
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    const relevant = Object.keys(changes).some(
      (k) => k.startsWith(Storage.RULES_PREFIX) || k === 'settings');
    if (relevant && !editingId) load();
  });

  load().catch((e) => banner('Failed to load: ' + e.message));
})();
