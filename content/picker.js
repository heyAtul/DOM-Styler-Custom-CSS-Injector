/*
 * content/picker.js — the click-to-select overlay.
 *
 * Injected on demand by the service worker (not listed in the manifest), which is why it can
 * assume window.DomStyler.SelectorEngine is already present from the manifest content scripts.
 *
 * Injecting twice must not create two overlays, and the same injected script may be reactivated
 * later, so activate/deactivate are exposed on window.DomStyler.Picker and the module-level
 * state is created once.
 */
(function () {
  'use strict';

  const NS = (window.DomStyler = window.DomStyler || {});
  if (NS.Picker) {
    // Already injected: this is a re-activation.
    NS.Picker.activate();
    return;
  }

  const Engine = NS.SelectorEngine;
  if (!Engine) {
    console.warn('[DOM Styler] picker: selector engine missing');
    return;
  }

  const HOST_ID = 'dom-styler-picker-root';

  let host = null;
  let root = null;          // the closed ShadowRoot
  let ui = null;            // { box, label, crumbs, hint }
  let active = false;
  let current = null;       // the element that would be picked
  let hoverTarget = null;   // the element actually under the cursor

  /*
   * Keyboard navigation has to survive the mouse. Without this, an arrow key moves the
   * selection to the parent and the very next mousemove — including the one the browser fires
   * when the overlay repaints under a stationary cursor — snaps it back to whatever is under
   * the pointer, so the arrow keys look broken. Once a key is used, mousemove is ignored until
   * the pointer genuinely travels MOUSE_WAKE_PX.
   */
  const MOUSE_WAKE_PX = 8;
  let kbMode = false;
  let lastX = null;
  let lastY = null;

  const SHADOW_CSS = `
    :host { all: initial; }
    * { box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI",
        system-ui, sans-serif; }
    .box {
      position: fixed; pointer-events: none;
      border: 2px solid #2f6feb;
      background: rgba(47,111,235,.14);
      border-radius: 2px;
      transition: all .04s linear;
    }
    .label {
      position: fixed; pointer-events: none;
      max-width: 60vw; padding: 3px 7px;
      font-size: 11px; line-height: 1.45; font-weight: 500;
      color: #fff; background: #2f6feb;
      border-radius: 3px; white-space: nowrap;
      overflow: hidden; text-overflow: ellipsis;
      box-shadow: 0 1px 4px rgba(0,0,0,.35);
    }
    .label .dim { opacity: .75; font-weight: 400; }
    .bar {
      position: fixed; left: 0; right: 0; bottom: 0;
      pointer-events: auto;
      display: flex; flex-direction: column; gap: 4px;
      padding: 8px 10px;
      font-size: 11px; color: #e8eaed;
      background: rgba(24,26,30,.96);
      border-top: 1px solid rgba(255,255,255,.14);
      box-shadow: 0 -2px 12px rgba(0,0,0,.4);
    }
    .crumbs { display: flex; flex-wrap: wrap; gap: 3px; align-items: center; }
    .crumb {
      pointer-events: auto; cursor: pointer;
      padding: 2px 6px; border-radius: 3px;
      background: rgba(255,255,255,.09); color: #e8eaed;
      border: 1px solid transparent;
      font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px;
      max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .crumb:hover { background: rgba(255,255,255,.18); }
    .crumb.on { background: #2f6feb; border-color: #7aa2f7; color: #fff; }
    .sep { opacity: .4; }
    .hint { display: flex; gap: 14px; flex-wrap: wrap; opacity: .72; font-size: 10.5px; }
    .hint b { font-weight: 600; opacity: 1; }
    .warn { color: #ffb454; }
    .mode { color: #7aa2f7; }
  `;

  function build() {
    host = document.getElementById(HOST_ID);
    if (!host) {
      host = document.createElement('div');
      host.id = HOST_ID;
      (document.body || document.documentElement).appendChild(host);
    }
    // Closed: the page cannot reach in via host.shadowRoot to tamper with the overlay.
    root = host.attachShadow({ mode: 'closed' });

    const style = document.createElement('style');
    style.textContent = SHADOW_CSS;
    root.appendChild(style);

    const box = document.createElement('div');
    box.className = 'box';
    const label = document.createElement('div');
    label.className = 'label';
    const bar = document.createElement('div');
    bar.className = 'bar';
    const crumbs = document.createElement('div');
    crumbs.className = 'crumbs';
    const hint = document.createElement('div');
    hint.className = 'hint';
    bar.append(crumbs, hint);
    root.append(box, label, bar);

    ui = { box, label, crumbs, hint, bar };
    renderHint();
  }

  function renderHint(extra) {
    if (!ui) return;
    ui.hint.textContent = '';
    const items = kbMode
      ? [['enter', 'select'], ['↑↓', 'parent / child'], ['←→', 'sibling'], ['esc', 'cancel']]
      : [['click', 'select'], ['↑↓', 'parent / child'], ['←→', 'sibling'], ['esc', 'cancel']];
    for (const [k, v] of items) {
      const b = document.createElement('b');
      b.textContent = k;
      const span = document.createElement('span');
      span.append(b, document.createTextNode(' ' + v));
      ui.hint.appendChild(span);
    }
    if (kbMode) {
      const m = document.createElement('span');
      m.className = 'mode';
      m.textContent = 'keyboard — move the mouse to go back to hover';
      ui.hint.appendChild(m);
    }
    if (extra) {
      const w = document.createElement('span');
      w.className = 'warn';
      w.textContent = extra;
      ui.hint.appendChild(w);
    }
  }

  /* ---------------------------------------------------------------- highlight */

  function isOurs(node) {
    return !!node && (node === host || node.id === HOST_ID);
  }

  function shortLabel(el) {
    let s = el.localName;
    const id = el.getAttribute('id');
    if (id) s += '#' + id;
    const cls = Engine.classTokens(el).slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    if (Engine.classTokens(el).length > 3) s += '…';
    return s;
  }

  function paint(el) {
    if (!el || !el.getBoundingClientRect) return;
    const r = el.getBoundingClientRect();
    const { box, label } = ui;

    box.style.left = r.left + 'px';
    box.style.top = r.top + 'px';
    box.style.width = Math.max(0, r.width) + 'px';
    box.style.height = Math.max(0, r.height) + 'px';

    label.textContent = '';
    label.appendChild(document.createTextNode(shortLabel(el)));
    const dim = document.createElement('span');
    dim.className = 'dim';
    dim.textContent = '  ' + Math.round(r.width) + ' × ' + Math.round(r.height);
    label.appendChild(dim);

    // Keep the label on screen: below the element normally, above when there is no room.
    const lh = 20;
    let top = r.top - lh - 2;
    if (top < 2) top = Math.min(r.bottom + 2, window.innerHeight - lh - 2);
    let left = r.left;
    const maxLeft = window.innerWidth - Math.min(label.offsetWidth || 160, window.innerWidth * 0.6) - 6;
    if (left > maxLeft) left = Math.max(2, maxLeft);
    if (left < 2) left = 2;
    label.style.top = top + 'px';
    label.style.left = left + 'px';

    renderCrumbs(el);
  }

  function renderCrumbs(el) {
    const chain = [];
    for (let n = el; n && n !== document.documentElement && chain.length < 8; n = n.parentElement) {
      chain.unshift(n);
    }
    ui.crumbs.textContent = '';
    chain.forEach((n, i) => {
      if (i) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '›';
        ui.crumbs.appendChild(sep);
      }
      const c = document.createElement('span');
      c.className = 'crumb' + (n === el ? ' on' : '');
      c.textContent = shortLabel(n);
      c.title = shortLabel(n);
      c.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        setCurrent(n);
      }, true);
      ui.crumbs.appendChild(c);
    });
  }

  function setCurrent(el) {
    if (!el || el === host) return;
    current = el;
    paint(el);
  }

  /* ---------------------------------------------------------------- events */

  function onMouseMove(e) {
    if (!active) return;
    // Our host is pointer-events:none, but the bottom bar is not; a shadow-retargeted event
    // reports the host as target, which is how we tell "cursor is over our own UI".
    if (isOurs(e.target)) return;

    if (kbMode) {
      if (lastX !== null
          && Math.abs(e.clientX - lastX) < MOUSE_WAKE_PX
          && Math.abs(e.clientY - lastY) < MOUSE_WAKE_PX) {
        return;                       // jitter, or a repaint-induced event: keep the keyboard pick
      }
      kbMode = false;
      renderHint();
    }
    lastX = e.clientX;
    lastY = e.clientY;
    hoverTarget = e.target;
    setCurrent(e.target);
  }

  function onClick(e) {
    if (!active) return;
    if (isOurs(e.target)) return;   // breadcrumb clicks are handled by their own listener
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    commit(current || e.target);
  }

  // A page can navigate on mousedown/mouseup/pointerdown too, so swallow the whole sequence.
  function swallow(e) {
    if (!active) return;
    if (isOurs(e.target)) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function onKeyDown(e) {
    if (!active) return;
    // Bound on both window and document (capture) so a page handler on either is less likely
    // to swallow the key first; this flag keeps us from acting on the same event twice.
    if (e.__domStylerHandled) return;
    e.__domStylerHandled = true;

    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
      return;
    }
    if (!current) return;
    let next = null;
    switch (e.key) {
      case 'ArrowUp':
        next = current.parentElement;
        if (next === document.documentElement) next = null;
        break;
      case 'ArrowDown':
        next = current.firstElementChild;
        if (isOurs(next)) next = null;
        break;
      case 'ArrowLeft':
        next = current.previousElementSibling;
        if (isOurs(next)) next = null;
        break;
      case 'ArrowRight':
        next = current.nextElementSibling;
        if (isOurs(next)) next = null;
        break;
      case 'Enter':
        e.preventDefault();
        e.stopPropagation();
        commit(current);
        return;
      default:
        return;
    }
    e.preventDefault();
    e.stopPropagation();
    if (!kbMode) {
      kbMode = true;
      renderHint();
    }
    if (next) setCurrent(next);
    else flashHint('no ' + directionName(e.key) + ' from here');
  }

  function directionName(key) {
    switch (key) {
      case 'ArrowUp': return 'parent';
      case 'ArrowDown': return 'child';
      case 'ArrowLeft': return 'previous sibling';
      default: return 'next sibling';
    }
  }

  let hintTimer = null;
  function flashHint(msg) {
    renderHint(msg);
    if (hintTimer) clearTimeout(hintTimer);
    hintTimer = setTimeout(() => { hintTimer = null; renderHint(); }, 1200);
  }

  function onScrollOrResize() {
    if (active && current) paint(current);
  }

  const LISTENERS = [
    ['mousemove', onMouseMove, true],
    ['click', onClick, true],
    ['mousedown', swallow, true],
    ['mouseup', swallow, true],
    ['pointerdown', swallow, true],
    ['pointerup', swallow, true],
    ['auxclick', swallow, true],
    ['contextmenu', swallow, true],
    ['dblclick', swallow, true],
    ['submit', swallow, true],
  ];

  function bind() {
    for (const [type, fn, capture] of LISTENERS) document.addEventListener(type, fn, capture);
    // window capture runs before document capture, giving the arrow keys the best chance of
    // arriving before the page's own key handling.
    window.addEventListener('keydown', onKeyDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('scroll', onScrollOrResize, true);
    window.addEventListener('resize', onScrollOrResize, true);
  }

  function unbind() {
    for (const [type, fn, capture] of LISTENERS) document.removeEventListener(type, fn, capture);
    window.removeEventListener('keydown', onKeyDown, true);
    document.removeEventListener('keydown', onKeyDown, true);
    window.removeEventListener('scroll', onScrollOrResize, true);
    window.removeEventListener('resize', onScrollOrResize, true);
  }

  /* ---------------------------------------------------------------- commit / cancel */

  function commit(el) {
    if (!el || el === host) return;
    let fp;
    try {
      fp = Engine.capture(el);
    } catch (err) {
      console.warn('[DOM Styler] capture threw', err);
      renderHint('capture failed: ' + err.message);
      return;
    }
    if (fp && fp.error) {
      renderHint(explain(fp.error));
      return;
    }

    // Confidence the user should see before styling anything: re-resolve immediately and check
    // we find the same node we just captured.
    let check = { el: null, reason: 'UNKNOWN' };
    try {
      Engine.invalidate('__probe');
      check = Engine.resolve(fp, { ruleId: '__probe', batch: 0 });
    } catch (err) { /* reported below as unverified */ }
    Engine.invalidate('__probe');

    const payload = {
      fingerprint: fp,
      describe: Engine.describe(fp),
      url: location.href,
      verified: check.el === el,
      verifyVia: check.el ? check.via : null,
      verifyScore: check.el ? check.score : null,
      verifyReason: check.el ? null : check.reason,
      rect: (() => { const r = el.getBoundingClientRect(); return { w: Math.round(r.width), h: Math.round(r.height) }; })(),
    };

    deactivate();
    try {
      chrome.runtime.sendMessage({ type: 'DS_PICKED', payload }, () => {
        // The service worker may already be asleep; the capture is persisted on its side, and a
        // dropped callback here is not an error worth surfacing.
        void chrome.runtime.lastError;
      });
    } catch (err) {
      console.warn('[DOM Styler] could not report the pick', err);
    }
  }

  function explain(code) {
    switch (code) {
      case 'SHADOW_CLOSED': return 'that element is inside a closed shadow root — it could never be found again, so it cannot be styled';
      case 'SHADOW_DETACHED': return 'that element is in a detached shadow tree';
      case 'SHADOW_TOO_DEEP': return 'that element is nested too deeply in shadow roots';
      case 'IFRAME_UNSUPPORTED': return 'elements inside iframes are not supported (pick the iframe itself)';
      case 'NOT_AN_ELEMENT': return 'that is not an element';
      default: return 'cannot capture that element (' + code + ')';
    }
  }

  function cancel() {
    deactivate();
    try {
      chrome.runtime.sendMessage({ type: 'DS_PICKER_CANCELLED' }, () => { void chrome.runtime.lastError; });
    } catch (e) { /* nothing to do */ }
  }

  function activate() {
    if (active) return;
    if (!root) build();
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
    active = true;
    kbMode = false;
    lastX = null;
    lastY = null;
    host.style.display = '';
    bind();
    renderHint();
  }

  function deactivate() {
    if (!active) return;
    active = false;
    unbind();
    if (hintTimer) { clearTimeout(hintTimer); hintTimer = null; }
    current = null;
    hoverTarget = null;
    kbMode = false;
    if (host) host.style.display = 'none';
  }

  NS.Picker = { activate, deactivate, isActive: () => active };

  activate();
})();
