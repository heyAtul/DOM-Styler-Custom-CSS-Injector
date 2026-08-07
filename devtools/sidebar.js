/*
 * devtools/sidebar.js — the "DOM Styler" pane in the Elements sidebar.
 *
 * HOW $0 CROSSES WORLDS
 *
 * chrome.devtools.inspectedWindow.eval runs in the page's MAIN world. The selector engine lives
 * in the content script's ISOLATED world. The two have different `window` objects, so the node
 * `$0` refers to cannot simply be handed over — stashing it on the page's window is invisible to
 * the content script, and passing it through a message would serialize it to a plain object and
 * lose the live node.
 *
 * What the two worlds DO share is the DOM itself. So: eval marks $0 with a temporary attribute,
 * then the content script finds the marked node by attribute selector, captures it, and strips
 * the attribute again. No serialization, no cross-world reference, and it works regardless of
 * whether the Command Line API is available in the content-script context.
 *
 * The marker attribute is deliberately not in the applier's MutationObserver attributeFilter, so
 * setting it cannot trigger a re-apply pass.
 */
(function () {
  'use strict';

  const Storage = globalThis.DomStylerStorage;
  const Css = globalThis.DomStylerCss;

  const PICK_ATTR = 'data-dom-styler-devtools-pick';
  const tabId = chrome.devtools.inspectedWindow.tabId;

  const $ = (id) => document.getElementById(id);
  const el = {
    banner: $('sb-banner'),
    none: $('sb-none'),
    body: $('sb-body'),
    desc: $('sb-desc'),
    meta: $('sb-meta'),
    detail: $('sb-detail'),
    detailBody: $('sb-detail-body'),
    css: $('sb-css'),
    error: $('sb-error'),
    save: $('sb-save'),
    mode: $('sb-mode'),
    count: $('sb-count'),
    viewAll: $('sb-view-all'),
    list: $('sb-list'),
    toast: $('sb-toast'),
  };

  let capture = null;         // { fingerprint, describe, url, verified, ... }
  let pageUrl = '';
  let previewTimer = null;
  let editingRuleId = null;

  /* ---------------------------------------------------------------- small helpers */

  function toast(text, bad) {
    el.toast.textContent = text;
    el.toast.classList.toggle('bad', !!bad);
    el.toast.hidden = false;
    setTimeout(() => { el.toast.hidden = true; }, 1800);
  }

  function banner(text, bad) {
    if (!text) { el.banner.hidden = true; return; }
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

  /* A devtools page cannot call chrome.tabs.*; everything tab-directed goes via the worker. */
  function toWorker(msg) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(msg, (res) => {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch (e) {
        resolve(null);
      }
    });
  }

  function evalInPage(expr) {
    return new Promise((resolve) => {
      chrome.devtools.inspectedWindow.eval(expr, (result, info) => {
        if (info && (info.isError || info.isException)) resolve({ error: info.value || 'eval failed' });
        else resolve({ value: result });
      });
    });
  }

  /* ---------------------------------------------------------------- selection */

  async function onSelectionChanged() {
    banner('');

    /*
     * Mark $0 in the page's own world. Returning a string rather than the node keeps the result
     * serializable. `void 0` guards against a $0 that is a text node or has no setAttribute.
     */
    const marked = await evalInPage(
      '(function(){' +
      'try {' +
      ' if (!window.$0 && typeof $0 === "undefined") return "no-selection";' +
      ' var n = $0;' +
      ' if (!n || n.nodeType !== 1) return "not-an-element";' +
      ' var prev = document.querySelectorAll("[' + PICK_ATTR + ']");' +
      ' for (var i = 0; i < prev.length; i++) prev[i].removeAttribute("' + PICK_ATTR + '");' +
      ' n.setAttribute("' + PICK_ATTR + '", "1");' +
      ' return "ok";' +
      '} catch (e) { return "error:" + e.message }' +
      '})()'
    );

    if (marked.error) {
      showNone('DevTools could not read the selection: ' + marked.error);
      return;
    }
    if (marked.value === 'no-selection') { showNone(); return; }
    if (marked.value === 'not-an-element') {
      showNone('That selection is not an element — pick an element node.');
      return;
    }
    if (typeof marked.value === 'string' && marked.value.startsWith('error:')) {
      showNone('DevTools could not mark the selection: ' + marked.value.slice(6));
      return;
    }

    // Now the isolated world captures the marked node with the real selector engine.
    const res = await toWorker({ type: 'DS_DEVTOOLS_CAPTURE', tabId, attr: PICK_ATTR });

    if (!res || !res.ok) {
      const why = (res && res.error) || 'the page has no DOM Styler content script yet';
      showNone('Could not capture that element: ' + why + '. Reload the page and try again.');
      return;
    }

    capture = res.payload;
    pageUrl = capture.url || '';
    editingRuleId = null;
    el.css.value = '';
    el.error.hidden = true;
    render();
    await renderRules();
  }

  function showNone(msg) {
    capture = null;
    el.body.hidden = true;
    el.none.hidden = false;
    el.none.textContent = msg || 'Select an element in the Elements tree.';
  }

  function render() {
    el.none.hidden = true;
    el.body.hidden = false;

    const fp = capture.fingerprint;
    el.desc.textContent = capture.describe || '(element)';
    el.desc.title = capture.describe || '';

    el.meta.textContent = '';
    if (fp.idOk) el.meta.appendChild(tag('unique id: ' + fp.id, 'ok'));
    else if (fp.id) el.meta.appendChild(tag('id "' + fp.id + '" not reliable', 'warn'));
    else el.meta.appendChild(tag('no id', 'warn'));

    if (capture.verified) {
      el.meta.appendChild(tag('re-found ' + Math.round((capture.verifyScore || 0) * 100)
        + '% via ' + capture.verifyVia, 'ok'));
    } else {
      el.meta.appendChild(tag('could not re-find: ' + (capture.verifyReason || '?'), 'bad'));
    }
    if (fp.hosts) el.meta.appendChild(tag('inside shadow DOM', 'warn'));

    renderDetail(fp);
  }

  /* Same breakdown the popup shows: what was stored, and which selectors will be tried. */
  function renderDetail(fp) {
    const body = el.detailBody;
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

  /* ---------------------------------------------------------------- css + save */

  function onCssInput() {
    const compiled = Css.compile(el.css.value, Css.markerFor(editingRuleId || 'preview'));
    if (compiled.errors.length) {
      el.error.textContent = compiled.errors.join('; ');
      el.error.hidden = false;
    } else {
      el.error.hidden = true;
    }
    if (previewTimer) clearTimeout(previewTimer);
    previewTimer = setTimeout(() => {
      previewTimer = null;
      if (!capture) return;
      toWorker({
        type: 'DS_RELAY_TO_TAB',
        tabId,
        message: { type: 'DS_PREVIEW', css: el.css.value, fingerprint: capture.fingerprint },
      });
    }, 220);
  }

  function scopeKey() {
    return pageUrl ? Storage.scopeKeyFor(pageUrl, el.mode.value) : null;
  }

  async function save() {
    const css = el.css.value.trim();
    if (!css) { toast('nothing to save', true); return; }
    const compiled = Css.compile(css, Css.markerFor('x'));
    if (!compiled.ok) {
      el.error.textContent = compiled.errors.join('; ');
      el.error.hidden = false;
      toast('fix the CSS first', true);
      return;
    }
    const key = scopeKey();
    if (!key) { toast('cannot save on this page', true); return; }

    try {
      if (editingRuleId) {
        await Storage.updateRule(key, editingRuleId, { css });
      } else {
        await Storage.addRule(key, {
          css,
          fingerprint: capture.fingerprint,
          label: capture.describe || '',
          matchMode: el.mode.value,
          enabled: true,
        });
      }
    } catch (e) {
      toast('save failed: ' + e.message, true);
      return;
    }

    await toWorker({ type: 'DS_RELAY_TO_TAB', tabId, message: { type: 'DS_PREVIEW_CLEAR' } });
    await toWorker({ type: 'DS_RULES_SAVED', scopeKey: key });
    editingRuleId = null;
    el.css.value = '';
    toast('saved');
    await renderRules();
  }

  /* ---------------------------------------------------------------- rules list */

  async function renderRules() {
    const key = scopeKey();
    const rules = key ? await Storage.getRules(key) : [];
    el.count.textContent = rules.length ? 'Rules here (' + rules.length + ')' : 'No rules here yet';
    el.list.textContent = '';

    for (const rule of rules) {
      const li = document.createElement('li');
      if (!rule.enabled) li.className = 'off';

      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = rule.enabled;
      cb.addEventListener('change', async () => {
        await Storage.toggleRule(key, rule.id, cb.checked);
        await toWorker({ type: 'DS_RULES_SAVED', scopeKey: key });
        await renderRules();
      });

      const body = document.createElement('div');
      body.className = 'rule-body';
      const sel = document.createElement('div');
      sel.className = 'rule-sel';
      sel.textContent = rule.label || '(element)';
      sel.title = rule.label || '';
      const cssLine = document.createElement('div');
      cssLine.className = 'rule-css';
      cssLine.textContent = rule.css.replace(/\s+/g, ' ').trim();
      cssLine.title = rule.css;
      body.append(sel, cssLine);

      const actions = document.createElement('div');
      actions.className = 'rule-actions';
      const edit = document.createElement('button');
      edit.className = 'link';
      edit.textContent = 'edit';
      edit.addEventListener('click', () => {
        editingRuleId = rule.id;
        capture = { fingerprint: rule.fingerprint, describe: rule.label, verified: true, verifyVia: 'saved', verifyScore: 1 };
        render();
        el.css.value = rule.css;
        el.css.focus();
        onCssInput();
      });
      const del = document.createElement('button');
      del.className = 'link';
      del.textContent = 'delete';
      del.addEventListener('click', async () => {
        await Storage.deleteRule(key, rule.id);
        await toWorker({ type: 'DS_RULES_SAVED', scopeKey: key });
        toast('deleted');
        await renderRules();
      });
      actions.append(edit, del);

      li.append(cb, body, actions);
      el.list.appendChild(li);
    }
  }

  /* ---------------------------------------------------------------- init */

  el.save.addEventListener('click', save);
  el.css.addEventListener('input', onCssInput);
  el.css.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save(); }
  });
  el.mode.addEventListener('change', renderRules);
  el.viewAll.addEventListener('click', () => {
    // openOptionsPage is not available to devtools pages; the worker opens the tab for us.
    toWorker({ type: 'DS_OPEN_OPTIONS' });
  });

  chrome.devtools.panels.elements.onSelectionChanged.addListener(onSelectionChanged);

  Storage.getSettings().then((s) => { el.mode.value = s.defaultMatchMode; });

  // DevTools may already have a selection when the pane first loads.
  onSelectionChanged();
})();
