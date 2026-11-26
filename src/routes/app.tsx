import { and, asc, count, desc, eq, inArray, isNotNull, isNull, max, notInArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getDb, type Db } from "../db";
import {
  BOOK_FORMATS,
  claims,
  hostnames,
  items,
  listItems,
  lists,
  people,
  users,
  type BookFormat,
  type Item,
  type List,
  type Person,
} from "../db/schema";
import type { AppEnv, Viewer } from "../env";
import { canEditPerson, resolveLogin, verifiedEmail } from "../lib/auth";
import { decodeCapture, openLibraryCover } from "../lib/capture";
import { newId } from "../lib/ids";
import { imageUrl, saveImageBytes, saveImageFromUrl } from "../lib/images";
import { CAPS, isRateLimited } from "../lib/limits";
import { itemViewsFor, type ItemView } from "../lib/lists";
import { formatCents, parsePriceToCents } from "../lib/money";
import { uniqueListSlug } from "../lib/people";
import { formatEventDate, isIsoDate } from "../lib/time";
import { Flash, Layout, Message } from "../views/layout";
import { all, int, mainUrl, str, strOrNull, tooMany } from "./util";

export const appRoutes = new Hono<AppEnv>();

/** Main host only; requires an approved login (R1, R4b). */
const requireLogin = createMiddleware<AppEnv>(async (c, next) => {
  if (c.get("site").kind !== "main") return c.redirect(`${mainUrl(c)}${new URL(c.req.url).pathname}`);
  const email = await verifiedEmail(c);
  if (!email) {
    const configured = !!c.env.ACCESS_TEAM_DOMAIN && !!c.env.ACCESS_AUD;
    return c.html(
      configured ? (
        <Message title="Please log in">
          <p>Your login wasn't found or has expired. Reload this page to log in again.</p>
        </Message>
      ) : (
        <Message title="Login isn't set up yet">
          <p>
            This site's login (Cloudflare Access) hasn't been configured, so nobody can log in yet. Shared list links
            still work.
          </p>
          <p class="muted">
            Admins: set ACCESS_TEAM_DOMAIN and ACCESS_AUD in the deploy config. See the README.
          </p>
        </Message>
      ),
      401,
    );
  }
  const state = await resolveLogin(c.env, email);
  if (state.kind === "active") {
    if (c.req.method === "POST" && (await isRateLimited(c.env.RL_WRITE, `write:${email}`))) return tooMany(c);
    c.set("viewer", state.viewer);
    return next();
  }
  if (state.kind === "pending") {
    if (c.req.method === "POST" && new URL(c.req.url).pathname === "/app/request") {
      const form = await c.req.parseBody();
      const name = String(form.name ?? "").trim().slice(0, 60);
      if (name) await getDb(c.env.DB).update(users).set({ requestedName: name }).where(eq(users.email, email));
      return c.redirect("/app");
    }
    return c.html(
      <Message title="Waiting for approval">
        <p>
          Your request is waiting for an admin to approve it. You're signed in as <strong>{email}</strong>.
        </p>
        <form method="post" action="/app/request">
          <label for="name">Your name, so the admins know who you are</label>
          <input id="name" type="text" name="name" value={state.user.requestedName ?? ""} maxlength={60} />
          <p>
            <button type="submit">Save</button>
          </p>
        </form>
      </Message>,
      403,
    );
  }
  if (state.kind === "queue_full") {
    return c.html(
      <Message title="Not available right now">
        <p>Too many people are waiting for approval. Please ask a family admin to add you.</p>
      </Message>,
      403,
    );
  }
  return c.html(
    <Message title="Not approved">
      <p>This login hasn't been approved. Ask a family admin if you think that's a mistake.</p>
    </Message>,
    403,
  );
});

appRoutes.use("/app", requireLogin);
appRoutes.use("/app/*", requireLogin);
appRoutes.use("/add", requireLogin);

// ---------------------------------------------------------------- helpers

async function editablePeople(db: Db, viewer: Viewer): Promise<Person[]> {
  const rows = viewer.isAdmin
    ? await db.select().from(people).orderBy(asc(people.displayName)).all()
    : await db
        .select()
        .from(people)
        .where(inArray(people.id, [viewer.person.id, ...viewer.managedIds]))
        .orderBy(asc(people.displayName))
        .all();
  // Own lists first.
  return [...rows.filter((p) => p.id === viewer.person.id), ...rows.filter((p) => p.id !== viewer.person.id)];
}

