# Privacy Policy — Custom CSS Injector

_Last updated: 7 August 2026_

Custom CSS Injector does not collect, transmit, or share any data.

## What the extension stores

Only what is needed to reapply the rules you create:

- the CSS you type,
- the site scope you chose for each rule (a hostname, a domain, or a single page URL),
- your settings (the global on/off switch and your default match mode),
- a description of each element you picked, so the rule can be found again on later visits.

That element description is worth spelling out precisely, because it does include a small amount of
content taken from the page:

- its tag name, its `id`, and its class names;
- a short list of its attributes — `aria-label`, `name`, `for`, `placeholder`, `alt`, `title`,
  `role`, `type`, and the path portion of an `href`;
- **up to 64 characters of the element's own text**, and up to 24 characters from each immediate
  neighbour, used to tell it apart from similar elements after the site changes;
- its position among its siblings, and the same details for up to five ancestor elements.

This is why the store listing discloses "Website content": a text snippet and a link path from the
page are saved. It is saved only for elements **you** explicitly picked, only on your own machine,
and it is never transmitted.

Not stored, ever: the values you type into forms (only text nodes are read, never input values),
passwords, cookies, or any content from elements you did not pick.

All of it is written to `chrome.storage.local`, which is storage on your own computer. None of it
leaves your machine. There is no account, no sign-in, and no sync server.

## What the extension does not do

- **No network requests.** The extension contains no code that contacts any server — no analytics,
  no telemetry, no crash reporting, no update pings, no remote configuration. CSS you write cannot
  reach the network either: `@import` and `url()` pointing at a remote address are rejected, and
  only `data:` URIs are permitted.
- **No remote code.** All logic is contained in the extension package. Nothing is downloaded or
  evaluated at runtime.
- **No transmitting of page content.** The extension reads a page's structure to locate the element
  you selected, and stores the small description listed above so it can find that element again.
  Nothing is sent anywhere. It never reads form contents, credentials, cookies, or anything you type
  on a website.
- **No browsing history.** The extension does not record which sites you visit, or when. It stores
  the scope you chose for a rule (for example `news.example.com`) and looks at the current page's
  address only to decide which of your own saved rules apply to it.
- **No selling or sharing of data.** There is no data to sell or share.

## Why it requests access to all websites

You choose which sites to style, and that can be any site, so the extension cannot know in advance
which hosts it needs. Broad host access is what makes "style any page you like" possible. That
access is used solely to find the element you picked and to apply the CSS you wrote.

## Your data, your control

- Delete any rule, or all of them, from the extension's rules manager.
- Export everything to a JSON file, and import it back, from the same page.
- Removing the extension deletes all of its stored data.

## Permissions, and what each is for

| Permission | Purpose |
|---|---|
| `storage` | Saving your rules and settings on your own machine. |
| `scripting` | Injecting the element picker when you click "Pick element", and the stylesheet that applies your saved CSS. |
| Access to all websites | Applying your rules on whichever sites you chose to create rules for. |

## Children

The extension is a developer tool and is not directed at children. It collects no data from anyone,
of any age.

## Changes

If this policy ever changes, the updated version will be published at this same address with a new
date above. Since the extension collects nothing, any change would be a clarification rather than a
new use of data.

## Contact

<!-- Replace with an address or a GitHub Issues URL before publishing. -->
Questions: **[your email or GitHub Issues URL here]**
