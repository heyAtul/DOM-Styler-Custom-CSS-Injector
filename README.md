# Custom CSS Injector

Pick any element on a page, write CSS for it, and have that CSS reapplied every time you visit —
even after the site changes its ids and class names.

Chrome/Edge Manifest V3. Plain HTML/CSS/JS, no build step, no dependencies.

## Permissions, and why each is needed

Only two, deliberately:

| | |
|---|---|
| `storage` | saving your rules and settings in `chrome.storage.local` |
| `scripting` | injecting the picker on demand, and the stylesheet that applies your CSS |
| host `<all_urls>` | you choose which sites to style, and that can be any site |

Notably **not** requested: `tabs`, which would add a *"Read your browsing history"* warning to the
install prompt. It is unnecessary — `tabs.sendMessage`, `tabs.get`, `tabs.query` and `tabs.onRemoved`
all work without it, and the `tab.url` field those calls need is already granted by the
`<all_urls>` host permission. `activeTab` is likewise redundant alongside `<all_urls>`.

There are no network requests anywhere in the extension, and no remote code.

## Install

1. Open `chrome://extensions`
2. Turn on **Developer mode** (top right)
3. **Load unpacked** → select this folder

Pin it to the toolbar.

The toolbar icon lives in `icons/` at 16, 32, 48 and 128 px, cropped square on the badge from the
project logo, with the surrounding off-white background made transparent (by a flood fill inward
from the border, so the white document and brush head stay opaque) so it sits correctly on both
light and dark toolbars. The 16 and 32 px versions carry a mild unsharp mask, because downscaling
that far loses local contrast. Chrome uses the 32 px asset on HiDPI displays and 16 px on
standard-DPI ones.

After installing, **reload any tab you already had open** — or just open the popup, which injects
the content scripts into that tab on demand and tells you if it had to.

## Two ways to select an element

### From DevTools (Elements panel)

Open DevTools → **Elements** → the **Custom CSS Injector** pane in the right-hand sidebar (next to Styles,
Computed, Layout). Click any node in the Elements tree and the pane fills in immediately — the
uniqueness breakdown, a CSS box that previews live as you type, and the rules already saved for this
page. Selecting a different node updates it.

This is usually the better way to work: the Elements tree gives you exact control over which node
you get, which the hover picker cannot for elements that are covered, zero-sized, or only exist
while a menu is open.

*How it works, since it is not obvious:* `chrome.devtools.inspectedWindow.eval` runs in the page's
**main world**, but the selector engine lives in the content script's **isolated world** — different
`window` objects, so `$0` cannot be handed across, and passing it as a message would serialize it to
a plain object and lose the live node. What the two worlds do share is the DOM. So the eval marks
`$0` with a temporary `data-dom-styler-devtools-pick` attribute, the content script finds that node
by attribute selector, captures it, and strips the attribute again. That attribute is deliberately
absent from the applier's `MutationObserver` filter, so marking cannot trigger a re-apply.

### From the page (hover picker)

1. Click the toolbar icon.
2. Choose the scope: **this hostname** (default), **this domain + subdomains**, or **this exact page**.
3. Click **Pick element**. The popup closes and the page enters pick mode.
4. Move the cursor — the element under it is outlined, with its tag, id, classes and pixel size.
   - `↑` `↓` move to the parent / first child. Landing on an inner `<span>` when you wanted the
     `<div>` is the normal case; press `↑`.
   - `←` `→` move between siblings.
   - Pressing any arrow enters **keyboard mode**, shown in the bar at the bottom. The selection then
     stays put and stops following the pointer, until you actually move the mouse more than 8px.
     Without that, the mousemove the browser fires when the overlay repaints would snap the
     selection straight back under the cursor and the arrow keys would appear not to work.
   - In keyboard mode, `Enter` selects.
   - The breadcrumb along the bottom is clickable.
   - `Esc` cancels.