async function publicUrlFor(c: Context<AppEnv>, db: Db, person: Person): Promise<string> {
  const host = await db.select().from(hostnames).where(eq(hostnames.personId, person.id)).get();
  if (!host) return `${mainUrl(c)}/${person.slug}`;
  const u = new URL(c.req.url);
  const port = u.port && c.env.ENVIRONMENT === "development" ? `:${u.port}` : "";
  return `${u.protocol}//${host.hostname}${port}`;
}

async function loadEditableList(c: Context<AppEnv>, id: string): Promise<{ list: List; owner: Person } | null> {
  const db = getDb(c.env.DB);
  const row = await db
    .select({ list: lists, owner: people })
    .from(lists)
    .innerJoin(people, eq(people.id, lists.personId))
    .where(eq(lists.id, id))
    .get();
  if (!row || !canEditPerson(c.get("viewer"), row.owner.id)) return null;
  return row;
}

async function loadEditableItem(c: Context<AppEnv>, id: string): Promise<{ item: Item; owner: Person } | null> {
  const db = getDb(c.env.DB);
  const row = await db
    .select({ item: items, owner: people })
    .from(items)
    .innerJoin(people, eq(people.id, items.personId))
    .where(eq(items.id, id))
    .get();
  if (!row || !canEditPerson(c.get("viewer"), row.owner.id)) return null;
  return row;
}

function perspective(c: Context<AppEnv>) {
  return { viewer: c.get("viewer"), anonTokenHash: null, now: Date.now(), timeZone: c.env.TIMEZONE };
}

async function nextPosition(db: Db, listId: string): Promise<number> {
  const row = await db.select({ p: max(listItems.position) }).from(listItems).where(eq(listItems.listId, listId)).get();
  return (row?.p ?? -1) + 1;
}

const notFound = (c: Context<AppEnv>) => c.html(<Message title="Not found">That doesn't exist, or it isn't yours to edit.</Message>, 404);

// ---------------------------------------------------------------- dashboard

appRoutes.get("/app", async (c) => {
  const viewer = c.get("viewer");
  const db = getDb(c.env.DB);
  const ppl = await editablePeople(db, viewer);
  const allLists = await db
    .select({ list: lists, n: count(listItems.itemId) })
    .from(lists)
    .leftJoin(listItems, eq(listItems.listId, lists.id))
    .where(and(inArray(lists.personId, ppl.map((p) => p.id)), isNull(lists.archivedAt)))
    .groupBy(lists.id)
    .orderBy(asc(lists.createdAt))
    .all();
  const pending = viewer.isAdmin
    ? ((await db.select({ n: count() }).from(users).where(eq(users.status, "pending")).get())?.n ?? 0)
    : 0;
  const urls = new Map<string, string>();
  for (const p of ppl) urls.set(p.id, await publicUrlFor(c, db, p));

  return c.html(
    <Layout title="My lists" viewer={viewer}>
      {pending > 0 && (
        <p class="banner">
          {pending} {pending === 1 ? "person is" : "people are"} waiting for approval.{" "}
          <a href="/app/admin">Review requests</a>
        </p>
      )}
      <div class="actions">
        <a class="btn primary" href="/add">
          Add an item
        </a>
        <a class="btn" href="/install">
          Install the "Add to Wishlist" button
        </a>
      </div>
      {ppl.map((p) => (
        <section class="card">
          <h2 style="margin-top:0">{p.id === viewer.person.id ? "My lists" : `${p.displayName}'s lists`}</h2>
          <p class="muted">
            Share: <a href={urls.get(p.id)}>{urls.get(p.id)}</a>
          </p>
          <table>
            <tbody>
              {allLists
                .filter((r) => r.list.personId === p.id)
                .map(({ list, n }) => (
                  <tr>
                    <td>
                      <a href={`/app/lists/${list.id}`}>{list.name}</a> {list.isDefault && <span class="pill">default</span>}
                    </td>
                    <td class="muted">{list.eventDate ? formatEventDate(list.eventDate) : "no date"}</td>
                    <td class="muted">
                      {n} {n === 1 ? "item" : "items"}
                    </td>
                  </tr>
                ))}
            </tbody>
          </table>
          <div class="actions" style="margin-top:8px">
            <a class="btn small" href={`/app/lists/new?person=${p.id}`}>
              New list
            </a>
            <a class="btn small" href={`/app/received?person=${p.id}`}>
              Received
            </a>
          </div>
        </section>
      ))}
    </Layout>,
  );
});

// ---------------------------------------------------------------- lists

