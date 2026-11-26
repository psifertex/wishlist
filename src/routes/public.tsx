import { and, asc, eq, isNull } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { getDb } from "../db";
import { claims, items, listItems, lists, people, type List, type Person } from "../db/schema";
import type { AppEnv, Viewer } from "../env";
import { optionalViewer } from "../lib/auth";
import { newId, newToken, sha256Hex } from "../lib/ids";
import { imageUrl } from "../lib/images";
import { claimedQuantity, isOwnerView, listItemViews, targetList, type ItemView } from "../lib/lists";
import { clientIp, consumeBudget, isRateLimited } from "../lib/limits";
import { formatCents } from "../lib/money";
import { formatEventDate, localDate } from "../lib/time";
import { BUYER_OK_COOKIE, checkBuyerOk, signBuyerOk, turnstileEnabled, verifyTurnstile } from "../lib/turnstile";
import { Flash, Layout, Message } from "../views/layout";
import { mainUrl, safeBack, tooMany } from "./util";

const BUYER_COOKIE = "wl_buyer";
const NAME_COOKIE = "wl_name";
const YEAR_S = 365 * 24 * 60 * 60;

export const publicRoutes = new Hono<AppEnv>();

/** Login cookies only exist on the main host, so person hostnames are always anonymous. */
async function viewerFor(c: Context<AppEnv>): Promise<Viewer | null> {
  return c.get("site").kind === "main" ? optionalViewer(c) : null;
}

function listPath(c: Context<AppEnv>, person: Person, list: List): string {
  return c.get("site").kind === "person" ? `/${list.slug}` : `/${person.slug}/${list.slug}`;
}

function cookieOpts(c: Context<AppEnv>) {
  return { path: "/", httpOnly: true, sameSite: "Lax" as const, secure: new URL(c.req.url).protocol === "https:", maxAge: YEAR_S };
}

publicRoutes.get("/", async (c) => {
  const site = c.get("site");
  if (site.kind === "person") return renderPersonList(c, site.person, null);
  const viewer = await optionalViewer(c);
  if (viewer) return c.redirect("/app");
  return c.html(
    <Message title="Family wishlists">
      <p>Log in to manage your lists. If someone sent you a link to their list, open that link to see it.</p>
      <p>
        <a class="btn primary" href="/app">
          Log in
        </a>
      </p>
    </Message>,
  );
});

publicRoutes.get("/img/:key{.+}", async (c) => {
  const obj = await c.env.IMAGES.get(c.req.param("key"));
  if (!obj) return c.notFound();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  return new Response(obj.body, { headers });
});

publicRoutes.post("/api/buying", async (c) => {
  const form = await c.req.parseBody();
  const back = safeBack(String(form.back ?? "/"));
  if (await isRateLimited(c.env.RL_CLAIM, `buying:${clientIp(c)}`)) return tooMany(c);
  const ok = await verifyTurnstile(c.env, String(form["cf-turnstile-response"] ?? ""), clientIp(c));
  if (!ok) return c.redirect(back);
  setCookie(c, BUYER_OK_COOKIE, await signBuyerOk(c.env), { ...cookieOpts(c), maxAge: 24 * 60 * 60 });
  return c.redirect(back);
});

publicRoutes.post("/api/claim", async (c) => {
  if (await isRateLimited(c.env.RL_CLAIM, `claim:${clientIp(c)}`)) return tooMany(c);
  const form = await c.req.parseBody();
  const back = safeBack(String(form.back ?? "/"));
  const fail = (msg: string) => c.redirect(`${withParam(back, "err", msg)}`);
  if (!(await checkBuyerOk(c.env, getCookie(c, BUYER_OK_COOKIE)))) return c.redirect(back);

  const buyerName = String(form.name ?? "").trim().slice(0, 60);
  const quantity = Math.max(1, Math.min(99, Number.parseInt(String(form.quantity ?? "1"), 10) || 1));
  if (!buyerName) return fail("Please enter your name so others know who's getting it.");

  const db = getDb(c.env.DB);
  const listId = String(form.list ?? "");
  const itemId = String(form.item ?? "");
  const row = await db
    .select({ item: items, list: lists })
    .from(listItems)
    .innerJoin(items, eq(items.id, listItems.itemId))
    .innerJoin(lists, eq(lists.id, listItems.listId))
    .where(and(eq(listItems.listId, listId), eq(listItems.itemId, itemId)))
    .get();
  if (!row || row.list.archivedAt || row.item.receivedAt || row.item.ownerHiddenAt) {
    return fail("That item isn't available any more.");
  }
  const site = c.get("site");
  if (site.kind === "person" && site.person.id !== row.list.personId) return fail("That item isn't on this list.");
  const viewer = await viewerFor(c);
  if (viewer && viewer.person.id === row.list.personId) return fail("You can't claim items on your own list.");

  const remaining = row.item.quantity - (await claimedQuantity(db, itemId));
  if (remaining <= 0) return fail("Someone else is already getting that one.");
  if (!(await consumeBudget(c.env.DB, "claim"))) return fail("Too many claims today; please try again tomorrow.");

  let token = getCookie(c, BUYER_COOKIE);
  if (!token || token.length < 20) {
    token = newToken();
    setCookie(c, BUYER_COOKIE, token, cookieOpts(c));
  }
  setCookie(c, NAME_COOKIE, encodeURIComponent(buyerName), { ...cookieOpts(c), httpOnly: false });
  await db.insert(claims).values({
    id: newId(),
    itemId,
    listId,
    quantity: Math.min(quantity, remaining),
    buyerName,
    buyerPersonId: viewer?.person.id ?? null,
    anonTokenHash: await sha256Hex(token),
    createdAt: Date.now(),
  });
  return c.redirect(`${back}#item-${itemId}`);
});

