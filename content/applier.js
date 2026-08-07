/*
 * content/applier.js — makes saved rules take effect, and keeps them in effect.
 *
 * Runs at document_start on every page, so cost matters: see the tier-0 cache in
 * selector-engine.js, which is what makes the steady-state mutation path ~80 property reads.
 *
 * Two-stage injection, to avoid a flash of unstyled content:
 *   stage 1 (now, before <head> exists)  raw selectors for rules whose selector is plain and safe
 *   stage 2 (DOM ready + every mutation) JS-resolved elements, stamped and styled by marker
 *
 * Stage 2 exists because the fingerprint — parent, grandparent, siblings, text, scoring — cannot
 * be expressed as a CSS selector. So we resolve in JS, stamp data-dom-styler on the winner, and
 * let CSS target the stamp.
 */
(function () {
  'use strict';

  const NS = (window.DomStyler = window.DomStyler || {});
  if (NS.applierLoaded) return;
  NS.applierLoaded = true;

  const Storage = globalThis.DomStylerStorage;
  const Css = globalThis.DomStylerCss;
  const Engine = NS.SelectorEngine;

  if (!Storage || !Css || !Engine) {
    console.warn('[DOM Styler] applier: dependencies missing, standing down');
    return;
  }

  const STYLE_FAST_ID = 'dom-styler-fast';
  const STYLE_MAIN_ID = 'dom-styler-main';
  const STYLE_PREVIEW_ID = 'dom-styler-preview';
  const MARKER = 'data-dom-styler';
  const PREVIEW_RULE_ID = 'preview';

  const DEBOUNCE_MS = 150;
  const DIAG_THROTTLE_MS = 5000;

  /* An XML or image document has no head to inject into and no page to style. */
  if (!document.documentElement) return;
  if (document.contentType && !/html|xml/i.test(document.contentType)) return;
  if (Storage.isRestrictedUrl(location.href)) return;

  let rules = [];
  let stamped = new Map();        // ruleId -> Element currently carrying the marker
  let batch = 0;
  let observer = null;
  let debounceTimer = null;
  let previewCss = null;
  let previewRecord = null;
  let lastDiagWrite = 0;
  let diagPending = new Map();   // ruleId -> { scopeKey, info }

  /* ---------------------------------------------------------------- style plumbing */

  function ensureStyle(id) {
    let el = document.getElementById(id);
    if (el && el.tagName === 'STYLE') return el;
    el = document.createElement('style');
    el.id = id;
    el.setAttribute('type', 'text/css');
    // At document_start document.head is null; documentElement always exists by now.
    (document.head || document.documentElement).appendChild(el);
    return el;
  }

  /*
   * Style writes are themselves mutations. Every write goes through here so the observer is
   * always detached across it — see the note on the observer below.
   */
  function writeStyle(id, cssText) {
    withObserverPaused(() => {
      const el = ensureStyle(id);
      if (el.textContent !== cssText) el.textContent = cssText;
    });
  }

  function removeStyle(id) {
    withObserverPaused(() => {
      const el = document.getElementById(id);
      if (el) el.remove();
    });
  }

  /* ---------------------------------------------------------------- stage 1: anti-FOUC */

  function fastPathCss(list) {
    const out = [];
    for (const rule of list) {
      if (!rule.enabled) continue;
      const fp = rule.fingerprint;
      if (!fp || !Array.isArray(fp.sel)) continue;
      const cand = fp.sel.find((c) => c.flash && c.n === 1);
      if (!cand) continue;
      const compiled = Css.compile(rule.css, cand.s);
      if (compiled.ok && compiled.text) out.push(compiled.text);
    }
    return out.join('\n');
  }

  /* ---------------------------------------------------------------- stage 2: resolve + stamp */

  function markerTokens(el) {
    const v = el.getAttribute(MARKER);
    return v ? v.trim().split(/\s+/).filter(Boolean) : [];
  }

  function addMarker(el, ruleId) {
    const tokens = markerTokens(el);
    if (tokens.includes(ruleId)) return;
    tokens.push(ruleId);
    el.setAttribute(MARKER, tokens.join(' '));
  }

  function removeMarker(el, ruleId) {
    if (!el || !el.getAttribute) return;
    const tokens = markerTokens(el).filter((t) => t !== ruleId);
    if (tokens.length) el.setAttribute(MARKER, tokens.join(' '));
    else el.removeAttribute(MARKER);
  }

  function apply() {
    batch++;
    const cssParts = [];
    const nextStamped = new Map();

    withObserverPaused(() => {
      for (const rule of rules) {
        if (!rule.enabled) {
          releaseStamp(rule.id);
          continue;
        }
        const res = Engine.resolve(rule.fingerprint, { ruleId: rule.id, batch });

        if (!res.el) {
          if (res.reason !== 'BACKOFF') {
            releaseStamp(rule.id);
            queueDiag(rule, { matched: false, reason: res.reason });
          } else {
            // Backing off: keep whatever is currently stamped rather than thrashing.
            const prev = stamped.get(rule.id);
            if (prev && prev.isConnected) {
              nextStamped.set(rule.id, prev);
              pushCss(cssParts, rule);
            }
          }
          continue;
        }

        const prev = stamped.get(rule.id);
        if (prev && prev !== res.el) removeMarker(prev, rule.id);
        addMarker(res.el, rule.id);
        nextStamped.set(rule.id, res.el);
        pushCss(cssParts, rule);
        queueDiag(rule, { matched: true, score: res.score, via: res.via });
      }

      // Anything stamped last pass and not this one loses its marker.
      for (const [ruleId, el] of stamped) {
        if (!nextStamped.has(ruleId)) removeMarker(el, ruleId);
      }
      stamped = nextStamped;
    });

    writeStyle(STYLE_MAIN_ID, cssParts.join('\n'));
    // Once JS has resolved everything, the raw fast-path rules are redundant and could only
    // disagree with the verified result.
    if (cssParts.length || rules.length) removeStyle(STYLE_FAST_ID);
    flushDiag();
    applyPreview();
  }

  function pushCss(parts, rule) {
    const compiled = Css.compile(rule.css, Css.markerFor(rule.id));
    if (compiled.ok && compiled.text) parts.push(compiled.text);
  }

  function releaseStamp(ruleId) {
    const el = stamped.get(ruleId);
    if (el) removeMarker(el, ruleId);
    stamped.delete(ruleId);
  }

  /* ---------------------------------------------------------------- live preview (unsaved) */

  function applyPreview() {
    if (previewCss === null) {
      removeStyle(STYLE_PREVIEW_ID);
      return;
    }
    const fp = previewRecord;
    if (!fp) {
      removeStyle(STYLE_PREVIEW_ID);
      return;
    }
    withObserverPaused(() => {
      const res = Engine.resolve(fp, { ruleId: PREVIEW_RULE_ID, batch });
      const prev = stamped.get(PREVIEW_RULE_ID);
      if (prev && prev !== res.el) removeMarker(prev, PREVIEW_RULE_ID);
      if (res.el) {
        addMarker(res.el, PREVIEW_RULE_ID);
        stamped.set(PREVIEW_RULE_ID, res.el);
      } else {
        stamped.delete(PREVIEW_RULE_ID);
      }
    });
    const compiled = Css.compile(previewCss, Css.markerFor(PREVIEW_RULE_ID));
    writeStyle(STYLE_PREVIEW_ID, compiled.ok ? compiled.text : '');
  }

  function clearPreview() {
    previewCss = null;
    previewRecord = null;
    releaseStamp(PREVIEW_RULE_ID);
    Engine.invalidate(PREVIEW_RULE_ID);
    removeStyle(STYLE_PREVIEW_ID);
  }

  /* ---------------------------------------------------------------- diagnostics */

  function queueDiag(rule, info) {
    const prev = rule.lastResolved;
    // Only worth a write if the outcome actually changed.
    if (prev && prev.matched === info.matched && prev.via === (info.via || null)
        && prev.reason === (info.reason || null)) return;
    diagPending.set(rule.id, { scopeKey: rule.scopeKey, info });
  }

  function flushDiag() {
    if (!diagPending.size) return;
    const now = Date.now();
    if (now - lastDiagWrite < DIAG_THROTTLE_MS) return;
    lastDiagWrite = now;
    const pending = diagPending;
    diagPending = new Map();
    (async () => {
      for (const [ruleId, { scopeKey, info }] of pending) {
        try {
          await Storage.setLastResolved(scopeKey, ruleId, info);
        } catch (e) { /* diagnostics are best-effort */ }
      }
    })();
  }

  /* ---------------------------------------------------------------- observer
   *
   * THE SELF-MUTATION LOOP, and why this is not one:
   *
   * apply() stamps data-dom-styler on elements and writes into its own <style>. Both are
   * mutations the observer would see, which would schedule another apply(), which would stamp
   * again — an infinite loop pinning a CPU core on every page.
   *
   * The guard is structural rather than filter-based: every write this file performs is wrapped
   * in withObserverPaused(), which disconnects the observer, runs the writes, drains the queue
   * with takeRecords() so nothing that happened while paused is delivered, then reconnects.
   * takeRecords() is the important half — disconnect() alone still leaves already-queued
   * records to be delivered on reconnect.
   *
   * onMutation additionally ignores records that could only have come from us, which covers the
   * case of a nested/re-entrant write.
   */

  let paused = 0;

  function withObserverPaused(fn) {
    paused++;
    if (observer) observer.disconnect();
    try {
      fn();
    } catch (e) {
      console.warn('[DOM Styler] apply failed', e);
    } finally {
      paused--;
      if (observer && paused === 0) {
        observer.takeRecords();
        observe();
      }
    }
  }

  function isOurs(node) {
    if (!node || node.nodeType !== 1) return false;
    return node.id === STYLE_MAIN_ID || node.id === STYLE_FAST_ID || node.id === STYLE_PREVIEW_ID
      || node.id === 'dom-styler-picker-root';
  }

  function relevant(records) {
    for (const r of records) {
      if (r.type === 'attributes') {
        if (r.attributeName === MARKER) continue;
        if (isOurs(r.target)) continue;
        return true;
      }
      if (r.type === 'childList') {
        if (isOurs(r.target)) continue;
        for (const n of r.addedNodes) if (n.nodeType === 1 && !isOurs(n)) return true;
        for (const n of r.removedNodes) if (n.nodeType === 1 && !isOurs(n)) return true;
      }
    }
    return false;
  }

  function onMutation(records) {
    if (paused > 0) return;
    if (!relevant(records)) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // The page may have ripped our style element out; apply() recreates it.
      apply();
    }, DEBOUNCE_MS);
  }

  function observe() {
    if (!observer) observer = new MutationObserver(onMutation);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['id', 'class', 'data-testid', 'data-test-id', 'data-test',
        'aria-label', 'name', 'href', 'role', 'type'],
    });
  }

  /* ---------------------------------------------------------------- SPA route changes */

  function onRouteChange() {
    // A route change is exactly when a previously-missing element is likely to reappear, so
    // clear the miss backoff and take a fresh full attempt.
    Engine.resetBackoff();
    load();
  }

  function hookHistory() {
    for (const name of ['pushState', 'replaceState']) {
      const original = history[name];
      if (typeof original !== 'function' || original.__domStylerHooked) continue;
      const wrapped = function () {
        const r = original.apply(this, arguments);
        try {
          setTimeout(onRouteChange, 0);
        } catch (e) { /* ignore */ }
        return r;
      };
      wrapped.__domStylerHooked = true;
      history[name] = wrapped;
    }
    window.addEventListener('popstate', () => setTimeout(onRouteChange, 0), true);
    window.addEventListener('hashchange', () => setTimeout(onRouteChange, 0), true);
  }

  /* ---------------------------------------------------------------- lifecycle */

  let lastUrl = location.href;

  async function load() {
    try {
      const settings = await Storage.getSettings();
      if (!settings.enabled) {
        rules = [];
        withObserverPaused(() => {
          for (const id of Array.from(stamped.keys())) releaseStamp(id);
        });
        removeStyle(STYLE_FAST_ID);
        removeStyle(STYLE_MAIN_ID);
        return;
      }
      const fetched = await Storage.getRulesForUrl(location.href);
      // Rule ids can change out from under the cache when rules are edited.
      const seen = new Set(fetched.map((r) => r.id));
      for (const id of Array.from(stamped.keys())) {
        if (id !== PREVIEW_RULE_ID && !seen.has(id)) {
          withObserverPaused(() => releaseStamp(id));
          Engine.invalidate(id);
        }
      }
      rules = fetched;
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        Engine.reset();
        stamped = new Map();
      }
    } catch (e) {
      console.warn('[DOM Styler] failed to load rules', e);
      return;
    }

    if (!document.documentElement) return;

    if (!document.body) {
      // Still at document_start: emit what pure CSS can express, then wait for the DOM.
      const fast = fastPathCss(rules);
      if (fast) writeStyle(STYLE_FAST_ID, fast);
      return;
    }
    apply();
  }

  function start() {
    hookHistory();
    load();

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => {
        observe();
        load();
      }, { once: true });
    } else {
      observe();
    }
    window.addEventListener('load', () => load(), { once: true });
  }

  /* ---------------------------------------------------------------- messaging */

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (!msg || typeof msg.type !== 'string') return undefined;

    switch (msg.type) {
      case 'DS_RULES_CHANGED':
        Engine.resetBackoff();
        load().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }));
        return true;

      case 'DS_PREVIEW':
        previewCss = typeof msg.css === 'string' ? msg.css : '';
        previewRecord = msg.fingerprint || previewRecord;
        applyPreview();
        sendResponse({ ok: true });
        return true;

      case 'DS_PREVIEW_CLEAR':
        clearPreview();
        sendResponse({ ok: true });
        return true;

      case 'DS_GET_STATUS': {
        const out = rules.map((r) => {
          // probe: read-only, so opening the popup cannot disturb the retry backoff.
          const res = Engine.resolve(r.fingerprint, { ruleId: r.id, batch, probe: true });
          return {
            id: r.id,
            matched: !!res.el,
            score: res.el ? res.score : null,
            via: res.el ? res.via : null,
            reason: res.el ? null : res.reason,
          };
        });
        sendResponse({ ok: true, url: location.href, statuses: out });
        return true;
      }

      /*
       * The DevTools sidebar marked its $0 with an attribute from the page's main world; find
       * that node here in the isolated world, where the selector engine lives, and strip the
       * marker again. The DOM is the only thing the two worlds share, which is why the handoff
       * goes through an attribute rather than a message payload.
       */
      case 'DS_CAPTURE_MARKED': {
        const attr = typeof msg.attr === 'string' && /^[\w-]+$/.test(msg.attr) ? msg.attr : null;
        if (!attr) {
          sendResponse({ ok: false, error: 'bad marker attribute' });
          return true;
        }
        const target = document.querySelector('[' + attr + ']');
        if (!target) {
          sendResponse({ ok: false, error: 'the marked element is not in this document' });
          return true;
        }
        target.removeAttribute(attr);

        let fp;
        try {
          fp = Engine.capture(target);
        } catch (err) {
          sendResponse({ ok: false, error: 'capture failed: ' + err.message });
          return true;
        }
        if (fp && fp.error) {
          sendResponse({ ok: false, error: fp.error });
          return true;
        }

        let check = { el: null, reason: 'UNKNOWN' };
        try {
          Engine.invalidate('__probe');
          check = Engine.resolve(fp, { ruleId: '__probe', batch: 0 });
        } catch (err) { /* reported as unverified below */ }
        Engine.invalidate('__probe');

        const r = target.getBoundingClientRect();
        sendResponse({
          ok: true,
          payload: {
            fingerprint: fp,
            describe: Engine.describe(fp),
            url: location.href,
            verified: check.el === target,
            verifyVia: check.el ? check.via : null,
            verifyScore: check.el ? check.score : null,
            verifyReason: check.el ? null : check.reason,
            rect: { w: Math.round(r.width), h: Math.round(r.height) },
          },
        });
        return true;
      }

      case 'DS_PING':
        sendResponse({ ok: true, applier: true });
        return true;

      default:
        return undefined;
    }
  });

  NS.applier = { apply, load, clearPreview };

  start();
})();