appRoutes.get("/app/lists/new", async (c) => {
  const viewer = c.get("viewer");
  const personId = c.req.query("person") ?? viewer.person.id;
  if (!canEditPerson(viewer, personId)) return notFound(c);
  const db = getDb(c.env.DB);
  const person = await db.select().from(people).where(eq(people.id, personId)).get();
  if (!person) return notFound(c);
  // R6: offer the person's existing items, grouped by list.
  const rows = await db
    .select({ item: items, list: lists })
    .from(listItems)
    .innerJoin(items, eq(items.id, listItems.itemId))
    .innerJoin(lists, eq(lists.id, listItems.listId))
    .where(and(eq(items.personId, personId), isNull(items.receivedAt), isNull(items.ownerHiddenAt), isNull(lists.archivedAt)))
    .orderBy(asc(lists.createdAt), asc(listItems.position))
    .all();
  const groups = new Map<string, { list: List; items: Item[] }>();
  for (const r of rows) {
    const g = groups.get(r.list.id) ?? { list: r.list, items: [] };
    g.items.push(r.item);
    groups.set(r.list.id, g);
  }
  return c.html(
    <Layout title="New list" viewer={viewer}>
      <h1>New list for {person.displayName}</h1>
      <form method="post" action="/app/lists" class="card">
        <input type="hidden" name="person" value={person.id} />
        <label for="name">Name</label>
        <input id="name" type="text" name="name" required maxlength={60} placeholder="Birthday 2027" />
        <label for="event">Event date (optional)</label>
        <input id="event" type="date" name="event_date" />
        <p class="muted">Purchases stay hidden from {person.displayName} until this date.</p>
        {groups.size > 0 && <h2>Include items from other lists</h2>}
        {[...groups.values()].map((g) => (
          <fieldset class="card">
            <legend>
              <label class="check">
                <input type="checkbox" data-group={g.list.id} onclick={toggleGroupJs} /> {g.list.name} (all)
              </label>
            </legend>
            {g.items.map((it) => (
              <label class="check">
                <input type="checkbox" name="items" value={it.id} data-in={g.list.id} /> {it.title}
              </label>
            ))}
          </fieldset>
        ))}
        <p>
          <button class="primary" type="submit">
            Create list
          </button>
        </p>
      </form>
    </Layout>,
  );
});

const toggleGroupJs =
  "document.querySelectorAll('[data-in=\"'+this.dataset.group+'\"]').forEach(function(b){b.checked=this.checked}.bind(this))";

appRoutes.post("/app/lists", async (c) => {
  const viewer = c.get("viewer");
  const form = await c.req.parseBody({ all: true });
  const personId = str(form, "person", 40);
  if (!canEditPerson(viewer, personId)) return notFound(c);
  const name = str(form, "name", 60) || "Wishlist";
  const eventDate = str(form, "event_date", 10);
  const db = getDb(c.env.DB);
  const existing = await db.select({ n: count() }).from(lists).where(eq(lists.personId, personId)).get();
  if ((existing?.n ?? 0) >= CAPS.listsPerPerson) return c.text("List limit reached.", 400);
  const id = newId();
  await db.insert(lists).values({
    id,
    personId,
    name,
    slug: await uniqueListSlug(db, personId, name),
    eventDate: isIsoDate(eventDate) ? eventDate : null,
    createdAt: Date.now(),
  });
  const chosen = [...new Set(all(form, "items"))];
  if (chosen.length) {
    const own = await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.personId, personId), inArray(items.id, chosen)))
      .all();
    if (own.length) await db.insert(listItems).values(own.map((r, i) => ({ listId: id, itemId: r.id, position: i })));
  }
  return c.redirect(`/app/lists/${id}`);
});

