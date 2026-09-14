# Chrome Web Store listing — copy/paste source

Everything below is ready to paste into the Developer Dashboard. Character counts are verified
against the form limits (see `verify-counts.py` output at the bottom of this file's section).

---

## 1. Name  ← the single biggest SEO lever

The item name carries more ranking weight in Web Store search than any other text field.

**Current name: `Custom CSS Injector`** (19 chars) — the highest-volume query for this category,
used verbatim as the name. No separate brand word.

Alternatives considered, kept here for reference:

| Option | Chars | Notes |
|---|---|---|
| `Custom CSS Injector` | 19 | **In use.** Pure keyword match, nothing to truncate. |
| `Custom CSS Injector & Editor` | 28 | Covers "editor" as well. |
| `Custom CSS Injector – Element Picker` | 35 | Adds the differentiating feature. |

Hard limit is 75 characters, but the store truncates around 45 in several surfaces.

**Do not** stuff further ("css inject style editor userstyles chrome") — keyword stuffing in the
name is an explicit policy violation and a common rejection reason.

Set this in `manifest.json` → `"name"`. If the dashboard also shows an editable name field, keep it
character-identical to the manifest.

---

## 2. Short description  (limit 132)

Shown directly under the name in search results, and indexed. Front-load the keywords.

**Recommended:**

```
Custom CSS injector with a visual element picker. Style any site per domain — rules survive class and ID changes.
```

Alternates:

```
Pick any element, write CSS, and it sticks. Per-site user styles that keep matching after a redesign.
```

```
Visual element picker + custom CSS editor. Save per-domain user styles that survive class and ID changes.
```

---

## 3. Description  (limit 16,000)

The first ~200 characters carry the most search weight and are what users actually read before
clicking "more". Everything below is accurate to what the extension does — no invented features.

```
Pick any element on any web page and apply your own custom CSS to it. Your styles are saved per
domain and reapplied automatically on every visit — and they keep matching even after the site
changes its class names and IDs.

A user-style editor with a visual element picker, built for
people who want to fix, restyle, or clean up the sites they use every day.


WHAT YOU CAN DO

• Click to select any element — a hover picker with an ancestor breadcrumb, plus arrow-key
  navigation to move to the parent, child or sibling when the cursor lands on the wrong node.
• Or select straight from DevTools — a "Custom CSS Injector" pane in the Elements sidebar picks up whatever
  node you click in the DOM tree. Better for elements that are covered, zero-sized, or only exist
  while a menu is open.
• Write plain declarations (color: red; font-size: 20px) or full rule blocks with pseudo-classes,
  descendants and media queries.
• Live preview as you type, before you save anything.
• Scope each rule to one hostname, a domain plus all its subdomains, or a single exact page.
• Manage everything in one place: a full rules table with search, filters, sorting, multi-select,
  and bulk enable / disable / delete / export.
• Export and import your whole rule set as JSON.


WHY YOUR RULES KEEP WORKING

Most CSS-injection tools store a selector and break the moment the site ships a redesign. This one
stores a selector AND a fingerprint of the element — its parent, grandparent and further ancestors,
its siblings, its text, its stable attributes, and its position among like elements.

It also refuses to trust an ID just because one exists. Framework-generated IDs like :r7:, mui-42,
ember1234, cdk-overlay-0 and radix-* change on every page load, so they are detected and ranked
below the structural fingerprint. Hashed class names from CSS Modules, emotion, styled-components,
Svelte and Vue are recognised and ignored the same way.

And when the page has genuinely changed too much to be sure, it stops rather than guessing. If two
elements match equally well, the rule reports "ambiguous" and applies nothing — because silently
restyling the wrong element is worse than not applying at all. The rules table tells you exactly
which rules are landing, at what confidence, and why any of them are not.


PRIVACY

• No accounts, no sign-in, no telemetry, no analytics.
• Nothing is ever sent anywhere. There are zero network requests in the entire extension.
• Everything lives in chrome.storage.local on your own machine.
• No remote code — all logic ships inside the extension package.
• CSS you write cannot reach the network either: @import and remote url() are rejected, and only
  data: URIs are allowed.


WHY IT ASKS FOR ACCESS TO ALL SITES

You decide which sites to style, and that can be any site, so access cannot be scoped in advance.
The extension reads a page's structure only to find the element you picked, and writes only the CSS
you wrote. It never reads or transmits page content, form data, or browsing history.


KNOWN LIMITS (stated up front)

• Elements inside cross-origin iframes are not supported. Picking the iframe element itself works.
• Closed shadow roots are refused at pick time, with an explanation, rather than saved as a rule
  that could never match again.
• Several truly identical anonymous siblings — no ID, no classes, no attributes, no text — carry no
  information beyond their position. If one is inserted above your target, the rule can land on the
  wrong one. Pick a parent with an ID instead.
• chrome:// pages, other extensions' pages and the Chrome Web Store are off-limits to all
  extensions, so nothing can be styled there.

Open source, no build step, no dependencies.
```

---

## 4. Category

**Developer Tools**

Best fit and the least crowded of the plausible options. `Functionality & UI` is the alternative but
competes with thousands of general-purpose tweaks.

## 5. Language

**English (United States)**

---

## 6. Graphic assets

| Field | File | Notes |
|---|---|---|
| Store icon (128×128, required) | `store-icon-128-alpha.png` | Use this one. If the uploader rejects the alpha channel, use `store-icon-128-flat.png`. |
| Small promo tile (440×280) | `promo-small-440x280-dark.png` or `-light.png` | Optional but do add it — items with a tile get featured placement consideration. |
| Marquee promo tile (1400×560) | `promo-marquee-1400x560-dark.png` or `-light.png` | Optional. Only used if Google features you. |

Both promo tiles are 24-bit RGB PNG with **no alpha**, as the form requires. Two themes provided;
dark reads more strongly against the store's white surfaces.

## 7. Screenshots — you have to take these yourself

**Required: at least 1. Max 5. 1280×800 or 640×400. JPEG or 24-bit PNG, no alpha.**

I cannot produce these — they have to be real captures of the extension running, and faking them
would be both misleading and obvious to a reviewer.

On macOS, `⌘⇧4` then drag captures a region; `⌘⇧5` lets you set an exact size. Or capture anything
and resize precisely:

```sh
# pad or fit an existing capture to exactly 1280x800, flattened to RGB (no alpha)
sips -Z 1280 shot.png --out tmp.png
python3 -c "
from PIL import Image
im = Image.open('tmp.png').convert('RGB')
canvas = Image.new('RGB', (1280, 800), (255,255,255))
im.thumbnail((1280, 800), Image.LANCZOS)
canvas.paste(im, ((1280-im.width)//2, (800-im.height)//2))
canvas.save('screenshot-1.png')
"
```

Shoot these five, in this order — the first is the one most people ever look at:

1. **The picker mid-hover** on a recognisable site: element outlined, label showing tag + id + size,
   ancestor breadcrumb along the bottom. This single image explains the product.
2. **The popup with a capture waiting** — the uniqueness data panel expanded so the parent /
   grandparent / sibling breakdown is visible. This is your differentiator; show it.
3. **The DevTools Elements sidebar pane** with a node selected and CSS typed in.
4. **A before/after** of a real page with a rule applied.
5. **The all-rules table** with filters and a few rows selected.

Avoid: browser chrome you don't need, personal data, logged-in accounts, and anything that could
read as another company's product being defaced.

## 8. Additional fields (the first screenshot you sent)

| Field | What to enter |
|---|---|
| Official URL | Leave as **None** unless you own a verified domain for it. |
| Homepage URL | Optional. A GitHub repo URL is ideal and adds credibility. |
| Support URL | Optional but **recommended** — a GitHub Issues URL. Reviewers and users both look for it. |
| Global promo video | Leave blank. A YouTube demo helps conversion but is not required. |
| Mature content | Leave **off**. |

## 9. Privacy tab — this is where submissions actually get held up

You must fill all of this or it will not pass review.

**Single purpose:**

```
Apply user-defined CSS to elements the user selects on websites they choose.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Stores the user's own CSS rules and settings locally. No other use. |
| `scripting` | Injects the element picker on demand, and the stylesheet that applies the user's saved CSS, only into pages the user has created a rule for or is actively picking on. |
| Host permission `<all_urls>` | The user chooses which sites to style, and that can be any site, so the set of hosts cannot be known in advance. Page structure is read only to locate the element the user picked; nothing is transmitted. |

**Data usage disclosures:** tick **nothing**. Then check the two attestations: you are not selling
data, and use complies with the Developer Program Policies. All three are truthful here — the
extension makes zero network requests.

**Privacy policy URL: required.** Host it anywhere public (a GitHub Gist works). See
`PRIVACY-POLICY.md` in this folder for text that matches the code.

## 10. Distribution tab

- Visibility: **Public** (or Unlisted if you only want to share a link).
- Regions: all, unless you have a reason.
- **Trader status:** required since the EU DSA rules. Choose **non-trader** if you are not selling
  anything or acting commercially.

---

## SEO: what actually moves the needle

Ranked by real impact on Web Store search:

1. **The name.** Heaviest signal by a wide margin. This is why the name is the search term itself,
   `Custom CSS Injector`, rather than an invented brand word.
2. **Short description.** Indexed, and it is the copy shown in results — so it drives both ranking
   and click-through.
3. **First ~200 chars of the description.** Weighted more than the rest; put your keywords there
   naturally, as the draft above does.
4. **Install count, rating, and rating recency.** Over any longer horizon these dominate everything
   above. Copy gets you discovered; retention gets you ranked.
5. **Update frequency.** A recently updated item outranks a stale one, other things equal.
6. **Category.** Affects browse-based discovery, not text search.

Terms worth covering naturally, all present in the draft copy: *custom CSS, CSS injector, CSS
editor, user styles, element picker, restyle website, per-site CSS, inject CSS*.

Two things to avoid, both of which get extensions rejected or buried:

- **Keyword stuffing** anywhere, especially the name — an explicit policy violation.
- **Naming other extensions** ("better than Stylus", "Stylish alternative"). Using another product's
  trademark for discovery is a takedown risk.

After launch: ask early users for reviews, reply to every review, and ship a small update every few
weeks. Those three do more than any wording change.
