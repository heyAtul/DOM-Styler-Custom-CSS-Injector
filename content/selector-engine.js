/*
 * content/selector-engine.js — element identity: capture, and re-resolution on a later visit.
 *
 * Exposes window.DomStyler.SelectorEngine. No DOM mutation and no chrome.* calls live here, so
 * every function below is testable in isolation.
 *
 * The governing rule, in priority order:
 *   1. never resolve to the WRONG element  (a wrong match silently restyles someone's page)
 *   2. keep matching after the site changes
 *   3. stay cheap enough to run at document_start on every page load
 *
 * Consequence of (1): a matching id is *evidence*, never proof. Duplicate ids are legal in
 * practice and a rebuilt page can legitimately move #panel onto a different node, so every
 * candidate — however it was found — is scored against the full fingerprint before it is
 * accepted. That is also why the parent/grandparent/sibling fingerprint is captured
 * unconditionally, even when the element has a perfectly good unique id.
 */
(function () {
  'use strict';

  const NS = (window.DomStyler = window.DomStyler || {});
  if (NS.SelectorEngine) return;

  const FP_V = 1;

  /* Every tunable in one place. */
  const C = {
    ANC_MAX: 5,            // ancestor levels stored in fp.path
    ANCHOR_MAX_UP: 12,     // how far up to look for a unique anchor
    ANCHOR_PROBES: 3,      // max uniqueness queries during the anchor hunt (pick time only)
    CLS_MAX: 4,            // stable classes stored for the target
    CLS_MAX_ANC: 2,        // stable classes stored per ancestor
    ATTR_MAX: 4,
    ATTR_VAL_MAX: 80,
    TXT_MAX: 64,
    SIB_TXT_MAX: 24,
    SEL_MAX: 6,
    SEL_LEN_MAX: 160,
    IDX_WALK_CAP: 300,     // sibling walk cap; beyond this indices are stored as -1
    MAX_CANDIDATES: 500,
    DUP_ID_CAP: 20,
    FP_BYTES_MAX: 2048,
    ACCEPT_SELECTOR: 0.60, // a pre-verified selector matched: lower bar
    ACCEPT_SEARCH: 0.72,   // nothing pre-verified this element: higher bar
    ACCEPT_LOWCONF: 0.80,  // candidate set was truncated
    EARLY_EXIT: 0.90,
    AMBIGUITY_MARGIN: 2,   // raw points; closer than this between 1st and 2nd => ambiguous
    MIN_SIGNAL: 25,        // raw applicable points below which we demand exact structure
    FULL_REVERIFY_EVERY: 20,
    BACKOFF: [1, 2, 4, 8, 16, 32],
  };

  const NS_HTML = 'http://www.w3.org/1999/xhtml';
  const NS_SVG = 'http://www.w3.org/2000/svg';
  const NS_MATHML = 'http://www.w3.org/1998/Math/MathML';

  /* Attributes worth storing, most trustworthy first. */
  const TEST_ID_ATTRS = ['data-testid', 'data-test-id', 'data-test', 'data-qa', 'data-cy',
    'data-automation-id', 'data-tracking-id'];
  const TIER_A_ATTRS = ['aria-label', 'name', 'for', 'placeholder', 'alt', 'title', 'role', 'type'];

  /* ------------------------------------------------------------------ generated-identifier
   * These decide whether an id or class is a stable authored name or framework noise that will
   * differ on the next page load. Getting this wrong in the permissive direction is expensive:
   * a rule keyed on id=":r7:" silently stops matching tomorrow.
   */
  const GENERATED_ID_PATTERNS = [
    /^:[A-Za-z0-9]+:$/,                                   // React useId  :r7:  :R2m:
    /^«[A-Za-z0-9]+»$/,                                   // legacy React
    /^(radix|headlessui|reach|rc|rah|floating-ui)[-_]/i,
    /^mui-\d+$/i,
    /^ember(View)?[-_]?\d+/i,
    /^(downshift|react-select|react-aria|react-tabs|tippy|popper|toast)[-_:]?\d+/i,
    /^(cdk|mat|ng|ngb)[-a-z]*-?\d+$/i,                    // cdk-overlay-0, mat-input-3
    /^(el|arco|ant|semi)[-_]?id[-_]?\d+$/i,
    /^ext-gen\d+$/i,
    /^yui_/i,
    /^gwt-uid-\d+$/i,
    /^aria-\d+$/i,
    /^(uid|uuid|guid|tmp|auto|gen|node|item|row|key|input|field|tab|panel|menu|popup|tooltip)[-_:]?\d{2,}$/i,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,  // bare uuid
    /^[0-9a-f]{16,}$/i,                                   // long hex blob
    /^\d+$/,                                              // purely numeric
  ];

  const HASHED_CLASS_PATTERNS = [
    /^(css|emotion)-[0-9a-z]{5,}$/i,                      // emotion
    /^sc-[0-9a-zA-Z]{5,}$/,                               // styled-components
    /^e[0-9a-z]{9,}$/,                                    // styled-components target class
    /^jsx-\d{4,}$/,                                       // styled-jsx
    /^(svelte|s)-[0-9a-z]{5,}$/i,
    /^v-[0-9a-f]{6,}$/i,                                  // vue scoped
    /^_[0-9a-z]{5,}$/i,
    /^[0-9a-f]{8,}$/i,
    // CSS Modules: Button__root___2fH3k / Button_root__2fH3k. The lookaheads require BOTH a
    // digit and a letter in the hash segment, so authored names like "grid__cell" survive.
    /^[A-Za-z][\w-]*_{1,3}[\w-]*_{1,3}(?=[0-9A-Za-z]*\d)(?=[0-9A-Za-z]*[A-Za-z])[0-9A-Za-z]{4,}$/,
  ];

  /* Stable across builds but shared by thousands of elements: keep, score weakly, never alone. */
  const UTILITY_CLASS_PATTERNS = [
    /^(m|p)[trblxy]?-\d/,                                 // tailwind spacing
    /^(w|h|min-w|max-w|min-h|max-h)-/,
    /^(text|bg|border|ring|shadow|font|leading|tracking)-/,
    /^(flex|grid|inline|block|hidden|absolute|relative|fixed|sticky|static)$/,
    /^(items|justify|self|content|place)-/,
    /^(rounded|opacity|z|gap|space|divide|overflow|cursor|select|transition|duration|ease)-/,
    /^(sm|md|lg|xl|2xl|hover|focus|active|group|dark|first|last|odd|even|disabled):/,
    /^(col|row)-(span|start|end)-/,
    /^(pt|pb|pl|pr|mt|mb|ml|mr)\d/,                       // bootstrap-ish
    /^(d|justify|align|text|bg|btn|col)-(flex|block|none|center|left|right|primary|secondary)/,
  ];

  /* Transient UI state; must never anchor a selector, but a match is weak positive evidence. */
  const STATE_CLASS_PATTERNS = [
    /^(is|has|js|has-|ui-)[-_]?/i,
    /(^|-)(active|selected|open|closed|expanded|collapsed|hover|focus|focused|disabled|hidden|visible|show|shown|loading|error|dragging|current|checked)($|-)/i,
  ];

  function matchesAny(patterns, s) {
    for (const re of patterns) if (re.test(s)) return true;
    return false;
  }

  /** False => the token looks machine-generated and must not be trusted across page loads. */
  function isStableToken(s) {
    if (typeof s !== 'string') return false;
    const t = s.trim();
    if (!t || t.length > 40) return false;
    if (matchesAny(GENERATED_ID_PATTERNS, t)) return false;
    // A long digit run inside an otherwise sane name is usually a counter: item-24816.
    if (/\d{4,}/.test(t)) return false;
    return true;
  }

  function looksGenerated(s) {
    return !isStableToken(s);
  }

  function classBucket(t) {
    if (matchesAny(HASHED_CLASS_PATTERNS, t)) return 'hashed';
    if (matchesAny(UTILITY_CLASS_PATTERNS, t)) return 'utility';
    if (matchesAny(STATE_CLASS_PATTERNS, t)) return 'state';
    return 'stable';
  }

  /* ------------------------------------------------------------------ safe DOM accessors */

  /*
   * Never el.className: on SVG it is a read-only SVGAnimatedString with no .split, and on
   * MathML it behaves inconsistently. getAttribute('class') is namespace-agnostic.
   */
  function classTokens(el) {
    const a = el.getAttribute && el.getAttribute('class');
    return a ? a.trim().split(/\s+/).filter(Boolean) : [];
  }

  function stableClasses(el, cap) {
    const out = [];
    for (const t of classTokens(el)) {
      if (classBucket(t) !== 'stable') continue;
      out.push(t);
      if (out.length >= cap) break;
    }
    return out;
  }

  function nsOf(el) {
    switch (el.namespaceURI) {
      case NS_HTML: return 'html';
      case NS_SVG: return 'svg';
      case NS_MATHML: return 'mathml';
      default: return 'other';
    }
  }

  function nsUri(code) {
    if (code === 'svg') return NS_SVG;
    if (code === 'mathml') return NS_MATHML;
    return NS_HTML;
  }

  function rawId(el) {
    const v = el.getAttribute && el.getAttribute('id');
    return typeof v === 'string' && v.trim() ? v : null;
  }

  function testIdOf(el) {
    for (const name of TEST_ID_ATTRS) {
      const v = el.getAttribute && el.getAttribute(name);
      if (typeof v === 'string' && v.trim()) return [name, v.slice(0, C.ATTR_VAL_MAX)];
    }
    return null;
  }

  /** Quoted, escaped attribute-selector value: foo"bar\ -> "foo\"bar\\" */
  function cssString(v) {
    return '"' + String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  /*
   * Type selectors are ASCII-case-insensitive only for HTML-namespace elements, so
   * "lineargradient" would NOT match <linearGradient>. Store and emit localName verbatim.
   */
  function tagSelector(tag, ns) {
    return ns === 'html' ? tag : CSS.escape(tag);
  }

  function idSelectorFor(id) {
    // A leading digit or a colon makes '#id' invalid; the attribute form always works.
    if (/^-?\d/.test(id) || /[^\w-]/.test(id)) return '[id=' + cssString(id) + ']';
    return '#' + CSS.escape(id);
  }

  /* 1-based, element nodes only. Returns -1 past the walk cap so cost stays bounded. */
  function nthChildOf(el) {
    let i = 1;
    let p = el.previousElementSibling;
    while (p) {
      if (++i > C.IDX_WALK_CAP) return -1;
      p = p.previousElementSibling;
    }
    return i;
  }

  /* 1-based among siblings of the same (namespace, localName). Also returns the total. */
  function typeIndexOf(el) {
    const tag = el.localName;
    const ns = el.namespaceURI;
    let idx = 1;
    let total = 1;
    let steps = 0;
    for (let p = el.previousElementSibling; p; p = p.previousElementSibling) {
      if (++steps > C.IDX_WALK_CAP) return { idx: -1, total: -1 };
      if (p.localName === tag && p.namespaceURI === ns) idx++;
    }
    total = idx;
    for (let n = el.nextElementSibling; n; n = n.nextElementSibling) {
      if (++steps > C.IDX_WALK_CAP) return { idx, total: -1 };
      if (n.localName === tag && n.namespaceURI === ns) total++;
    }
    return { idx, total };
  }

  function depthOf(el) {
    let d = 0;
    for (let p = el.parentElement; p; p = p.parentElement) d++;
    return d;
  }

  /*
   * Direct child text nodes only, so a wrapper <div> does not inherit its whole subtree's text.
   * The textContent fallback is gated on <= 3 element children so it can never stringify a
   * page section, and is skipped entirely for <html>/<body>.
   */
  function directText(el) {
    let t = '';
    const kids = el.childNodes;
    for (let i = 0; i < kids.length; i++) {
      const n = kids[i];
      if (n.nodeType === 3) {
        t += n.nodeValue;
        if (t.length > 512) break;
      }
    }
    t = t.replace(/\s+/g, ' ').trim();
    if (!t && el.childElementCount <= 3) {
      const tag = el.localName;
      if (tag !== 'script' && tag !== 'style') {
        t = (el.textContent || '').replace(/\s+/g, ' ').trim();
      }
    }
    return t;
  }

  function attrsOf(el) {
    const out = {};
    let n = 0;
    for (const name of TIER_A_ATTRS) {
      if (n >= C.ATTR_MAX) break;
      const v = el.getAttribute && el.getAttribute(name);
      if (typeof v !== 'string' || !v.trim()) continue;
      out[name] = v.slice(0, C.ATTR_VAL_MAX);
      n++;
    }
    // href carries real identity on links, but only its path part is stable.
    if (n < C.ATTR_MAX && el.localName === 'a') {
      const href = el.getAttribute('href');
      if (href && !/^\s*(javascript|data):/i.test(href)) {
        try {
          const u = new URL(href, location.href);
          out.href = (u.pathname + u.search).slice(0, C.ATTR_VAL_MAX);
        } catch (e) { /* relative junk; skip */ }
      }
    }
    return out;
  }

  /* ------------------------------------------------------------------ capture */

  function rootOf(el) {
    const r = el.getRootNode ? el.getRootNode() : document;
    return r || document;
  }

  /** Host chain from document down to the element's shadow root, outermost first. */
  function hostChain(el) {
    const chain = [];
    let root = rootOf(el);
    let guard = 0;
    while (root && root !== document && root.host) {
      if (++guard > 8) return null;
      const host = root.host;
      const hostRoot = rootOf(host);
      const sel = bestSelectorForHost(host, hostRoot);
      if (!sel) return null;
      chain.unshift(sel);
      root = hostRoot;
    }
    return chain.length ? chain : null;
  }

  function bestSelectorForHost(host, root) {
    const id = rawId(host);
    if (id && isStableToken(id)) {
      const s = idSelectorFor(id);
      if (safeQueryOne(root, s) === host) return s;
    }
    const cls = stableClasses(host, 2);
    const base = tagSelector(host.localName, nsOf(host));
    const withCls = base + cls.map((c) => '.' + CSS.escape(c)).join('');
    if (safeQueryOne(root, withCls) === host) return withCls;
    const ti = typeIndexOf(host);
    if (ti.idx > 0) {
      const s = base + ':nth-of-type(' + ti.idx + ')';
      if (safeQueryOne(root, s) === host) return s;
    }
    return null;
  }

  function safeQueryOne(root, sel) {
    try {
      return root.querySelector(sel);
    } catch (e) {
      return null;
    }
  }

  function safeCount(root, sel, cap) {
    try {
      const n = root.querySelectorAll(sel).length;
      return cap ? Math.min(cap, n) : n;
    } catch (e) {
      return 0;
    }
  }

  /**
   * capture(el) -> fingerprint object, or { error: 'REASON' }.
   * Runs once per pick, so a few full-document uniqueness counts are acceptable here. None of
   * them happen at apply time.
   */
  function capture(el) {
    if (!el || el.nodeType !== 1) return { error: 'NOT_AN_ELEMENT' };
    if (el.ownerDocument !== document) return { error: 'IFRAME_UNSUPPORTED' };

    /*
     * A closed shadow root is reachable from INSIDE (root.host works even for mode:'closed')
     * but not from OUTSIDE (host.shadowRoot is null). The applier only ever comes from outside,
     * so such an element could be captured and then never resolved again. Refuse at pick time
     * instead of saving a rule that can never match.
     */
    for (let r = rootOf(el), hops = 0; r && r !== document; r = rootOf(r.host)) {
      if (++hops > 8) return { error: 'SHADOW_TOO_DEEP' };
      if (!r.host) return { error: 'SHADOW_DETACHED' };
      if (r.host.shadowRoot !== r) return { error: 'SHADOW_CLOSED' };
    }
    const root = rootOf(el);

    const ns = nsOf(el);
    const tag = el.localName;

    // <html> and <body> are unique by construction; capturing text or structure for them is
    // pointless and body.textContent would stringify the entire page.
    if (el === document.documentElement || el === document.body) {
      const t = el === document.body ? 'body' : 'html';
      return {
        fpv: FP_V, ns: 'html', tag: t, singleton: true,
        sel: [{ s: t, k: 'path', n: 1, flash: true }],
        created: Date.now(),
      };
    }

    const id = rawId(el);
    const idStable = id ? isStableToken(id) : false;
    const idCount = id ? safeCount(root, idSelectorFor(id), 50) : 0;

    const ti = typeIndexOf(el);
    const parent = el.parentElement;

    const fp = {
      fpv: FP_V,
      ns,
      tag,
      singleton: false,
      id: id,
      idOk: !!(id && idStable && idCount === 1),
      idDup: !!(id && idCount > 1),
      tid: testIdOf(el),
      cls: stableClasses(el, C.CLS_MAX),
      clsN: classTokens(el).length,
      attrs: attrsOf(el),
      txt: '',
      txtLen: 0,
      nci: nthChildOf(el),
      noti: ti.idx,
      sibCount: parent ? parent.childElementCount : 1,
      sameTagCount: ti.total,
      depth: depthOf(el),
      path: [],
      anchor: null,
      sibP: null,
      sibN: null,
      hosts: hostChain(el),
      needsShadowStyle: false,
      framePath: [],
      sel: [],
      created: Date.now(),
    };
    fp.needsShadowStyle = fp.hosts !== null;

    const full = directText(el);
    fp.txtLen = Math.min(9999, full.length);
    fp.txt = full.slice(0, C.TXT_MAX);

    // One upward pass computes fp.path and hunts the anchor together.
    let probes = 0;
    let up = 0;
    for (let a = el.parentElement; a && up < C.ANCHOR_MAX_UP; a = a.parentElement) {
      up++;
      if (a === document.documentElement) break;

      if (fp.path.length < C.ANC_MAX) {
        const aid = rawId(a);
        const ati = typeIndexOf(a);
        fp.path.push({
          tag: a.localName,
          id: aid && isStableToken(aid) ? aid : null,
          tid: testIdOf(a),
          cls: stableClasses(a, C.CLS_MAX_ANC),
          nci: nthChildOf(a),
          noti: ati.idx,
          ecnt: a.childElementCount,
        });
      }

      if (!fp.anchor && probes < C.ANCHOR_PROBES) {
        const aid = rawId(a);
        const atid = testIdOf(a);
        let cand = null;
        if (aid && isStableToken(aid)) cand = idSelectorFor(aid);
        else if (atid) cand = '[' + atid[0] + '=' + cssString(atid[1]) + ']';
        if (cand) {
          probes++;
          if (safeCount(root, cand, 5) === 1) fp.anchor = { sel: cand, up };
        }
      }
    }

    const p = el.previousElementSibling;
    if (p) {
      fp.sibP = {
        tag: p.localName,
        cls: stableClasses(p, 2),
        txt: directText(p).slice(0, C.SIB_TXT_MAX),
      };
    }
    const n2 = el.nextElementSibling;
    if (n2) {
      fp.sibN = {
        tag: n2.localName,
        cls: stableClasses(n2, 2),
        txt: directText(n2).slice(0, C.SIB_TXT_MAX),
      };
    }

    fp.sel = generateSelectors(el, fp, root);
    trimToBudget(fp);
    return fp;
  }

  /** Drop the least valuable fields until the JSON fits the per-rule byte budget. */
  function trimToBudget(fp) {
    const steps = [
      () => { if (fp.sibN) { fp.sibN.txt = ''; return true; } return false; },
      () => { if (fp.sibP) { fp.sibP.txt = ''; return true; } return false; },
      () => { const k = Object.keys(fp.attrs); if (k.length > 2) { delete fp.attrs[k[k.length - 1]]; return true; } return false; },
      () => { if (fp.cls.length > 2) { fp.cls.pop(); return true; } return false; },
      () => { if (fp.path.length > 3) { fp.path.pop(); return true; } return false; },
      () => { if (fp.sel.length > 3) { fp.sel.pop(); return true; } return false; },
    ];
    let guard = 0;
    while (JSON.stringify(fp).length > C.FP_BYTES_MAX && guard < 40) {
      guard++;
      let progressed = false;
      for (const s of steps) if (s()) { progressed = true; break; }
      if (!progressed) break;
    }
  }

  /* ------------------------------------------------------------------ selector generation */

  function localPart(el, fp) {
    let s = tagSelector(fp.tag, fp.ns);
    if (fp.tid) s += '[' + fp.tid[0] + '=' + cssString(fp.tid[1]) + ']';
    for (const c of fp.cls.slice(0, 2)) s += '.' + CSS.escape(c);
    return s;
  }

  /**
   * Every candidate passes one non-negotiable gate before it is stored: it must actually select
   * the picked element. A bug in any generator below therefore degrades to "one fewer candidate"
   * rather than "wrong element styled".
   */
  function generateSelectors(el, fp, root) {
    const out = [];
    const seen = new Set();

    function push(s, k) {
      if (out.length >= C.SEL_MAX) return;
      if (!s || s.length > C.SEL_LEN_MAX || seen.has(s)) return;
      if (safeQueryOne(root, s) !== el) return;
      seen.add(s);
      out.push({
        s,
        k,
        n: safeCount(root, s, 50),
        // A document-level <style> cannot reach into a shadow tree, and an :nth- selector is
        // too positional to trust before JS has verified it.
        flash: fp.hosts === null && k !== 'path' && k !== 'abspath' && !s.includes(':nth-'),
      });
    }

    const base = tagSelector(fp.tag, fp.ns);

    if (fp.idOk && fp.id) push(idSelectorFor(fp.id), 'id');

    if (fp.tid) push(base + '[' + fp.tid[0] + '=' + cssString(fp.tid[1]) + ']', 'tid');

    for (const name of ['aria-label', 'name', 'for', 'placeholder', 'alt', 'href', 'title']) {
      const v = fp.attrs[name];
      if (!v || v.length > 60) continue;
      const s = base + '[' + name + '=' + cssString(v) + ']';
      if (safeCount(root, s, 6) <= 5) push(s, 'attr');
    }

    if (fp.cls.length) {
      const s = base + fp.cls.map((c) => '.' + CSS.escape(c)).join('');
      if (safeCount(root, s, 6) <= 5) push(s, 'class');
    }

    if (fp.anchor) {
      const scoped = fp.anchor.sel + ' ' + localPart(el, fp);
      if (safeCount(root, scoped, 6) === 1) {
        push(scoped, 'scoped');
      } else if (fp.noti > 0) {
        push(scoped + ':nth-of-type(' + fp.noti + ')', 'scoped');
        push(scoped, 'scoped');
      } else {
        push(scoped, 'scoped');
      }
    }

    pushPath(el, fp, root, push);

    if (out.length < 2) pushAbsolutePath(el, fp, root, push);

    return out;
  }

  /*
   * nth-OF-TYPE everywhere in paths, with nth-child kept only as a scoring signal. Injected
   * DOM (ad iframes, analytics <script>, Angular/Vue wrapper divs, other extensions' nodes) is
   * overwhelmingly of a different tag than the target, and every such node shifts nth-child
   * while leaving nth-of-type untouched.
   */
  function pushPath(el, fp, root, push) {
    const steps = [];
    let node = el;
    let startSel = null;

    for (let i = 0; i < C.ANC_MAX + 1 && node; i++) {
      const ti = typeIndexOf(node);
      if (ti.idx <= 0) return;                    // index beyond the walk cap: abort
      steps.unshift(tagSelector(node.localName, nsOf(node)) + ':nth-of-type(' + ti.idx + ')');
      const parent = node.parentElement;
      if (!parent || parent === document.documentElement) break;

      const pid = rawId(parent);
      if (pid && isStableToken(pid)) {
        const s = idSelectorFor(pid);
        if (safeCount(root, s, 5) === 1) { startSel = s; break; }
      }
      const ptid = testIdOf(parent);
      if (ptid) {
        const s = '[' + ptid[0] + '=' + cssString(ptid[1]) + ']';
        if (safeCount(root, s, 5) === 1) { startSel = s; break; }
      }
      node = parent;
    }

    if (!startSel) {
      if (fp.anchor) startSel = fp.anchor.sel;
      else if (root === document) startSel = 'body';
      else return;
    }
    push(startSel + ' > ' + steps.join(' > '), 'path');
  }

  function pushAbsolutePath(el, fp, root, push) {
    const steps = [];
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const ti = typeIndexOf(node);
      if (ti.idx <= 0) return;
      steps.unshift(tagSelector(node.localName, nsOf(node)) + ':nth-of-type(' + ti.idx + ')');
      if (steps.length > 12) return;
    }
    push((root === document ? 'html > ' : '') + steps.join(' > '), 'abspath');
  }

  /* ------------------------------------------------------------------ scoring
   * scoreDetail returns { ratio, raw, max }. ratio normalizes over the signal the fingerprint
   * ACTUALLY carries, so an anonymous classless div can still reach 1.0 on structure alone,
   * while a rich fingerprint cannot coast on tag+position. `max` doubles as a signal-strength
   * measure, which is what MIN_SIGNAL keys off.
   */

  function tagEq(el, fp) {
    if (el.localName !== fp.tag) return false;
    return nsOf(el) === fp.ns;
  }

  function scoreDetail(el, fp) {
    const ZERO = { ratio: 0, raw: 0, max: 1 };
    if (!el || el.nodeType !== 1) return ZERO;

    // Hard vetoes: cheap, and they eliminate the overwhelming majority of candidates.
    if (!tagEq(el, fp)) return ZERO;
    if (fp.singleton) {
      const want = fp.tag === 'body' ? document.body : document.documentElement;
      return el === want ? { ratio: 1, raw: 1, max: 1 } : ZERO;
    }
    if (el === document.body || el === document.documentElement) return ZERO;

    let raw = 0;
    let max = 0;

    // ---- identity
    if (fp.idOk && fp.id) {
      max += 30;
      if (el.getAttribute('id') === fp.id) raw += 30;
      else {
        const other = rawId(el);
        // A different AUTHORED id on this node is strong evidence it is not our element.
        if (other && isStableToken(other)) raw -= 30;
      }
    } else if (fp.id) {
      max += 10;
      if (el.getAttribute('id') === fp.id) raw += 10;
    }

    if (fp.tid) {
      max += 22;
      if (el.getAttribute(fp.tid[0]) === fp.tid[1]) raw += 22;
    }

    // ---- appearance
    if (fp.cls.length) {
      max += 16;
      const have = new Set(classTokens(el));
      let hit = 0;
      for (const c of fp.cls) if (have.has(c)) hit++;
      raw += (16 * hit) / fp.cls.length;
    }

    const attrNames = Object.keys(fp.attrs);
    if (attrNames.length) {
      const per = 20 / attrNames.length;
      max += 20;
      for (const name of attrNames) {
        const v = name === 'href' ? hrefPath(el) : el.getAttribute(name);
        if (v === fp.attrs[name]) raw += per;
      }
    }

    if (fp.txt) {
      max += 14;
      const t = directText(el);
      if (t === fp.txt || (fp.txtLen > C.TXT_MAX && t.startsWith(fp.txt))) raw += 14;
      else if (t && (t.startsWith(fp.txt) || fp.txt.startsWith(t))) raw += 7;
    }

    // ---- position
    if (fp.nci > 0) {
      max += 5;
      if (nthChildOf(el) === fp.nci) raw += 5;
    }
    // If the element was the only one of its type among its siblings, nth-of-type carries no
    // information at all — remove its points from `max` rather than handing them out free.
    if (fp.noti > 0 && fp.sameTagCount !== 1) {
      max += 4;
      const ti = typeIndexOf(el);
      if (ti.idx === fp.noti) raw += 4;
      if (fp.sameTagCount > 0 && ti.total === fp.sameTagCount) { max += 2; raw += 2; }
      else if (fp.sameTagCount > 0) max += 2;
    }
    const parent = el.parentElement;
    if (parent && fp.sibCount > 0) {
      max += 2;
      if (parent.childElementCount === fp.sibCount) raw += 2;
    }
    if (fp.depth > 0) {
      max += 3;
      const d = depthOf(el);
      if (d === fp.depth) raw += 3;
      else if (Math.abs(d - fp.depth) === 1) raw += 1;
    }

    // ---- ancestors: weight decays with distance
    const ANC_W = [1.0, 0.8, 0.6, 0.45, 0.3];
    let a = el.parentElement;
    for (let i = 0; i < fp.path.length; i++) {
      const w = ANC_W[i] || 0.25;
      const want = fp.path[i];
      max += 2 * w;
      if (want.id) max += 6 * w;
      if (want.tid) max += 5 * w;
      if (want.cls && want.cls.length) max += 2 * w;
      if (want.nci > 0) max += 2 * w;
      if (want.ecnt > 0) max += 1 * w;
      if (!a) continue;

      if (a.localName === want.tag) raw += 2 * w;
      if (want.id && a.getAttribute('id') === want.id) raw += 6 * w;
      if (want.tid) {
        const tv = a.getAttribute(want.tid[0]);
        if (tv === want.tid[1]) raw += 5 * w;
      }
      if (want.cls && want.cls.length) {
        const have = new Set(classTokens(a));
        let hit = 0;
        for (const c of want.cls) if (have.has(c)) hit++;
        raw += (2 * w * hit) / want.cls.length;
      }
      if (want.nci > 0 && nthChildOf(a) === want.nci) raw += 2 * w;
      if (want.ecnt > 0 && a.childElementCount === want.ecnt) raw += 1 * w;
      a = a.parentElement;
    }

    // ---- anchor containment
    if (fp.anchor) {
      max += 9;
      const root = fp.hosts ? resolveRoot(fp) : document;
      const anchorEl = root ? safeQueryOne(root, fp.anchor.sel) : null;
      if (anchorEl && anchorEl.contains(el)) {
        raw += 6;
        let hops = 0;
        for (let n = el.parentElement; n && hops <= C.ANCHOR_MAX_UP; n = n.parentElement) {
          hops++;
          if (n === anchorEl) break;
        }
        if (hops === fp.anchor.up) raw += 3;
      }
    }

    // ---- immediate siblings
    raw += sibScore(el.previousElementSibling, fp.sibP);
    if (fp.sibP) max += 3;
    raw += sibScore(el.nextElementSibling, fp.sibN);
    if (fp.sibN) max += 3;

    if (max <= 0) return ZERO;
    if (raw < 0) raw = 0;
    return { ratio: Math.min(1, raw / max), raw, max };
  }

  function sibScore(el, want) {
    if (!want || !el) return 0;
    let s = 0;
    if (el.localName === want.tag) s += 1;
    if (want.txt && directText(el).slice(0, C.SIB_TXT_MAX) === want.txt) s += 1.5;
    if (want.cls && want.cls.length) {
      const have = new Set(classTokens(el));
      let hit = 0;
      for (const c of want.cls) if (have.has(c)) hit++;
      s += (0.5 * hit) / want.cls.length;
    }
    return s;
  }

  function hrefPath(el) {
    const href = el.getAttribute && el.getAttribute('href');
    if (!href) return null;
    try {
      const u = new URL(href, location.href);
      return (u.pathname + u.search).slice(0, C.ATTR_VAL_MAX);
    } catch (e) {
      return null;
    }
  }

  function score(el, fp) {
    return scoreDetail(el, fp).ratio;
  }

  /** Four property reads. The steady-state check on an already-resolved element. */
  function quickVerify(el, fp) {
    if (!el || !el.isConnected) return false;
    if (!tagEq(el, fp)) return false;
    if (fp.idOk && fp.id && el.getAttribute('id') !== fp.id) return false;
    if (fp.tid && el.getAttribute(fp.tid[0]) !== fp.tid[1]) return false;
    return true;
  }

  function verify(el, fp) {
    return scoreDetail(el, fp);
  }

  /* ------------------------------------------------------------------ resolution */

  const cache = new Map(); // ruleId -> { ref, misses, skipUntil, lastFull }

  function resolveRoot(fp) {
    if (!fp.hosts) return document;
    let r = document;
    for (const h of fp.hosts) {
      const host = safeQueryOne(r, h);
      if (!host || !host.shadowRoot) return null;   // absent, or a CLOSED root: unreachable
      r = host.shadowRoot;
    }
    return r;
  }

  /**
   * resolve(fp, { ruleId, batch, probe }) -> { el, score, via } | { el: null, reason }
   * Three tiers, each with an early exit. Nothing scans the whole document except the
   * explicitly capped tier-3 fallback.
   *
   * probe: true makes the call read-only — no cache write, no miss bookkeeping, no backoff.
   * The popup's status query uses it, so that merely LOOKING at a rule's match state cannot
   * push out the applier's retry schedule for that rule.
   */
  function resolve(fp, opts) {
    const o = opts || {};
    const ruleId = o.probe ? '' : (o.ruleId || '');
    const batch = Number.isFinite(o.batch) ? o.batch : 0;

    if (!fp || fp.fpv > FP_V) return { el: null, reason: 'UNSUPPORTED_FINGERPRINT' };

    if (fp.singleton) {
      const el = fp.tag === 'body' ? document.body : document.documentElement;
      return el ? { el, score: 1, via: 'singleton' } : { el: null, reason: 'NO_MATCH' };
    }

    const entry = cache.get(ruleId);

    // TIER 0 — cache. This is the path taken on nearly every mutation batch.
    if (entry) {
      if (batch < entry.skipUntil) return { el: null, reason: 'BACKOFF' };
      const el = entry.ref.deref();
      if (el && quickVerify(el, fp)) {
        if (batch - entry.lastFull >= C.FULL_REVERIFY_EVERY) {
          if (scoreDetail(el, fp).ratio >= C.ACCEPT_SELECTOR) {
            entry.lastFull = batch;
            return { el, score: 1, via: 'cache' };
          }
          // Drifted while still passing quickVerify: fall through and re-resolve properly.
        } else {
          return { el, score: 1, via: 'cache' };
        }
      }
    }

    const root = resolveRoot(fp);
    if (!root) return miss(ruleId, batch, 'SHADOW_UNREACHABLE');

    // TIER 1 — id fast path.
    if (fp.idOk && fp.id) {
      const el = root.getElementById ? root.getElementById(fp.id) : safeQueryOne(root, idSelectorFor(fp.id));
      if (el && tagEq(el, fp)) {
        const d = scoreDetail(el, fp);
        if (d.ratio >= C.ACCEPT_SELECTOR) return accept(ruleId, batch, el, d.ratio, 'id');
      }
    } else if (fp.idDup && fp.id) {
      let best = null;
      let bestR = 0;
      let i = 0;
      let list;
      try {
        list = root.querySelectorAll(idSelectorFor(fp.id));
      } catch (e) {
        list = [];
      }
      for (const el of list) {
        if (++i > C.DUP_ID_CAP) break;
        const d = scoreDetail(el, fp);
        if (d.ratio > bestR) { bestR = d.ratio; best = el; }
      }
      if (best && bestR >= C.ACCEPT_SELECTOR) return accept(ruleId, batch, best, bestR, 'id-dup');
    }

    // TIER 2 — the pre-verified selector list, in stored rank order.
    let remembered = null;
    let rememberedR = 0;
    let drifted = null;      // matched structurally, but the label disagrees
    let driftedR = 0;
    for (const c of fp.sel || []) {
      const el = safeQueryOne(root, c.s);
      if (!el || !tagEq(el, fp)) continue;
      const d = scoreDetail(el, fp);

      /*
       * Position says yes, but the text says no. A list row that shifted up when the row above
       * it was deleted looks EXACTLY like this: the stored :nth-of-type path still resolves,
       * to the neighbour. Accepting here is the worst failure this engine can have, so the
       * candidate is set aside and tier 3 gets a chance to find the real element by text.
       * If tier 3 finds nothing better we fall back to it — which is the right answer for an
       * element whose label legitimately changed, like a counter or a price.
       */
      if (textDisagrees(el, fp)) {
        if (d.ratio >= C.ACCEPT_SELECTOR && d.ratio > driftedR) { drifted = el; driftedR = d.ratio; }
        continue;
      }

      if (d.ratio >= C.EARLY_EXIT) return accept(ruleId, batch, el, d.ratio, c.k);
      if (d.ratio >= C.ACCEPT_SELECTOR && c.n === 1) return accept(ruleId, batch, el, d.ratio, c.k);
      if (d.ratio >= C.ACCEPT_SELECTOR && d.ratio > rememberedR) { remembered = el; rememberedR = d.ratio; }
    }
    if (remembered) return accept(ruleId, batch, remembered, rememberedR, 'sel-ambiguous');

    // TIER 3 — bounded scored search. Only reached when the page genuinely changed.
    const searched = searchTier(fp, root, ruleId, batch);
    if (searched.el) return searched;
    if (drifted) return accept(ruleId, batch, drifted, driftedR, 'sel-text-drift');
    return searched;
  }

  /** True when the fingerprint carries a real label and this candidate's label is a different one. */
  function textDisagrees(el, fp) {
    if (!fp.txt || fp.txt.length < 3) return false;
    const t = directText(el);
    if (!t) return false;                 // no text now: absence is not contradiction
    if (t === fp.txt) return false;
    if (t.startsWith(fp.txt) || fp.txt.startsWith(t)) return false;
    return true;
  }

  function searchTier(fp, root, ruleId, batch) {
    const scopeRoot = (fp.anchor && safeQueryOne(root, fp.anchor.sel)) || root;
    const base = tagSelector(fp.tag, fp.ns);

    let list = null;
    const queries = [];
    if (fp.cls.length) queries.push(base + '.' + CSS.escape(fp.cls[0]));
    if (fp.tid) queries.push(base + '[' + fp.tid[0] + ']');
    const an = Object.keys(fp.attrs)[0];
    if (an) queries.push(base + '[' + an + ']');

    for (const q of queries) {
      let r;
      try {
        r = scopeRoot.querySelectorAll(q);
      } catch (e) {
        continue;
      }
      if (r.length) { list = r; break; }
    }
    if (!list) {
      list = fp.ns === 'html'
        ? scopeRoot.getElementsByTagName(fp.tag)
        : scopeRoot.getElementsByTagNameNS(nsUri(fp.ns), fp.tag);
    }

    let lowConfidence = false;
    let best = null;
    let bestD = null;
    let secondRaw = -1;
    let examined = 0;

    for (let i = 0; i < list.length; i++) {
      if (examined >= C.MAX_CANDIDATES) { lowConfidence = true; break; }
      const el = list[i];
      examined++;
      const d = scoreDetail(el, fp);
      if (d.raw <= 0) continue;
      if (!bestD || d.raw > bestD.raw) {
        secondRaw = bestD ? bestD.raw : secondRaw;
        best = el;
        bestD = d;
        if (d.ratio >= C.EARLY_EXIT) break;
      } else if (d.raw > secondRaw) {
        secondRaw = d.raw;
      }
    }

    if (!best) return miss(ruleId, batch, 'NO_MATCH');

    const floor = lowConfidence ? C.ACCEPT_LOWCONF : C.ACCEPT_SEARCH;
    if (bestD.ratio < floor) return miss(ruleId, batch, 'LOW_CONFIDENCE');

    // An anonymous, textless, classless element whose only evidence is position must match
    // structure exactly; a ratio would be meaningless on so little signal.
    if (bestD.max < C.MIN_SIGNAL) {
      if (!exactStructure(best, fp)) return miss(ruleId, batch, 'WEAK_FINGERPRINT');
    }

    if (secondRaw >= 0 && bestD.raw - secondRaw < C.AMBIGUITY_MARGIN) {
      const won = tiebreak(best, fp, list, examined, lowConfidence);
      if (!won) return miss(ruleId, batch, 'AMBIGUOUS');
      best = won;
    }

    return accept(ruleId, batch, best, bestD.ratio, 'search');
  }

  function exactStructure(el, fp) {
    if (fp.nci > 0 && nthChildOf(el) !== fp.nci) return false;
    let a = el.parentElement;
    for (let i = 0; i < fp.path.length; i++) {
      if (!a) return false;
      if (a.localName !== fp.path[i].tag) return false;
      if (fp.path[i].nci > 0 && nthChildOf(a) !== fp.path[i].nci) return false;
      a = a.parentElement;
    }
    return true;
  }

  /*
   * Text beats position when the two disagree, which is the right answer for a reordered list.
   * If nothing discriminates we return null and the caller refuses: leaving the previous
   * styling in place is always better than moving it onto a random sibling.
   */
  function tiebreak(best, fp, list, examined, lowConfidence) {
    if (fp.txt && fp.txt.length >= 3) {
      let hit = null;
      let count = 0;
      for (let i = 0; i < list.length && i < examined; i++) {
        const el = list[i];
        if (!tagEq(el, fp)) continue;
        if (directText(el).slice(0, C.TXT_MAX) === fp.txt) { count++; hit = el; }
        if (count > 1) break;
      }
      if (count === 1) return hit;
    }
    if (fp.nci > 0) {
      let hit = null;
      let count = 0;
      for (let i = 0; i < list.length && i < examined; i++) {
        const el = list[i];
        if (!tagEq(el, fp)) continue;
        if (nthChildOf(el) === fp.nci) { count++; hit = el; }
        if (count > 1) break;
      }
      if (count === 1) return hit;
    }
    if (lowConfidence) return null;
    return null;
  }

  function accept(ruleId, batch, el, ratio, via) {
    if (ruleId) {
      cache.set(ruleId, { ref: new WeakRef(el), misses: 0, skipUntil: 0, lastFull: batch });
    }
    return { el, score: ratio, via };
  }

  /*
   * Exponential backoff on repeated misses stops a virtualized list from burning a 500-node
   * scan on every one of hundreds of mutation batches. Reset on any route change.
   */
  function miss(ruleId, batch, reason) {
    if (ruleId) {
      const e = cache.get(ruleId) || { ref: new WeakRef({}), misses: 0, skipUntil: 0, lastFull: 0 };
      e.misses++;
      e.skipUntil = batch + C.BACKOFF[Math.min(e.misses - 1, C.BACKOFF.length - 1)];
      cache.set(ruleId, e);
    }
    return { el: null, reason };
  }

  function invalidate(ruleId) {
    if (ruleId) cache.delete(ruleId);
    else cache.clear();
  }

  function resetBackoff() {
    for (const e of cache.values()) { e.misses = 0; e.skipUntil = 0; }
  }

  function reset() {
    cache.clear();
  }

  /** Human-readable summary for the popup. */
  function describe(fp) {
    if (!fp) return '';
    if (fp.singleton) return '<' + fp.tag + '>';
    const bits = ['<' + fp.tag + '>'];
    if (fp.id) bits.push(fp.idOk ? '#' + fp.id : '#' + fp.id + ' (unstable)');
    if (fp.tid) bits.push('[' + fp.tid[0] + '=' + fp.tid[1] + ']');
    if (fp.cls.length) bits.push('.' + fp.cls.join('.'));
    return bits.join(' ');
  }

  NS.SelectorEngine = {
    FP_V,
    C,
    capture,
    resolve,
    verify,
    score,
    quickVerify,
    invalidate,
    resetBackoff,
    reset,
    describe,
    // exported for tests and for the picker's label
    isStableToken,
    looksGenerated,
    classBucket,
    classTokens,
    idSelectorFor,
    cssString,
    tagEq,
    nthChildOf,
    typeIndexOf,
    directText,
    resolveRoot,
  };
})();
