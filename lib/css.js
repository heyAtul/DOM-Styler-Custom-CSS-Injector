/*
 * lib/css.js — turns what the user typed into scoped CSS that cannot escape the picked element.
 *
 * Classic script, assigns globalThis.DomStylerCss. Shared by the applier (which injects the
 * result) and the popup (which shows the same errors before you save).
 *
 * Two input forms, distinguished by the presence of a brace:
 *   declarations   color: red; font-size: 20px
 *   rule blocks    &:hover { color: red }  .child { margin: 0 }  @media (max-width: 600px) { & { display: none } }
 *
 * Everything is emitted under the marker selector, so a stray `}` in the input can only ever
 * produce a broken rule, never a rule that restyles the rest of the page.
 */
(function () {
  'use strict';

  if (globalThis.DomStylerCss) return;

  /* Rejected outright: these either reach the network or escape the scope. */
  const FORBIDDEN = [
    { re: /@import\b/i, msg: '@import is not allowed (it would fetch a remote stylesheet)' },
    { re: /@charset\b/i, msg: '@charset is not allowed' },
    { re: /@namespace\b/i, msg: '@namespace is not allowed' },
    { re: /expression\s*\(/i, msg: 'expression() is not allowed' },
    { re: /javascript\s*:/i, msg: 'javascript: URLs are not allowed' },
    { re: /behavior\s*:/i, msg: 'behavior: is not allowed' },
    { re: /-moz-binding/i, msg: '-moz-binding is not allowed' },
  ];

  /* url() is allowed only for data: URIs — anything else is a network request from the page. */
  const URL_RE = /url\(\s*(['"]?)([^'")]*)\1\s*\)/gi;

  function stripComments(s) {
    return s.replace(/\/\*[\s\S]*?\*\//g, ' ');
  }

  function checkForbidden(css, errors) {
    for (const f of FORBIDDEN) if (f.re.test(css)) errors.push(f.msg);
    let m;
    URL_RE.lastIndex = 0;
    while ((m = URL_RE.exec(css)) !== null) {
      const target = (m[2] || '').trim();
      if (!target) continue;
      if (/^data:/i.test(target)) continue;
      if (/^#/.test(target)) continue;                    // in-document fragment reference
      errors.push('url(' + target + ') would make a network request; only data: URIs are allowed');
    }
  }

  /**
   * Split a CSS body into top-level chunks, respecting nesting, strings and comments.
   * Returns [{ type: 'rule', selector, body }, { type: 'decls', text }, { type: 'at', prelude, body }]
   */
  function splitTopLevel(src) {
    const out = [];
    let buf = '';
    let depth = 0;
    let quote = null;
    let blockStart = -1;
    let prelude = '';

    for (let i = 0; i < src.length; i++) {
      const ch = src[i];

      if (quote) {
        buf += ch;
        if (ch === '\\') { buf += src[++i] || ''; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }

      if (ch === '{') {
        depth++;
        if (depth === 1) { prelude = buf.trim(); buf = ''; blockStart = i; continue; }
        buf += ch;
        continue;
      }
      if (ch === '}') {
        depth--;
        if (depth === 0) {
          out.push(prelude.startsWith('@')
            ? { type: 'at', prelude, body: buf }
            : { type: 'rule', selector: prelude, body: buf });
          buf = '';
          prelude = '';
          blockStart = -1;
          continue;
        }
        if (depth < 0) return { error: 'Unexpected "}"' };
        buf += ch;
        continue;
      }
      buf += ch;
    }

    if (depth !== 0) return { error: 'Unclosed "{" — ' + depth + ' block(s) never closed' };
    const tail = buf.trim();
    if (tail) out.push({ type: 'decls', text: tail });
    return { chunks: out };
  }

  /**
   * Prefix a selector list with the marker. `&` is the picked element; a bare selector is a
   * descendant of it. `:hover` and friends attach directly when written as `&:hover`.
   */
  function scopeSelectorList(list, marker) {
    return list.split(',').map((raw) => {
      const s = raw.trim();
      if (!s) return null;
      if (s.includes('&')) return s.split('&').join(marker);
      return marker + ' ' + s;
    }).filter(Boolean).join(', ');
  }

  /*
   * Split a declaration list on TOP-LEVEL semicolons only. A naive split(';') corrupts any
   * declaration that legitimately contains one:
   *   background: url(data:image/svg+xml;base64,…)
   *   content: "a;b"
   *   font-family: "Foo;Bar", sans-serif
   * so quotes and parentheses have to be tracked.
   */
  function splitDeclarations(src) {
    const out = [];
    let buf = '';
    let depth = 0;
    let quote = null;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        buf += ch;
        if (ch === '\\') { buf += src[++i] || ''; continue; }
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; buf += ch; continue; }
      if (ch === '(') { depth++; buf += ch; continue; }
      if (ch === ')') { if (depth > 0) depth--; buf += ch; continue; }
      if (ch === ';' && depth === 0) { out.push(buf); buf = ''; continue; }
      buf += ch;
    }
    out.push(buf);
    return out;
  }

  /**
   * Append !important to declarations that lack it. Site stylesheets are usually more specific
   * than a single attribute selector, so without this most overrides silently lose.
   */
  function forceImportant(decls) {
    return splitDeclarations(decls).map((d) => {
      const t = d.trim();
      if (!t) return null;
      if (/!\s*important\s*$/i.test(t)) return t;
      if (!t.includes(':')) return t;                     // malformed; leave it to the parser
      // Custom properties resolve at use time; !important on them is legal but pointless noise.
      if (t.startsWith('--')) return t;
      return t + ' !important';
    }).filter(Boolean).join('; ') + ';';
  }

  function emitRule(selector, body, important, out) {
    const decls = body.trim();
    if (!decls) return;
    out.push(selector + ' { ' + (important ? forceImportant(decls) : decls) + ' }');
  }

  function compileChunks(chunks, marker, important, out, errors, depth) {
    for (const c of chunks) {
      if (c.type === 'decls') {
        emitRule(marker, c.text, important, out);
        continue;
      }
      if (c.type === 'rule') {
        if (!c.selector) { errors.push('A rule block has no selector'); continue; }
        emitRule(scopeSelectorList(c.selector, marker), c.body, important, out);
        continue;
      }
      // at-rule
      const name = (c.prelude.match(/^@([\w-]+)/) || [])[1] || '';
      const n = name.toLowerCase();
      if (n === 'media' || n === 'supports' || n === 'container' || n === 'layer') {
        if (depth > 3) { errors.push('@' + n + ' nested too deeply'); continue; }
        const inner = splitTopLevel(c.body);
        if (inner.error) { errors.push(inner.error); continue; }
        const innerOut = [];
        compileChunks(inner.chunks, marker, important, innerOut, errors, depth + 1);
        if (innerOut.length) out.push(c.prelude + ' {\n' + innerOut.map((r) => '  ' + r).join('\n') + '\n}');
        continue;
      }
      if (n === 'keyframes' || n === 'font-face' || n === 'property' || n === 'counter-style') {
        // Not selector-based, so scoping does not apply. Emitted verbatim; harmless because the
        // name only takes effect where a scoped rule references it.
        out.push(c.prelude + ' {' + c.body + '}');
        continue;
      }
      errors.push('@' + (name || '?') + ' is not supported');
    }
  }

  /**
   * compile(css, marker, { important = true })
   *   -> { ok, text, errors, mode }
   * `marker` is the full selector for the picked element, e.g. [data-dom-styler~="r-123"].
   */
  function compile(css, marker, opts) {
    const important = !opts || opts.important !== false;
    const errors = [];
    const raw = typeof css === 'string' ? css : '';
    const src = stripComments(raw).trim();

    if (!src) return { ok: true, text: '', errors: [], mode: 'empty' };
    if (!marker) return { ok: false, text: '', errors: ['internal: missing marker selector'], mode: 'error' };

    checkForbidden(src, errors);
    if (errors.length) return { ok: false, text: '', errors, mode: 'error' };

    const mode = src.includes('{') ? 'blocks' : 'declarations';

    if (mode === 'declarations') {
      const text = marker + ' { ' + (important ? forceImportant(src) : src + ';') + ' }';
      return { ok: true, text, errors, mode };
    }

    const split = splitTopLevel(src);
    if (split.error) return { ok: false, text: '', errors: [split.error], mode: 'error' };

    const out = [];
    compileChunks(split.chunks, marker, important, out, errors, 0);
    return { ok: errors.length === 0, text: out.join('\n'), errors, mode };
  }

  /** The attribute selector a rule's CSS is scoped to. Token list, so one element can carry two rules. */
  function markerFor(ruleId) {
    return '[data-dom-styler~="' + String(ruleId).replace(/["\\]/g, '') + '"]';
  }

  globalThis.DomStylerCss = { compile, markerFor, scopeSelectorList, forceImportant, splitDeclarations };
})();