5. Click the element you want. The overlay disappears and the toolbar icon shows a **1** badge.
6. Open the popup again. Your selection is waiting, with its uniqueness data spelled out.
7. Type CSS. It previews live on the page as you type, without saving.
8. **Save rule** (or `⌘`/`Ctrl` + `Enter`).

Clicking the page necessarily dismisses the popup, which is why step 5→6 is two steps: the capture
is parked in storage and picked up the next time the popup opens.

## What CSS you can write

**Declarations** — the common case:

```css
color: #c00;
font-size: 20px;
display: none;
```

**Rule blocks**, when you need pseudo-classes, descendants or media queries. `&` means the element
you picked; a bare selector means a descendant of it:

```css
& { border: 2px solid red }
&:hover { opacity: .6 }
.title { font-weight: 700 }
@media (max-width: 600px) {
  & { display: none }
}
```

`!important` is added automatically to every declaration, because a site's own stylesheet is
usually more specific than a single attribute selector and your override would otherwise lose
silently. Write `!important` yourself and it is not doubled. Custom properties (`--x`) are left alone.

Rejected, with an error in the popup: `@import`, `url()` pointing anywhere except a `data:` URI,
`javascript:` URLs, `expression()`, `behavior:`. Those either fetch from the network or escape the
element you picked.

Everything you write is emitted **scoped to the picked element**. A stray `}` produces an error, not
a rule that restyles the whole page.

## How an element is re-found later

This is the part that matters, and it is why the extension does more than store a CSS selector.

**At pick time**, two things are saved:

1. **A ranked list of CSS selectors**, best first — `#add-to-cart`, then
   `button[data-testid="cart-add"]`, then `button.Button.Button--primary`, then
   `#cart button.Button--primary`, then a bounded `:nth-of-type()` path. Every candidate is
   verified against the element before it is stored, so a broken or ambiguous selector never
   reaches storage.

2. **A fingerprint** — captured **always, even when the element has a perfectly good unique id**:

   - tag name and namespace
   - the id, plus whether it is trustworthy
   - `data-testid` and friends
   - stable class names only (hashed ones are discarded — see below)
   - `aria-label`, `name`, `for`, `placeholder`, `alt`, `title`, `role`, `type`, `href` path
   - its own direct text, and the true length of it
   - position: `nth-child`, `nth-of-type`, sibling count, count of same-tag siblings, depth
   - **the ancestor chain** — parent, grandparent, and up to five levels: each one's tag, stable
     id, test-id, stable classes, own position and child count
   - **the immediate siblings** — previous and next: tag, stable classes, and a short text snippet
   - an **anchor**: the nearest ancestor within 12 levels that has a stable *unique* id or test-id

**An id is not trusted just because it exists.** `id=":r7:"` (React `useId`), `mui-42`, `ember1234`,
`cdk-overlay-0`, `radix-:R2m:`, a bare UUID, a long hex blob, anything purely numeric or containing
a four-digit run — all classified as generated and demoted, because they differ on the next page
load. Class names are bucketed the same way: `css-1q2w3e` (emotion), `sc-bdVaJa`
(styled-components), `Button__root___2fH3k` (CSS Modules), `jsx-1234567`, `v-1a2b3c4d` are hashes and
are dropped; Tailwind and Bootstrap utilities are kept but scored weakly; `Button--primary` and
`grid__cell` are treated as real names.

**An id match is evidence, never proof.** Duplicate ids in one document are legal in practice, and a
redesign can legitimately move `#panel` onto a different node. So every candidate — however it was
found — is scored against the whole fingerprint before it is accepted.

**At apply time**, resolution runs in three tiers, each exiting as early as it can:

- **Tier 0, cache.** A `WeakRef` to the element already resolved, plus four property reads to
  confirm it. This is the path taken on almost every mutation batch, and it is why the steady-state
  cost is negligible. Every 20th batch it re-scores fully in case the element drifted.