publicRoutes.post("/api/claim/:id/undo", async (c) => {
  if (await isRateLimited(c.env.RL_CLAIM, `claim:${clientIp(c)}`)) return tooMany(c);
  const form = await c.req.parseBody();
  const back = safeBack(String(form.back ?? "/"));
  const db = getDb(c.env.DB);
  const claim = await db.select().from(claims).where(eq(claims.id, c.req.param("id"))).get();
  if (!claim || claim.revokedAt) return c.redirect(back);
  const token = getCookie(c, BUYER_COOKIE);
  const viewer = await viewerFor(c);
  const mine =
    (!!token && claim.anonTokenHash === (await sha256Hex(token))) ||
    (!!viewer && claim.buyerPersonId === viewer.person.id);
  if (!mine) return c.redirect(withParam(back, "err", "Only the person who claimed it can undo that."));
  await db.update(claims).set({ revokedAt: Date.now() }).where(eq(claims.id, claim.id));
  return c.redirect(`${back}#item-${claim.itemId}`);
});

// Person hostname: /<list-slug>. Main host: /<person-slug> and /<person-slug>/<list-slug>.
publicRoutes.get("/:a/:b?", async (c) => {
  const site = c.get("site");
  const db = getDb(c.env.DB);
  const a = c.req.param("a");
  const b = c.req.param("b");
  if (site.kind === "person") {
    if (b) return c.notFound();
    return renderPersonList(c, site.person, a);
  }
  const person = await db.select().from(people).where(eq(people.slug, a)).get();
  if (!person) return c.notFound();
  return renderPersonList(c, person, b ?? null);
});

function withParam(path: string, key: string, value: string): string {
  const u = new URL(path, "http://x");
  u.searchParams.set(key, value);
  return `${u.pathname}${u.search}`;
}

async function renderPersonList(c: Context<AppEnv>, person: Person, listSlug: string | null) {
  if (await isRateLimited(c.env.RL_PUBLIC, `page:${clientIp(c)}`)) return tooMany(c);
  const db = getDb(c.env.DB);
  const now = Date.now();
  const list = listSlug
    ? await db
        .select()
        .from(lists)
        .where(and(eq(lists.personId, person.id), eq(lists.slug, listSlug), isNull(lists.archivedAt)))
        .get()
    : await targetList(db, person.id, localDate(now, c.env.TIMEZONE));
  if (!list) {
    return c.html(<Message title={`${person.displayName}'s wishlist`}>Nothing here yet.</Message>, 404);
  }

  const viewer = await viewerFor(c);
  const token = getCookie(c, BUYER_COOKIE);
  const perspective = {
    viewer,
    anonTokenHash: token ? await sha256Hex(token) : null,
    now,
    timeZone: c.env.TIMEZONE,
  };
  const owner = isOwnerView(person.id, perspective);
  const wantsBuying = c.req.query("buying") === "1" && !owner;
  const here = listPath(c, person, list);
  const main = mainUrl(c);

  if (wantsBuying && !(await checkBuyerOk(c.env, getCookie(c, BUYER_OK_COOKIE)))) {
    return c.html(
      <Layout
        title={`${person.displayName}: ${list.name}`}
        mainUrl={main}
        head={<script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script>}
      >
        <section class="card narrow">
          <h1>Buying for {person.displayName}?</h1>
          <p>One quick check that you're a person, then you'll see what's already taken.</p>
          <form method="post" action="/api/buying">
            <input type="hidden" name="back" value={`${here}?buying=1`} />
            <div class="cf-turnstile" data-sitekey={c.env.TURNSTILE_SITE_KEY}></div>
            <p>
              <button class="primary" type="submit">
                Continue
              </button>
            </p>
          </form>
        </section>
      </Layout>,
    );
  }

  const [views, otherLists] = await Promise.all([
    listItemViews(db, list, perspective),
    db
      .select()
      .from(lists)
      .where(and(eq(lists.personId, person.id), isNull(lists.archivedAt)))
      .orderBy(asc(lists.createdAt))
      .all(),
  ]);
  const savedName = decodeURIComponent(getCookie(c, NAME_COOKIE) ?? "");
  const back = wantsBuying ? `${here}?buying=1` : here;

  return c.html(
    <Layout title={`${person.displayName}: ${list.name}`} viewer={viewer} mainUrl={main}>
      <h1>
        {person.displayName}: {list.name}
      </h1>
      {list.eventDate && <p class="muted">For {formatEventDate(list.eventDate)}</p>}
      {otherLists.length > 1 && (
        <nav class="tabs">
          {otherLists.map((l) => (
            <a class={l.id === list.id ? "current" : ""} href={listPath(c, person, l) + (wantsBuying ? "?buying=1" : "")}>
              {l.name}
            </a>
          ))}
        </nav>
      )}
      <Flash msg={c.req.query("err")} kind="error" />
      {owner ? (
        <div class="banner">
          This is your list. Things people have bought for you stay hidden until{" "}
          {list.eventDate ? formatEventDate(list.eventDate) : "about two months after they're bought"}.{" "}
          <a href={`${main}/app/lists/${list.id}`}>Edit this list</a>
        </div>
      ) : wantsBuying ? (
        <div class="banner">
          You're seeing what's already been bought. If this is <strong>your</strong> list, you'll spoil your surprises:{" "}
          <a href={here}>go back</a>.
        </div>
      ) : (
        <div class="banner">
          <p style="margin-top:0">Want to get something from this list?</p>
          <div class="actions">
            <a class="btn primary" href={`${here}?buying=1`}>
              I'm buying a gift
            </a>
            <a class="btn" href={`${main}/app`}>
              Log in
            </a>
          </div>
        </div>
      )}
      {views.length === 0 ? (
        <p class="muted">Nothing on this list yet.</p>
      ) : (
        <ul class="items">
          {views.map((v) => (
            <ItemCard c={c} v={v} list={list} buying={wantsBuying} owner={owner} back={back} savedName={savedName} />
          ))}
        </ul>
      )}
    </Layout>,
  );
}

