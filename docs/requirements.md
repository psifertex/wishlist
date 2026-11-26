# Wishlist — Requirements & Architecture

Status: review complete, approved

A small, self-hostable family wishlist that runs entirely on Cloudflare's free
tier. Family members keep lists of things they'd like; anyone with the link can
see a list and quietly mark something as bought, without spoiling the surprise.

## Goals

- Zero servers to maintain and zero user management: login is delegated to
  Cloudflare Access (Google, GitHub, or emailed one-time PIN).
- Adding an item from a phone (iOS Safari especially) is fast and gets the right
  price, image, and variant/format.
- Givers never need an account.
- Owners don't see what's been bought for them until it's time.
- Generic and public: no family-specific values in the code. Domains, people,
  and admins are deployment configuration.

## Non-goals

- Native apps or a regular browser extension

Features postponed past v1 are listed under [Later](#later).

## Concepts

| Term | Meaning |
|---|---|
| **Person** | Someone who has lists (e.g. Pat, Riley). Has a URL slug. Usually has a login. |
| **User** | A login identity (email from Cloudflare Access) linked to a Person. |
| **Admin** | A Person who can view and edit every list and see purchases on lists that aren't their own. |
| **Manager** | A Person who can edit another Person's lists (parent → kid). Admins are implicitly managers of everyone. |
| **Item** | Something a Person wants. Items belong to the Person, not to a list. |
| **List** | A named collection of that Person's items, optionally tied to an event date. One list per Person is the *default* list. |
| **Claim** | A giver marking (some quantity of) an item as being bought. |
| **Reveal** | The moment a claim becomes visible to the owner. |

## Functional requirements

### Identity & access

- R1. Logged-in actions (adding, editing, managing lists) require a Cloudflare
  Access login. The app checks the Access JWT and looks up the email in an
  allowlist; unknown emails are refused.
- R2. Admins (initially the two parents) can view and edit all lists.
- R3. Kids have their own logins. Parents (managers) can add and edit items on
  their kids' lists.
- R4. Viewing a list and claiming an item need **no login**.
- R4a. **Admins manage the allowlist in the app.** They can, with changes taking
  effect immediately and no redeploy or Cloudflare dashboard visit:
  - add or remove login emails
  - link an email to a Person, or create a new Person
  - grant or revoke admin
  - set manager (parent → kid) relationships

  To make that work, the Access policy is deliberately broad: anyone who
  completes a Google/GitHub/PIN login gets through. The app's allowlist is the
  real gate.
- R4b. **Pending approval.** The first time someone logs in with an email that
  isn't on the allowlist:
  - They're recorded as **pending**, with their email, the name from the Access
    identity when available, and the time of the request.
  - They see "Your request is waiting for an admin to approve it" and nothing
    else.
  - The admin dashboard shows a pending count and a queue. For each request an
    admin can:
    - **Approve:** link to an existing Person or create a new one, and
      optionally make them a manager of someone
    - **Reject:** a rejected email stays blocked and can't re-request; an admin
      can still approve it later from the rejected list
  - Spam guard: at most 25 pending requests at once. Beyond that, new requests
    are refused until the queue is cleared.
  - No notification is sent in v1; admins see the queue when they log in.
  - The first admin comes from the `BOOTSTRAP_ADMIN_EMAIL` setting, so the app
    can't lock everyone out.
  - Admins can't remove their own admin flag, and the last admin can't be
    removed.

  Each distinct login uses one Access seat (50 free), including logins from
  people who aren't invited. Admins can free seats in the Zero Trust
  dashboard; listing seat usage in the app is a later item.

### Lists & items

- R5. Each Person can have multiple lists. One is marked as the default (e.g.
  "General" or "Books").
- R6. An item can appear on more than one of its owner's lists. Creating a new
  list (e.g. "Birthday 2027") offers to include all or some items from the
  owner's existing lists.
- R7. A list has an optional **event date**.
- R8. Item fields:
  - title
  - URL (optional; items without a link are allowed, e.g. "any book by X")
  - image (copied into our own storage)
  - price snapshot: amount, currency, and the date it was captured
  - variant text (size, color, etc.)
  - **format** for books (hardcover, paperback, ebook, audiobook, any)
  - ISBN and ASIN when known
  - quantity wanted
  - priority
  - notes
- R9. An owner can reorder, edit, and remove items.

### Claims, secrecy & reveal

- R10. Anyone viewing a list can claim an item, giving a free-text name
  ("Grandma Sue") and a quantity (for items wanted in quantity >1). Bots are
  blocked with Cloudflare Turnstile.
- R11. A claim attaches to the *item*, so it shows on every list containing that
  item. This prevents duplicate purchases.
- R12. The browser that made an anonymous claim can undo it, using a cookie
  token. Logged-in givers can undo their claims from any device.
- R13. **Reveal rule:** a claim is hidden from the owner until
  - the event date of the list it was claimed from, or
  - 60 days after the claim, if that list has no event date.
- R14. After reveal, fully claimed items are **automatically removed** from all
  lists and moved to the owner's "Received" archive (a daily cron job).
- R15. If the owner deletes an item that has an unrevealed claim, it's only
  hidden from the owner. The buyer still sees it, so no purchase is lost and
  nothing is spoiled.
- R16. Admins and managers see claims on lists they manage but don't own. On
  their own lists they get the same secrecy as everyone else.
- R17. **Spoiler deterrent (honor system):** a public list page first shows items
  *without* claim status. There are two prominent actions: "Log in" and "I'm
  buying a gift". Choosing the second reveals claim status with a note: "If
  this is your list, you'll see what's been bought for you." We accept that an
  owner could peek anyway.

### Domains & routing

- R18. `gifts.example.com` is the main site: login, the dashboard, and all
  logged-in pages.
- R19. Each Person has a public hostname that goes **straight to the list with
  the next upcoming event**, or to their default list if no event is upcoming:
  - `gifts.alex.example`, `gifts.sam.example`, `gifts.riley.example`
  - `pat.gifts.example.com`, `casey.gifts.example.com`, etc.
- R20. Public pages are also reachable at `gifts.example.com/<person>/<list>`,
  so a person's hostname is optional.
- R21. Hostname → Person mappings are data in the database, not code. Adding a
  person means adding a row plus a Worker custom domain.

### Capturing items

- R22. **One extraction script, served from our domain** (`/capture.js`,
  versioned), so it can be fixed without anyone reinstalling. It ships two ways:
  - **Bookmarklet:** a tiny loader that injects `<script src=".../capture.js">`.
    Works on desktop browsers, and on iOS Safari via iCloud sync or by pasting
    the code.
    - If the site's security policy (CSP) blocks the script, the loader falls
      back to a small built-in extractor (JSON-LD, OpenGraph, URL) and the
      paste-a-link flow.
    - Amazon currently doesn't block it: its enforced CSP is only
      `upgrade-insecure-requests`, checked 2026-11-26.
  - **iOS Shortcut** ("Add to Wishlist" in Safari's Share sheet):
    1. "Get Contents of URL" downloads `capture.js`.
    2. "Run JavaScript on Web Page" runs that downloaded text.

    The code never passes through the page's script loading, so CSP can't block
    it. (To verify: that the Run JavaScript action accepts a variable as its
    script.)
- R23. The script runs on the product page as the user sees it, and pulls out:
  - title, price, currency, and the exact URL
  - image candidates
  - selected variant
  - ISBN, ASIN, and book format

  Handing the data to our site:
  - **Primary:** open our add page in a new window, then send the data to it
    with `postMessage`. The page's CSP doesn't restrict `postMessage`, and there
    is no size limit, so image bytes can be included.
  - **Fallback:** if there's no window reference (popup blocked, or the store
    sets a Cross-Origin-Opener-Policy), navigate to
    `gifts.example.com/add?d=<encoded JSON>` with the text fields and image
    URLs only. Page navigation isn't restricted by CSP either.
  - Page HTML is never sent.
- R24. The add page (behind Access) shows a pre-filled form where the user:
  - picks the target list (their own, or one they manage)
  - picks **one image or "no image"** from a thumbnail grid of the candidates,
    or uploads or takes a photo (iOS shows Photos and the camera)
  - checks the price (**required if it wasn't detected**)
  - checks the variant/format
  - adds notes, priority, and quantity
- R25. Order of extraction methods:
  1. site-specific rules: **Amazon first**, then Bookshop.org, Barnes & Noble,
     Shopify stores
  2. schema.org JSON-LD
  3. OpenGraph and meta tags
  4. generic DOM heuristics
- R26. **Books from anywhere:** any page with a findable ISBN gets its details
  and cover filled in from Open Library. Users can also add a book by ISBN or
  title alone, with no link.
- R27. **Paste-a-link fallback:** the add page also takes a bare URL. The server
  - expands short links (`a.co`, `amzn.to`)
  - pulls out the ASIN or ISBN
  - tries a server-side fetch and parse

  Amazon often blocks this fetch; when it does, the form asks for the price.
  This also covers sharing from the Amazon iOS app, which produces only an
  `a.co` link and has no web page for the script to run on.
- R27a. **Image saving.** Only the image the user picks is stored. Getting its
  bytes, in order:
  1. The Worker downloads the URL. Amazon's image CDN serves images to
     non-browser clients with `Access-Control-Allow-Origin: *`; it's the HTML
     product pages that get bot-blocked, not the images.
  2. If the Worker is refused, the add page fetches the image in the browser
     (works when the CDN allows CORS) and uploads the bytes.
  3. Bytes the capture script already sent via `postMessage`. The script can
     read image bytes when the image is same-origin or CORS-enabled.
  4. Manual upload or photo.

  Images are resized to a maximum size in the browser before upload.

  Web Workers don't help here: they face the same CORS and CSP rules (stricter,
  in fact), and the obstacles are CORS, CSP and bot detection, not threading.
- R28. An install page at `gifts.example.com/install` has a drag-to-install
  bookmarklet, step-by-step iPhone instructions, and the Shortcut link.

### Rate limiting & free-tier protection

Expected use is very light, so the limits are tight on purpose. Hitting a limit
should cause a friendly "slow down" message, never a bill.

- R29. **Edge rule first:** a Cloudflare WAF rate-limiting rule (the free plan
  includes one) per IP across all wishlist hostnames, e.g. 60 requests/minute.
  Requests it blocks never reach the Worker, so they don't count against the
  Workers request quota.
- R30. **Per-action limits in the Worker** (Workers Rate Limiting binding, keyed
  by IP or by user):

  | Action | Limit (starting point) |
  |---|---|
  | Claim / undo claim | 10/min per IP |
  | Add item | 20/min per user |
  | Paste-a-link server fetch | 5/min per user |
  | Image download to R2 | 20/min per user |
  | Public page views | 30/min per IP |

- R31. **Daily budgets** stored in D1, as a global ceiling on anything that
  costs quota or makes outbound calls. Starting points:
  - total R2 writes: 200/day
  - outbound fetches: 300/day
  - claims: 200/day

  When a budget is used up, that feature turns off until UTC midnight, and
  everything else keeps working.
- R32. **Size caps:**
  - stored images are resized or limited to 2 MB each
  - total R2 storage has a soft cap (e.g. 5 GB) that blocks new images
  - limits on the number of items per person and lists per person
- R33. **Cheap serving:**
  - images come from an R2 public bucket on a custom domain, not through the
    Worker
  - static assets use Workers static assets, which don't count as Worker
    requests
- R34. The admin dashboard shows today's usage against each budget.

Free-plan failure modes, for context:

- Workers and D1 return errors when over their limits; they don't bill.
- **R2 can bill past its free tier** because it requires a payment method, so
  the R2 caps are the most important ones.

## Architecture

```
            ┌───────────────── Cloudflare ──────────────────┐
 browser ──▶│ Access (only on /app, /add, /api/w/*)         │
            │        │                                      │
            │        ▼                                      │
            │ Worker (Hono, server-rendered JSX)            │
            │   • routes requests by Host header            │
            │   • public pages + claim API                  │
            │   • app pages + write API                     │
            │   • cron: daily reveal/archive                │
            │     │            │             │              │
            │     ▼            ▼             ▼              │
            │    D1           R2         Turnstile          │
            │  (SQLite)    (images)                         │
            └───────────────────────────────────────────────┘
                     │ outbound: Open Library, link fetch/expand
```

- **Runtime:** a single Cloudflare Worker. Hono with server-rendered JSX and a
  little plain JS for interactivity. No SPA build.
- **Database:** D1 with Drizzle ORM and migrations.
- **Images:** R2. The chosen image is downloaded once and served from our
  domain, so links don't break when stores change.
- **Auth:** Cloudflare Access protects only the logged-in paths on
  `gifts.example.com`. The Worker verifies the `Cf-Access-Jwt-Assertion`
  header against the team's public keys. Public hostnames never need Access;
  their "Log in" button links to the matching page on the main domain. This
  keeps a single login origin and avoids cross-domain cookie problems.
- **TLS:** Worker Custom Domains issue a certificate for each hostname,
  including two-level names like `pat.gifts.example.com` (the free
  wildcard certificate wouldn't cover those). Each person's hostname is listed
  in the Worker's config. There's no wildcard, which is fine at family scale.
- **Capture script:** its own package (`packages/capture`), bundled with esbuild
  into a bookmarklet and a Shortcut payload. It's tested against saved HTML
  fixtures from Amazon and the other supported stores.
- **Config:** deployment-specific values stay out of committed code:
  - account IDs and hostnames: an untracked `wrangler.deploy.jsonc`, copied
    from the committed `wrangler.deploy.example.jsonc`; the committed
    `wrangler.jsonc` is only for local development and tests
  - Access team domain and AUD: Worker secrets or variables
  - the first admin: the `BOOTSTRAP_ADMIN_EMAIL` variable, which makes that
    email an admin on first login, but only while no admin exists; after that, people, logins and admins are
    managed in the app (R4a); hostnames are rows plus a custom domain in
    `wrangler.jsonc`

### Data model (initial)

```
people        id, slug, display_name, is_admin, created_at
users         email (pk), person_id?, status (pending|active|rejected),
              requested_name?, requested_at, decided_by_person_id?,
              decided_at?, created_at
managers      manager_person_id, person_id
hostnames     hostname (pk), person_id
lists         id, person_id, name, slug, event_date?, is_default, archived_at?
items         id, person_id, title, url?, asin?, isbn?, format?, variant_text?,
              price_cents?, currency, price_captured_at?, image_key?,
              source_image_url?, notes?, priority, quantity,
              created_by_person_id, created_at,
              owner_hidden_at?, received_at?
list_items    list_id, item_id, position
claims        id, item_id, list_id, quantity, buyer_name,
              buyer_person_id?, anon_token_hash?, created_at, revoked_at?
```

The reveal time is computed rather than stored, so changing a list's event date
moves every reveal on that list:

```
reveal_at = lists.event_date ?? claims.created_at + 60 days
```

### Free tier fit

The expected load (a handful of users, maybe hundreds of requests a day) is far
under the free limits: Workers 100k requests/day, D1 5 GB, R2 10 GB, Access 50
seats, Turnstile free, and cron triggers included.

## Before the first public release

- [ ] **Self-hosting guide in the README** for third parties:
  - Prerequisites: a Cloudflare account (free plan), domains on Cloudflare DNS,
    and a Zero Trust team (free).
  - Step-by-step setup of D1, R2, Access, Turnstile, the WAF rate-limit rule,
    and Worker custom domains.
  - **Credentials an agent (or CI) needs to self-host on someone's behalf:**
    - A Cloudflare API token with the minimum scopes, documented exactly (to
      verify against wrangler when we write it):
      - Account: Workers Scripts (edit), D1 (edit), Workers R2 Storage (edit),
        Turnstile (edit), Access: Apps and Policies (edit), Account Settings
        (read)
      - Zone (each gift domain): Workers Routes (edit), DNS (edit), Zone WAF
        (edit)
    - The account ID.
    - If deploying from GitHub Actions: where to store the token as a
      repository secret, and a GitHub token (or the `gh` CLI) with permission
      to set secrets and run workflows.
    - Which steps can't be automated by token and must be done by hand in the
      dashboard (e.g. the Zero Trust team signup and adding Google as a login
      provider).
  - A sample "give this to your agent" prompt or checklist.
  - Setting `BOOTSTRAP_ADMIN_EMAIL` for the first admin.

## Later

Ideas deliberately left out of v1:

- **Referral codes per domain:** append our own affiliate tag (e.g. Amazon
  Associates `tag=`) to outbound store links. The tag is chosen per public
  hostname or per Person, so each family domain can carry its own. Needs the
  disclosure text the programs require, and must never alter the stored URL
  (only the outgoing link).
- **Email admins when someone is waiting for approval** (e.g. Cloudflare Email
  Workers or a free transactional email tier). This could later grow into
  approve/reject links right in the email.
- Group gifts and splitting the cost of one item
- Email or push notifications (e.g. a reminder before an event)
- Ongoing price tracking and price-drop alerts
- Multiple currencies
- Access seat usage shown in the admin dashboard, with a one-click remove

## Open items

- Exact Amazon selectors for price and variant: build these from real saved
  pages, and expect to maintain them.
- Whether to bother with server-side Amazon fetching at all, or always rely on
  the capture script plus asking for the price.
- Fetching an Amazon product page from a residential IP returned the real page
  (title, prices, images). Cloudflare Worker IPs are much more likely to be
  bot-blocked; test this once deployed.