appRoutes.get("/app/lists/:id", async (c) => {
  const viewer = c.get("viewer");
  const found = await loadEditableList(c, c.req.param("id"));
  if (!found) return notFound(c);
  const { list, owner } = found;
  const db = getDb(c.env.DB);
  const rows = await db
    .select({ item: items, position: listItems.position })
    .from(listItems)
    .innerJoin(items, eq(items.id, listItems.itemId))
    .where(and(eq(listItems.listId, list.id), isNull(items.receivedAt)))
    .orderBy(asc(listItems.position), asc(items.createdAt))
    .all();
  const views = await itemViewsFor(db, owner.id, rows, perspective(c));
  const onList = rows.map((r) => r.item.id);
  const others = await db
    .select()
    .from(items)
    .where(
      and(
        eq(items.personId, owner.id),
        isNull(items.receivedAt),
        isNull(items.ownerHiddenAt),
        onList.length ? notInArray(items.id, onList) : undefined,
      ),
    )
    .orderBy(desc(items.createdAt))
    .all();
  const isOwner = owner.id === viewer.person.id;
  const publicUrl = await publicUrlFor(c, db, owner);

  return c.html(
    <Layout title={list.name} viewer={viewer}>
      <p class="muted">
        <a href="/app">My lists</a> / {owner.displayName}
      </p>
      <h1>{list.name}</h1>
      <p class="muted">
        Public link:{" "}
        <a href={`${publicUrl.replace(/\/$/, "")}/${list.slug}`}>{`${publicUrl.replace(/\/$/, "")}/${list.slug}`}</a>
      </p>
      <div class="actions">
        <a class="btn primary" href={`/add?list=${list.id}`}>
          Add an item
        </a>
      </div>
      {!isOwner && <p class="muted">You manage this list, so you can see what's been bought.</p>}
      <ul class="items">
        {views.map((v, i) => (
          <ManageItem c={c} v={v} list={list} first={i === 0} last={i === views.length - 1} showClaims={!isOwner} />
        ))}
      </ul>
      {views.length === 0 && <p class="muted">No items yet.</p>}

      {others.length > 0 && (
        <form method="post" action={`/app/lists/${list.id}/include`} class="card">
          <h2 style="margin-top:0">Add items from {owner.displayName}'s other lists</h2>
          {others.map((it) => (
            <label class="check">
              <input type="checkbox" name="items" value={it.id} /> {it.title}
            </label>
          ))}
          <p>
            <button type="submit">Add selected</button>
          </p>
        </form>
      )}

      <form method="post" action={`/app/lists/${list.id}`} class="card">
        <h2 style="margin-top:0">List settings</h2>
        <label for="name">Name</label>
        <input id="name" type="text" name="name" value={list.name} required maxlength={60} />
        <label for="event">Event date</label>
        <input id="event" type="date" name="event_date" value={list.eventDate ?? ""} />
        <label class="check">
          <input type="checkbox" name="is_default" value="1" checked={list.isDefault} /> Default list (shown when no
          event is coming up)
        </label>
        <label class="check">
          <input type="checkbox" name="archive" value="1" /> Archive this list
        </label>
        <p>
          <button type="submit">Save</button>
        </p>
      </form>
    </Layout>,
  );
});

function ManageItem(props: { c: Context<AppEnv>; v: ItemView; list: List; first: boolean; last: boolean; showClaims: boolean }) {
  const { c, v, list, first, last, showClaims } = props;
  const img = imageUrl(c.env, v.item.imageKey, v.item.sourceImageUrl);
  return (
    <li class="item">
      {img ? <img src={img} alt="" loading="lazy" /> : <div class="noimg">🎁</div>}
      <div>
        <h3>
          <a href={`/app/items/${v.item.id}?list=${list.id}`}>{v.item.title}</a>
        </h3>
        <div class="meta">
          {[formatCents(v.item.priceCents, v.item.currency), v.item.format, v.item.variantText].filter(Boolean).join(" · ")}
        </div>
        {showClaims &&
          v.claims.map((cl) => (
            <div class="meta">
              🎁 {cl.claim.buyerName} is getting {cl.claim.quantity > 1 ? cl.claim.quantity : "it"}
            </div>
          ))}
        {!showClaims && v.claims.length > 0 && <span class="pill ok">Bought for you</span>}
        <div class="actions" style="margin-top:6px">
          {!first && (
            <form class="inline" method="post" action={`/app/lists/${list.id}/move/${v.item.id}?dir=up`}>
              <button class="small" type="submit" aria-label="Move up">
                ↑
              </button>
            </form>
          )}
          {!last && (
            <form class="inline" method="post" action={`/app/lists/${list.id}/move/${v.item.id}?dir=down`}>
              <button class="small" type="submit" aria-label="Move down">
                ↓
              </button>
            </form>
          )}
          <form class="inline" method="post" action={`/app/lists/${list.id}/remove/${v.item.id}`}>
            <button class="small" type="submit">
              Remove from list
            </button>
          </form>
        </div>
      </div>
    </li>
  );
}

appRoutes.post("/app/lists/:id", async (c) => {
  const found = await loadEditableList(c, c.req.param("id"));
  if (!found) return notFound(c);
  const { list } = found;
  const form = await c.req.parseBody();
  const db = getDb(c.env.DB);
  const eventDate = str(form, "event_date", 10);
  const makeDefault = str(form, "is_default") === "1";
  const archive = str(form, "archive") === "1";
  if (makeDefault && !list.isDefault) {
    await db.update(lists).set({ isDefault: false }).where(eq(lists.personId, list.personId));
  }
  await db
    .update(lists)
    .set({
      name: str(form, "name", 60) || list.name,
      eventDate: isIsoDate(eventDate) ? eventDate : null,
      isDefault: makeDefault || (list.isDefault && !archive),
      archivedAt: archive ? Date.now() : null,
    })
    .where(eq(lists.id, list.id));
  return c.redirect(archive ? "/app" : `/app/lists/${list.id}`);
});

appRoutes.post("/app/lists/:id/include", async (c) => {
  const found = await loadEditableList(c, c.req.param("id"));
  if (!found) return notFound(c);
  const form = await c.req.parseBody({ all: true });
  const chosen = [...new Set(all(form, "items"))];
  const db = getDb(c.env.DB);
  if (chosen.length) {
    const own = await db
      .select({ id: items.id })
      .from(items)
      .where(and(eq(items.personId, found.list.personId), inArray(items.id, chosen)))
      .all();
    let pos = await nextPosition(db, found.list.id);
    if (own.length) {
      await db
        .insert(listItems)
        .values(own.map((r) => ({ listId: found.list.id, itemId: r.id, position: pos++ })))
        .onConflictDoNothing();
    }
  }
  return c.redirect(`/app/lists/${found.list.id}`);
});

appRoutes.post("/app/lists/:id/remove/:itemId", async (c) => {
  const found = await loadEditableList(c, c.req.param("id"));
  if (!found) return notFound(c);
  await getDb(c.env.DB)
    .delete(listItems)
    .where(and(eq(listItems.listId, found.list.id), eq(listItems.itemId, c.req.param("itemId"))));
  return c.redirect(`/app/lists/${found.list.id}`);
});

appRoutes.post("/app/lists/:id/move/:itemId", async (c) => {
  const found = await loadEditableList(c, c.req.param("id"));
  if (!found) return notFound(c);
  const db = getDb(c.env.DB);
  const rows = await db
    .select({ itemId: listItems.itemId })
    .from(listItems)
    .innerJoin(items, eq(items.id, listItems.itemId))
    .where(eq(listItems.listId, found.list.id))
    .orderBy(asc(listItems.position), asc(items.createdAt))
    .all();
  const order = rows.map((r) => r.itemId);
  const i = order.indexOf(c.req.param("itemId"));
  const j = c.req.query("dir") === "up" ? i - 1 : i + 1;
  if (i >= 0 && j >= 0 && j < order.length) {
    [order[i], order[j]] = [order[j]!, order[i]!];
    await db.batch(
      order.map((itemId, pos) =>
        db.update(listItems).set({ position: pos }).where(and(eq(listItems.listId, found.list.id), eq(listItems.itemId, itemId))),
      ) as [any, ...any[]],
    );
  }
  return c.redirect(`/app/lists/${found.list.id}`);
});

// ---------------------------------------------------------------- items

async function editableLists(db: Db, viewer: Viewer) {
  const ppl = await editablePeople(db, viewer);
  const ls = await db
    .select()
    .from(lists)
    .where(and(inArray(lists.personId, ppl.map((p) => p.id)), isNull(lists.archivedAt)))
    .orderBy(asc(lists.createdAt))
    .all();
  return { ppl, ls };
}

function ItemFields(props: { item?: Partial<Item>; priceRequired?: boolean }) {
  const it = props.item ?? {};
  return (
    <>
      <label for="title">What is it?</label>
      <input id="title" type="text" name="title" required maxlength={200} value={it.title ?? ""} />
      <label for="url">Link (optional)</label>
      <input id="url" type="url" name="url" maxlength={2000} value={it.url ?? ""} placeholder="https://…" />
      <div class="row">
        <div>
          <label for="price">Price</label>
          <input
            id="price"
            type="text"
            name="price"
            inputmode="decimal"
            placeholder="$0.00"
            required={props.priceRequired}
            value={it.priceCents != null ? (it.priceCents / 100).toFixed(2) : ""}
          />
        </div>
        <div>
          <label for="quantity">How many?</label>
          <input id="quantity" type="number" name="quantity" min={1} max={99} value={it.quantity ?? 1} />
        </div>
      </div>
      <label for="variant">Size, color, or other option</label>
      <input id="variant" type="text" name="variant" maxlength={200} value={it.variantText ?? ""} />
      <div class="row">
        <div>
          <label for="format">Book format</label>
          <select id="format" name="format">
            <option value="">Not a book</option>
            {BOOK_FORMATS.map((f) => (
              <option value={f} selected={it.format === f}>
                {f === "any" ? "Any format" : f[0]!.toUpperCase() + f.slice(1)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label for="isbn">ISBN</label>
          <input id="isbn" type="text" name="isbn" maxlength={20} value={it.isbn ?? ""} />
        </div>
      </div>
      <label for="notes">Notes</label>
      <textarea id="notes" name="notes" maxlength={1000}>
        {it.notes ?? ""}
      </textarea>
      <label class="check">
        <input type="checkbox" name="priority" value="1" checked={(it.priority ?? 0) > 0} /> I really want this
      </label>
      {it.asin && <input type="hidden" name="asin" value={it.asin} />}
    </>
  );
}

/**
 * Image choice (R24): pick one of the captured images or none, or upload a
 * photo. public/add.js downloads and shrinks the chosen image in the browser
 * when the store allows it; otherwise the Worker downloads it (R27a).
 */
function ImageFields(props: { candidates?: string[]; keepLabel?: string; canUpload?: boolean }) {
  const candidates = props.candidates ?? [];
  return (
    <fieldset class="card">
      <legend>Picture</legend>
      {candidates.length > 0 ? (
        <div class="picker">
          {candidates.map((src, i) => (
            <label class="pick">
              <input type="radio" name="image_url" value={src} checked={i === 0} />
              <img src={src} alt={`Option ${i + 1}`} loading="lazy" referrerpolicy="no-referrer" onerror="this.closest('label').remove()" />
            </label>
          ))}
          <label class="pick none">
            <input type="radio" name="image_url" value="" />
            <span>No picture</span>
          </label>
        </div>
      ) : (
        <>
          <label for="image_url">Image link</label>
          <input id="image_url" type="url" name="image_url" maxlength={2000} placeholder={props.keepLabel ?? "https://…"} />
        </>
      )}
      {props.canUpload !== false && (
        <>
          <label for="image_file">…or upload a photo</label>
          <input id="image_file" type="file" name="image_file" accept="image/*" />
        </>
      )}
    </fieldset>
  );
}

function itemValues(form: Record<string, string | File | (string | File)[]>) {
  const format = str(form, "format", 20);
  const priceCents = parsePriceToCents(str(form, "price", 20));
  const url = strOrNull(form, "url", 2000);
  return {
    title: str(form, "title", 200) || "Untitled",
    url: url && /^https?:\/\//i.test(url) ? url : null,
    variantText: strOrNull(form, "variant", 200),
    format: (BOOK_FORMATS as readonly string[]).includes(format) ? (format as BookFormat) : null,
    isbn: strOrNull(form, "isbn", 20)?.replace(/[^0-9Xx]/g, "") || null,
    asin: strOrNull(form, "asin", 20),
    notes: strOrNull(form, "notes", 1000),
    priority: str(form, "priority") === "1" ? 1 : 0,
    quantity: int(form, "quantity", 1, 99, 1),
    priceCents,
  };
}

/** Saves an uploaded file or downloads the image link (R27a). Returns key or error. */
async function imageFromForm(
  c: Context<AppEnv>,
  form: Record<string, string | File | (string | File)[]>,
): Promise<{ key?: string; source?: string | null; error?: string }> {
  if (!c.env.IMAGES) {
    // No picture storage: remember the chosen link and show it directly.
    const link = str(form, "image_url", 2000);
    return link && /^https:\/\//.test(link) ? { source: link } : {};
  }
  const file = form.image_file;
  if (file instanceof File && file.size > 0) {
    if (file.size > CAPS.imageBytes) return { error: "That photo is larger than 2 MB." };
    const r = await saveImageBytes(c.env, await file.arrayBuffer(), file.type);
    return r.ok ? { key: r.key, source: null } : { error: r.reason };
  }
  const link = str(form, "image_url", 2000);
  if (!link) return {};
  const r = await saveImageFromUrl(c.env, link);
  return r.ok ? { key: r.key, source: link } : { error: r.reason, source: link };
}

appRoutes.get("/add", async (c) => {
  const viewer = c.get("viewer");
  const db = getDb(c.env.DB);
  const { ppl, ls } = await editableLists(db, viewer);
  const selected = c.req.query("list");
  const names = new Map(ppl.map((p) => [p.id, p.id === viewer.person.id ? "My" : `${p.displayName}'s`]));

  // Pre-fill from the capture script (?d=) or the CSP fallback (?url=&title=).
  const cap = decodeCapture(c.req.query("d"));
  const fallbackUrl = c.req.query("url");
  const prefill: Partial<Item> = cap
    ? {
        title: cap.title,
        url: cap.url,
        priceCents: cap.priceCents ?? null,
        variantText: cap.variant ?? null,
        format: cap.format ?? null,
        isbn: cap.isbn ?? null,
        asin: cap.asin ?? null,
      }
    : { title: c.req.query("title")?.slice(0, 200), url: fallbackUrl && /^https?:\/\//.test(fallbackUrl) ? fallbackUrl : null };
  const candidates = cap ? [...cap.images, ...(cap.isbn ? [openLibraryCover(cap.isbn)] : [])] : [];
  // R24: a captured item must have a price; ask for it when detection failed.
  const priceRequired = !!cap;
  return c.html(
    <Layout title="Add an item" viewer={viewer} head={<script src="/add.js" defer></script>}>
      <h1>Add an item</h1>
      <Flash msg={c.req.query("err")} kind="error" />
      {cap && cap.priceCents == null && <p class="flash">We couldn't find the price on that page. Please type it in.</p>}
      <form method="post" action="/add" enctype="multipart/form-data" class="card" data-image-form>
        <label for="list">Add to</label>
        <select id="list" name="list" required>
          {ls.map((l) => (
            <option value={l.id} selected={selected ? l.id === selected : l.personId === viewer.person.id && l.isDefault}>
              {names.get(l.personId)} {l.name}
            </option>
          ))}
        </select>
        <ItemFields item={prefill} priceRequired={priceRequired} />
        <ImageFields candidates={candidates} canUpload={!!c.env.IMAGES} />
        <p>
          <button class="primary" type="submit">
            Add to list
          </button>
        </p>
      </form>
    </Layout>,
  );
});

appRoutes.post("/add", async (c) => {
  const viewer = c.get("viewer");
  const form = await c.req.parseBody({ all: true });
  const db = getDb(c.env.DB);
  const list = await db.select().from(lists).where(eq(lists.id, str(form, "list", 40))).get();
  if (!list || !canEditPerson(viewer, list.personId)) return notFound(c);
  const existing = await db.select({ n: count() }).from(items).where(eq(items.personId, list.personId)).get();
  if ((existing?.n ?? 0) >= CAPS.itemsPerPerson) return c.text("Item limit reached.", 400);
  const now = Date.now();
  const values = itemValues(form);
  const image = await imageFromForm(c, form);
  const id = newId();
  await db.batch([
    db.insert(items).values({
      id,
      personId: list.personId,
      ...values,
      priceCapturedAt: values.priceCents != null ? now : null,
      imageKey: image.key ?? null,
      sourceImageUrl: image.source ?? null,
      createdByPersonId: viewer.person.id,
      createdAt: now,
    }),
    db.insert(listItems).values({ listId: list.id, itemId: id, position: await nextPosition(db, list.id) }),
  ]);
  const err = image.error ? `?err=${encodeURIComponent(`Item saved, but the image wasn't: ${image.error}`)}` : "";
  return c.redirect(image.error ? `/app/items/${id}${err}` : `/app/lists/${list.id}`);
});

appRoutes.get("/app/items/:id", async (c) => {
  const viewer = c.get("viewer");
  const found = await loadEditableItem(c, c.req.param("id"));
  if (!found) return notFound(c);
  const { item, owner } = found;
  const db = getDb(c.env.DB);
  const ownerLists = await db
    .select()
    .from(lists)
    .where(and(eq(lists.personId, owner.id), isNull(lists.archivedAt)))
    .orderBy(asc(lists.createdAt))
    .all();
  const memberOf = new Set(
    (await db.select({ id: listItems.listId }).from(listItems).where(eq(listItems.itemId, item.id)).all()).map((r) => r.id),
  );
  const img = imageUrl(c.env, item.imageKey, item.sourceImageUrl);
  const back = c.req.query("list");
  return c.html(
    <Layout title={item.title} viewer={viewer} head={<script src="/add.js" defer></script>}>
      <p class="muted">
        <a href={back ? `/app/lists/${back}` : "/app"}>Back</a>
      </p>
      <h1>Edit item</h1>
      <Flash msg={c.req.query("err")} kind="error" />
      {img && <img src={img} alt="" style="max-width:160px;border-radius:8px" />}
      <form method="post" action={`/app/items/${item.id}`} enctype="multipart/form-data" class="card" data-image-form>
        <input type="hidden" name="back" value={back ?? ""} />
        <ItemFields item={item} />
        <ImageFields keepLabel={img ? "Leave empty to keep the current picture" : undefined} canUpload={!!c.env.IMAGES} />
        {img && (
          <label class="check">
            <input type="checkbox" name="remove_image" value="1" /> Remove the current image
          </label>
        )}
        <h2>On these lists</h2>
        {ownerLists.map((l) => (
          <label class="check">
            <input type="checkbox" name="lists" value={l.id} checked={memberOf.has(l.id)} /> {l.name}
          </label>
        ))}
        {item.priceCapturedAt && (
          <p class="muted">
            Price captured {new Date(item.priceCapturedAt).toLocaleDateString("en-US")}. Changing it records today's date.
          </p>
        )}
        <p>
          <button class="primary" type="submit">
            Save
          </button>
        </p>
      </form>
      <form method="post" action={`/app/items/${item.id}/delete`}>
        <input type="hidden" name="back" value={back ?? ""} />
        <button type="submit">Delete this item</button>
      </form>
    </Layout>,
  );
});

appRoutes.post("/app/items/:id", async (c) => {
  const found = await loadEditableItem(c, c.req.param("id"));
  if (!found) return notFound(c);
  const { item } = found;
  const form = await c.req.parseBody({ all: true });
  const db = getDb(c.env.DB);
  const values = itemValues(form);
  const image = await imageFromForm(c, form);
  const removeImage = str(form, "remove_image") === "1";
  if ((image.key || removeImage) && item.imageKey) await c.env.IMAGES?.delete(item.imageKey);
  await db
    .update(items)
    .set({
      ...values,
      priceCapturedAt: values.priceCents === item.priceCents ? item.priceCapturedAt : values.priceCents != null ? Date.now() : null,
      imageKey: image.key ?? (removeImage ? null : item.imageKey),
      sourceImageUrl: image.key || image.source ? (image.source ?? null) : removeImage ? null : item.sourceImageUrl,
    })
    .where(eq(items.id, item.id));

  // List membership. The form only shows the owner's active lists, so only
  // those are changed; memberships on archived lists are left as they are.
  const wanted = new Set(all(form, "lists"));
  const ownerLists = await db
    .select({ id: lists.id })
    .from(lists)
    .where(and(eq(lists.personId, item.personId), isNull(lists.archivedAt)))
    .all();
  const current = new Set(
    (await db.select({ id: listItems.listId }).from(listItems).where(eq(listItems.itemId, item.id)).all()).map((r) => r.id),
  );
  for (const { id } of ownerLists) {
    if (wanted.has(id) && !current.has(id)) {
      await db.insert(listItems).values({ listId: id, itemId: item.id, position: await nextPosition(db, id) });
    } else if (!wanted.has(id) && current.has(id)) {
      await db.delete(listItems).where(and(eq(listItems.listId, id), eq(listItems.itemId, item.id)));
    }
  }
  const back = str(form, "back", 40);
  if (image.error) return c.redirect(`/app/items/${item.id}?err=${encodeURIComponent(`Saved, but the image wasn't: ${image.error}`)}`);
  return c.redirect(back ? `/app/lists/${back}` : "/app");
});

appRoutes.post("/app/items/:id/delete", async (c) => {
  const found = await loadEditableItem(c, c.req.param("id"));
  if (!found) return notFound(c);
  const { item } = found;
  const db = getDb(c.env.DB);
  const form = await c.req.parseBody();
  const live = await db
    .select({ n: count() })
    .from(claims)
    .where(and(eq(claims.itemId, item.id), isNull(claims.revokedAt)))
    .get();
  if ((live?.n ?? 0) > 0) {
    // R15: someone may already have bought it. Hide it from the owner only.
    await db.update(items).set({ ownerHiddenAt: Date.now() }).where(eq(items.id, item.id));
  } else {
    if (item.imageKey) await c.env.IMAGES?.delete(item.imageKey);
    await db.delete(items).where(eq(items.id, item.id));
  }
  const back = str(form, "back", 40);
  return c.redirect(back ? `/app/lists/${back}` : "/app");
});

appRoutes.get("/app/received", async (c) => {
  const viewer = c.get("viewer");
  const personId = c.req.query("person") ?? viewer.person.id;
  if (!canEditPerson(viewer, personId)) return notFound(c);
  const db = getDb(c.env.DB);
  const person = await db.select().from(people).where(eq(people.id, personId)).get();
  if (!person) return notFound(c);
  const rows = await db
    .select()
    .from(items)
    .where(and(eq(items.personId, personId), isNotNull(items.receivedAt)))
    .orderBy(desc(items.receivedAt))
    .limit(200)
    .all();
  const claimRows = rows.length
    ? await db
        .select()
        .from(claims)
        .where(and(inArray(claims.itemId, rows.map((r) => r.id)), isNull(claims.revokedAt)))
        .all()
    : [];
  return c.html(
    <Layout title="Received" viewer={viewer}>
      <p class="muted">
        <a href="/app">My lists</a>
      </p>
      <h1>{person.id === viewer.person.id ? "Received" : `Received by ${person.displayName}`}</h1>
      {rows.length === 0 && <p class="muted">Nothing yet.</p>}
      <ul class="items">
        {rows.map((it) => (
          <li class="item">
            {imageUrl(c.env, it.imageKey, it.sourceImageUrl) ? <img src={imageUrl(c.env, it.imageKey, it.sourceImageUrl)!} alt="" /> : <div class="noimg">🎁</div>}
            <div>
              <h3>{it.title}</h3>
              <div class="meta">
                From{" "}
                {claimRows
                  .filter((cl) => cl.itemId === it.id)
                  .map((cl) => cl.buyerName)
                  .join(", ")}
              </div>
            </div>
          </li>
        ))}
      </ul>
    </Layout>,
  );
});