function ItemCard(props: {
  c: Context<AppEnv>;
  v: ItemView;
  list: List;
  buying: boolean;
  owner: boolean;
  back: string;
  savedName: string;
}) {
  const { c, v, list, buying, owner, back, savedName } = props;
  const { item } = v;
  const img = imageUrl(c.env, item.imageKey);
  const done = v.remainingQty === 0;
  const showStatus = buying || owner;
  return (
    <li class={`item${buying && done ? " claimed" : ""}`} id={`item-${item.id}`}>
      {img ? <img src={img} alt="" loading="lazy" /> : <div class="noimg">🎁</div>}
      <div>
        <h3>
          {item.url ? (
            <a href={item.url} rel="noopener noreferrer nofollow" target="_blank">
              {item.title}
            </a>
          ) : (
            item.title
          )}
        </h3>
        <div class="meta">
          {[
            item.format && item.format !== "any" ? item.format : null,
            item.variantText,
            item.quantity > 1 ? `wants ${item.quantity}` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </div>
        {item.priceCents != null && (
          <div class="meta">
            {formatCents(item.priceCents, item.currency)}
            {item.priceCapturedAt && ` when added (${new Date(item.priceCapturedAt).toLocaleDateString("en-US")})`}
          </div>
        )}
        {item.notes && <p style="margin:4px 0">{item.notes}</p>}
        <div class="actions">
          {item.priority > 0 && <span class="pill hot">Really wants this</span>}
          {showStatus && done && <span class="pill ok">{owner ? "Bought for you" : "Already taken"}</span>}
          {showStatus && !done && v.claimedQty > 0 && (
            <span class="pill">
              {v.claimedQty} of {item.quantity} taken
            </span>
          )}
        </div>
        {buying &&
          v.claims
            .filter((cl) => cl.mine)
            .map((cl) => (
              <form class="inline" method="post" action={`/api/claim/${cl.claim.id}/undo`}>
                <input type="hidden" name="back" value={back} />
                <span>
                  ✓ {cl.claim.buyerName} is getting {cl.claim.quantity > 1 ? `${cl.claim.quantity} of these` : "this"}.
                </span>
                <button class="small" type="submit">
                  Undo
                </button>
              </form>
            ))}
        {buying && !done && !item.ownerHiddenAt && (
          <form class="inline" method="post" action="/api/claim">
            <input type="hidden" name="back" value={back} />
            <input type="hidden" name="list" value={list.id} />
            <input type="hidden" name="item" value={item.id} />
            <input type="text" name="name" placeholder="Your name" value={savedName} required maxlength={60} />
            {v.remainingQty > 1 && (
              <input type="number" name="quantity" min={1} max={v.remainingQty} value={1} aria-label="How many" />
            )}
            <button class="primary small" type="submit">
              I'm getting this
            </button>
          </form>
        )}
      </div>
    </li>
  );
}