- **Tier 1, id.** `getElementById`, then scored. Duplicate ids are all scored, capped at 20.
- **Tier 2, the stored selectors,** in rank order, each scored. **Exception:** if a selector
  resolves to an element whose *text* contradicts the fingerprint, it is set aside rather than
  accepted — a list row that shifted up when the row above it was deleted looks exactly like this,
  and accepting it would restyle the neighbour. Tier 3 gets a chance to find the real element
  first; the set-aside match is used only if nothing better exists, which is the right answer for
  an element whose label legitimately changed, like a counter.
- **Tier 3, bounded search.** Scoped to the anchor when there is one, so it searches a subtree
  rather than the document. Capped at 500 candidates. It requires a higher score than tier 2,
  because nothing pre-verified these elements.

Scores are normalized over the signal the fingerprint actually carries, so an anonymous classless
`<div>` can still reach full confidence on structure alone, while a rich fingerprint cannot coast on
tag-plus-position. **Ties abort.** If the best candidate does not beat the runner-up by a margin,
and no tiebreak (text, then position) discriminates, the rule reports *ambiguous* in the popup and
applies nothing. Leaving your styling where it is beats moving it onto a random sibling.

The popup shows, per rule, whether it is currently matching, at what confidence, and via which
strategy — or why it is not.

## Styles are applied in two stages

The fingerprint cannot be expressed as a CSS selector, so:

1. **At `document_start`**, rules whose best selector is a plain, unambiguous, non-positional one
   are injected as raw CSS immediately. No flash of unstyled content for the common case.
2. **As the DOM is built**, every rule is resolved in JS, the winner is stamped with
   `data-dom-styler="<ruleId>"`, and the real stylesheet targets that stamp. The stage-1 sheet is
   then dropped so it cannot disagree with the verified result.

A `MutationObserver`, started as soon as a page's rules load, re-applies in the animation frame
after each change, before the browser paints it, so an element is styled from its first frame
whether the parser or the page's own scripts inserted it. Each pass is followed by a pause
proportional to what it cost, which bounds the work on pages that never stop mutating. The
expensive fallback search waits for `DOMContentLoaded` and backs off over time for rules that keep
missing; the cheap selector lookups run on every pass. Together with
`pushState`/`replaceState`/`popstate` hooks, this keeps everything applied through SPA re-renders
and route changes. The observer is disconnected across the extension's own writes and its queue
drained, so stamping an attribute cannot retrigger the observer that caused it.

## Scope and match modes

| Mode | Stored as | Matches |
|---|---|---|
| this hostname (default) | `host:www.example.com` | that hostname exactly |
| this domain + subdomains | `domain:example.com` | `example.com` and every subdomain |
| this exact page | `url:https://example.com/a/b?c` | that path and query, ignoring the hash |

All three are read on every page load, most specific first.

`domain:` derivation uses a built-in list of two-part public suffixes (`co.uk`, `com.au`, `co.in`, …)
rather than the full Public Suffix List, which is too large to embed and cannot be fetched. For a
suffix outside that list the scope can come out one label too broad. `host:` mode needs none of this,
which is why it is the default.

## All rules (the manager page)

**view all** in the popup or the DevTools pane, or right-click the toolbar icon → **Options**. Opens
a full tab with every rule the extension holds, across every site, in one table.

| Column | |
|---|---|
| checkbox | select for bulk actions; the header box selects everything currently shown |
| On | enable/disable that one rule |
| Site | the scope, with its match mode underneath |
| Element | the element label, hover for the full text |
| CSS | one-line preview, hover for the whole thing |
| Last seen | see the note below |
| Updated | relative time, hover for the exact timestamp |
| | edit / delete |

**Filters** — free-text search across element, CSS and site; plus dropdowns for site, match mode,
enabled/disabled, and status. Click any column header to sort, again to reverse.

**Bulk actions** appear once anything is selected: Enable, Disable, Export selected, Delete. Bulk
edits read every scope once and write only the scopes that changed, rather than one round-trip per
rule, and a scope left with no rules is removed from storage rather than left as an empty array.

**edit** expands a row in place with the CSS, validated as you type, plus the full uniqueness
breakdown. `⌘`/`Ctrl` + `Enter` saves, `Esc` closes.

The page also reacts to `chrome.storage` changes, so it stays current if you save a rule from the
popup in another window — except while you have an editor open, so your typing is never discarded.

### What "Last seen" actually means

It reports the diagnostic the applier wrote the **last time a page in that scope was open** — not a
live check. This page cannot test a rule against a tab that is not loaded, so a rule can read
"matched" here while the site has since changed. The popup and the DevTools pane, which do have a
live page to talk to, show the current state. The column is labelled "last seen" rather than
"matching" for exactly that reason.

## Backup

**Export all** downloads every rule across every site as JSON; **Export selected** does just the
ones you ticked. **Import** merges a file back in, skipping anything malformed and reporting the
count. Rules are keyed by id, so importing the same file twice does not duplicate them.

## Limits

- **Cross-origin iframes** are not supported. The extension runs only in the top frame, and a
  top-frame `<style>` cannot reach into an iframe anyway. Picking the `<iframe>` element itself works.
- **Closed shadow roots** are refused at pick time, with an explanation, rather than saved as a rule
  that could never match again.
- **Truly identical anonymous siblings** — several `<div>`s with no id, no classes, no attributes and
  no text — carry no information beyond their index. If one is inserted above your target, position
  is all there is to go on and the rule can land on the wrong one. Give the target or an ancestor
  something distinguishing, or pick a parent that has an id.
- `chrome://` pages, `chrome-extension://` pages and the Chrome Web Store are off-limits to all
  extensions; the popup says so instead of failing quietly.
- The hover picker's arrow keys are bound on the top frame's `window` and `document` in the capture
  phase, so a page that stops key events even earlier can still swallow them. Use the DevTools
  sidebar instead when that happens — it does not depend on page key handling at all.
- If focus is inside a same-origin iframe when the picker is active, the top frame never sees the
  keystrokes. Click the page once to return focus.
- Auto-`!important` can defeat a site's own transitions or animations on the properties you override.

## When a rule stops matching

The popup tells you which of these it is:

| Status | Meaning | What to do |
|---|---|---|
| `element not on the page` | nothing scored above zero | the element is gone, or you are on a different page of the site |
| `several elements match equally` | a tie no tiebreak could settle | re-pick, choosing a parent with an id or a test-id |
| `best match too different` | something matched, but below the confidence floor | the site was redesigned; re-pick |
| `structure changed` | fingerprint too weak to confirm by structure alone | re-pick a more distinctive element |
| `shadow root gone` | the host element or its shadow root disappeared | re-pick |
| `retrying` | backing off after repeated misses | resolves itself on the next route change |

Open **uniqueness data** on a capture to see exactly what was stored and which selectors will be
tried, in order. If the list says *position-only match (weak)*, the element had nothing distinctive
about it and the rule will be fragile — pick a parent instead.

Deleting and re-picking is always safe; nothing is shared between rules.

## Files

| File | Role |
|---|---|
| `manifest.json` | MV3 manifest |
| `lib/storage.js` | the one storage module, shared by all three contexts |
| `lib/css.js` | compiles your CSS into scoped, sanitised rules |
| `content/selector-engine.js` | capture and resolution; no DOM writes, no `chrome.*` calls |
| `content/applier.js` | injects CSS, stamps elements, survives SPA re-renders |
| `content/picker.js` / `.css` | the pick overlay, in a closed shadow root |
| `background/service-worker.js` | picker injection, capture handoff, tab relays for DevTools |
| `popup/` | the toolbar UI |
| `devtools/` | the Elements-panel sidebar pane |
| `options/` | the all-rules manager: table, filters, bulk actions |
| `icons/` | toolbar and store icons at 16 / 32 / 48 / 128 px |

`selector-engine.js` and `lib/css.js` are pure and have no extension dependencies, so they can be
tested under Node with jsdom.
