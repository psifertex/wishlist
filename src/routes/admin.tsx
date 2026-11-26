import { and, asc, count, desc, eq, inArray } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { createMiddleware } from "hono/factory";
import { getDb } from "../db";
import { hostnames, managers, people, users } from "../db/schema";
import type { AppEnv } from "../env";
import { BUDGETS, usageToday, type BudgetKey } from "../lib/limits";
import { createPerson, RESERVED_SLUGS } from "../lib/people";
import { slugify } from "../lib/ids";
import { Flash, Layout, Message } from "../views/layout";
import { str } from "./util";

/** Admin pages (R4a, R4b, R34). Mounted after the login middleware. */
export const adminRoutes = new Hono<AppEnv>();

const requireAdmin = createMiddleware<AppEnv>(async (c, next) => {
  if (!c.get("viewer").isAdmin) return c.html(<Message title="Admins only">You need to be an admin for that.</Message>, 403);
  return next();
});
adminRoutes.use("/app/admin", requireAdmin);
adminRoutes.use("/app/admin/*", requireAdmin);

const back = (c: Context<AppEnv>, msg?: string, kind: "ok" | "error" = "ok") =>
  c.redirect(msg ? `/app/admin?${kind === "ok" ? "msg" : "err"}=${encodeURIComponent(msg)}` : "/app/admin");

adminRoutes.get("/app/admin", async (c) => {
  const viewer = c.get("viewer");
  const db = getDb(c.env.DB);
  const [allUsers, ppl, mgrs, hosts, use] = await Promise.all([
    db.select().from(users).orderBy(desc(users.requestedAt)).all(),
    db.select().from(people).orderBy(asc(people.displayName)).all(),
    db.select().from(managers).all(),
    db.select().from(hostnames).orderBy(asc(hostnames.hostname)).all(),
    usageToday(c.env.DB),
  ]);
  const pending = allUsers.filter((u) => u.status === "pending");
  const rejected = allUsers.filter((u) => u.status === "rejected");
  const active = allUsers.filter((u) => u.status === "active");
  const name = new Map(ppl.map((p) => [p.id, p.displayName]));

  const PersonOptions = () => (
    <>
      {ppl.map((p) => (
        <option value={p.id}>{p.displayName}</option>
      ))}
    </>
  );

  const ApproveForm = ({ email, suggested }: { email: string; suggested: string }) => (
    <form method="post" action="/app/admin/approve" class="inline">
      <input type="hidden" name="email" value={email} />
      <select name="person" aria-label="Person">
        <option value="new">New person…</option>
        <PersonOptions />
      </select>
      <input type="text" name="name" placeholder="Name (for a new person)" value={suggested} maxlength={60} />
      <select name="manages" aria-label="Also manages">
        <option value="">Manages nobody</option>
        <PersonOptions />
      </select>
      <button class="primary small" type="submit">
        Approve
      </button>
    </form>
  );

  return c.html(
    <Layout title="Admin" viewer={viewer}>
      <h1>Admin</h1>
      <Flash msg={c.req.query("msg")} />
      <Flash msg={c.req.query("err")} kind="error" />

      <section class="card">
        <h2 style="margin-top:0">Waiting for approval ({pending.length})</h2>
        {pending.length === 0 && <p class="muted">Nobody is waiting.</p>}
        {pending.map((u) => (
          <div style="border-bottom:1px solid var(--line);padding:8px 0">
            <strong>{u.requestedName ?? "(no name given)"}</strong> <span class="muted">{u.email}</span>
            <span class="muted"> · asked {new Date(u.requestedAt).toLocaleDateString("en-US")}</span>
            <ApproveForm email={u.email} suggested={u.requestedName ?? ""} />
            <form method="post" action="/app/admin/reject" class="inline">
              <input type="hidden" name="email" value={u.email} />
              <button class="small" type="submit">
                Reject
              </button>
            </form>
          </div>
        ))}
      </section>

      <section class="card">
        <h2 style="margin-top:0">People</h2>
        <table>
          <thead>
            <tr>
              <th>Name</th>
              <th>Logins</th>
              <th>Managed by</th>
              <th>Hostnames</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {ppl.map((p) => (
              <tr>
                <td>
                  <form method="post" action={`/app/admin/people/${p.id}`} class="inline">
                    <input type="text" name="name" value={p.displayName} maxlength={60} aria-label="Name" />
                    <input type="text" name="slug" value={p.slug} maxlength={40} aria-label="URL slug" />
                    <button class="small" type="submit">
                      Save
                    </button>
                  </form>
                  {p.isAdmin && <span class="pill hot">admin</span>}
                </td>
                <td>
                  {active
                    .filter((u) => u.personId === p.id)
                    .map((u) => (
                      <div>
                        {u.email}{" "}
                        <form method="post" action="/app/admin/remove-login" class="inline">
                          <input type="hidden" name="email" value={u.email} />
                          <button class="small" type="submit">
                            Remove
                          </button>
                        </form>
                      </div>
                    ))}
                  <form method="post" action="/app/admin/add-login" class="inline">
                    <input type="hidden" name="person" value={p.id} />
                    <input type="email" name="email" placeholder="add email" required aria-label="Email" />
                    <button class="small" type="submit">
                      Add
                    </button>
                  </form>
                </td>
                <td>
                  {mgrs
                    .filter((m) => m.personId === p.id)
                    .map((m) => (
                      <form method="post" action="/app/admin/managers" class="inline">
                        <input type="hidden" name="op" value="remove" />
                        <input type="hidden" name="manager" value={m.managerPersonId} />
                        <input type="hidden" name="person" value={p.id} />
                        {name.get(m.managerPersonId)}{" "}
                        <button class="small" type="submit" aria-label="Remove manager">
                          ×
                        </button>
                      </form>
                    ))}
                  <form method="post" action="/app/admin/managers" class="inline">
                    <input type="hidden" name="op" value="add" />
                    <input type="hidden" name="person" value={p.id} />
                    <select name="manager" aria-label="Add manager">
                      <PersonOptions />
                    </select>
                    <button class="small" type="submit">
                      Add
                    </button>
                  </form>
                </td>
                <td>
                  {hosts
                    .filter((h) => h.personId === p.id)
                    .map((h) => (
                      <form method="post" action="/app/admin/hostnames" class="inline">
                        <input type="hidden" name="op" value="remove" />
                        <input type="hidden" name="hostname" value={h.hostname} />
                        {h.hostname}{" "}
                        <button class="small" type="submit" aria-label="Remove hostname">
                          ×
                        </button>
                      </form>
                    ))}
                  <form method="post" action="/app/admin/hostnames" class="inline">
                    <input type="hidden" name="op" value="add" />
                    <input type="hidden" name="person" value={p.id} />
                    <input type="text" name="hostname" placeholder="gifts.example.com" aria-label="Hostname" />
                    <button class="small" type="submit">
                      Add
                    </button>
                  </form>
                </td>
                <td>
                  <form method="post" action={`/app/admin/people/${p.id}/admin`} class="inline">
                    <input type="hidden" name="value" value={p.isAdmin ? "0" : "1"} />
                    <button class="small" type="submit" disabled={p.id === viewer.person.id}>
                      {p.isAdmin ? "Remove admin" : "Make admin"}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <form method="post" action="/app/admin/people" class="inline" style="margin-top:12px">
          <input type="text" name="name" placeholder="New person's name" required maxlength={60} />
          <button class="small" type="submit">
            Add a person without a login
          </button>
        </form>
        <p class="muted">
          A new hostname also needs to be added as a custom domain on the Worker (see the README) before it works.
        </p>
      </section>

      {rejected.length > 0 && (
        <section class="card">
          <h2 style="margin-top:0">Rejected</h2>
          {rejected.map((u) => (
            <div>
              {u.requestedName ?? ""} <span class="muted">{u.email}</span>
              <ApproveForm email={u.email} suggested={u.requestedName ?? ""} />
            </div>
          ))}
        </section>
      )}

      <section class="card">
        <h2 style="margin-top:0">Today's usage</h2>
        <table>
          <tbody>
            {(Object.keys(BUDGETS) as BudgetKey[]).map((k) => (
              <tr>
                <td>{k.replace("_", " ")}</td>
                <td>
                  {use[k]} / {BUDGETS[k]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p class="muted">Counters reset at midnight UTC.</p>
      </section>
    </Layout>,
  );
});

adminRoutes.post("/app/admin/approve", async (c) => {
  const viewer = c.get("viewer");
  const form = await c.req.parseBody();
  const email = str(form, "email", 320).toLowerCase();
  const db = getDb(c.env.DB);
  const user = await db.select().from(users).where(eq(users.email, email)).get();
  if (!user) return back(c, "That request no longer exists.", "error");
  let personId = str(form, "person", 40);
  if (personId === "new" || !personId) {
    const displayName = str(form, "name", 60) || user.requestedName || email.split("@")[0] || "Someone";
    personId = (await createPerson(db, { displayName })).id;
  } else if (!(await db.select().from(people).where(eq(people.id, personId)).get())) {
    return back(c, "Unknown person.", "error");
  }
  await db
    .update(users)
    .set({ status: "active", personId, decidedByPersonId: viewer.person.id, decidedAt: Date.now() })
    .where(eq(users.email, email));
  const manages = str(form, "manages", 40);
  if (manages && manages !== personId) {
    await db.insert(managers).values({ managerPersonId: personId, personId: manages }).onConflictDoNothing();
  }
  return back(c, `Approved ${email}.`);
});

adminRoutes.post("/app/admin/reject", async (c) => {
  const form = await c.req.parseBody();
  const email = str(form, "email", 320).toLowerCase();
  await getDb(c.env.DB)
    .update(users)
    .set({ status: "rejected", personId: null, decidedByPersonId: c.get("viewer").person.id, decidedAt: Date.now() })
    .where(and(eq(users.email, email), eq(users.status, "pending")));
  return back(c, `Rejected ${email}.`);
});

adminRoutes.post("/app/admin/add-login", async (c) => {
  const form = await c.req.parseBody();
  const email = str(form, "email", 320).toLowerCase();
  const personId = str(form, "person", 40);
  if (!/^[^@\s]+@[^@\s]+$/.test(email)) return back(c, "That doesn't look like an email address.", "error");
  const db = getDb(c.env.DB);
  if (!(await db.select().from(people).where(eq(people.id, personId)).get())) return back(c, "Unknown person.", "error");
  const now = Date.now();
  await db
    .insert(users)
    .values({ email, personId, status: "active", requestedAt: now, decidedAt: now, decidedByPersonId: c.get("viewer").person.id, createdAt: now })
    .onConflictDoUpdate({ target: users.email, set: { personId, status: "active", decidedAt: now } });
  return back(c, `${email} can now log in.`);
});

adminRoutes.post("/app/admin/remove-login", async (c) => {
  const viewer = c.get("viewer");
  const form = await c.req.parseBody();
  const email = str(form, "email", 320).toLowerCase();
  if (email === viewer.email) return back(c, "You can't remove your own login.", "error");
  // Rejected rather than deleted, so the email can't immediately re-request.
  await getDb(c.env.DB)
    .update(users)
    .set({ status: "rejected", personId: null, decidedByPersonId: viewer.person.id, decidedAt: Date.now() })
    .where(eq(users.email, email));
  return back(c, `Removed ${email}.`);
});

adminRoutes.post("/app/admin/people", async (c) => {
  const form = await c.req.parseBody();
  const name = str(form, "name", 60);
  if (!name) return back(c, "Enter a name.", "error");
  await createPerson(getDb(c.env.DB), { displayName: name });
  return back(c, `Added ${name}.`);
});

adminRoutes.post("/app/admin/people/:id", async (c) => {
  const form = await c.req.parseBody();
  const db = getDb(c.env.DB);
  const id = c.req.param("id");
  const slug = slugify(str(form, "slug", 40));
  const name = str(form, "name", 60);
  if (!slug || RESERVED_SLUGS.has(slug)) return back(c, "That URL slug isn't allowed.", "error");
  const clash = await db.select().from(people).where(eq(people.slug, slug)).get();
  if (clash && clash.id !== id) return back(c, "Someone else already uses that URL slug.", "error");
  await db
    .update(people)
    .set({ slug, ...(name ? { displayName: name } : {}) })
    .where(eq(people.id, id));
  return back(c, "Saved.");
});

adminRoutes.post("/app/admin/people/:id/admin", async (c) => {
  const viewer = c.get("viewer");
  const id = c.req.param("id");
  const form = await c.req.parseBody();
  const value = str(form, "value") === "1";
  if (id === viewer.person.id && !value) return back(c, "You can't remove your own admin role.", "error");
  const db = getDb(c.env.DB);
  if (!value) {
    const admins = await db.select({ n: count() }).from(people).where(eq(people.isAdmin, true)).get();
    if ((admins?.n ?? 0) <= 1) return back(c, "There must always be at least one admin.", "error");
  }
  await db.update(people).set({ isAdmin: value }).where(eq(people.id, id));
  return back(c, "Saved.");
});

adminRoutes.post("/app/admin/managers", async (c) => {
  const form = await c.req.parseBody();
  const managerPersonId = str(form, "manager", 40);
  const personId = str(form, "person", 40);
  const db = getDb(c.env.DB);
  if (str(form, "op") === "remove") {
    await db.delete(managers).where(and(eq(managers.managerPersonId, managerPersonId), eq(managers.personId, personId)));
    return back(c, "Removed.");
  }
  if (managerPersonId === personId) return back(c, "People already manage their own lists.", "error");
  const found = await db.select({ id: people.id }).from(people).where(inArray(people.id, [managerPersonId, personId])).all();
  if (found.length !== 2) return back(c, "Unknown person.", "error");
  await db.insert(managers).values({ managerPersonId, personId }).onConflictDoNothing();
  return back(c, "Saved.");
});

adminRoutes.post("/app/admin/hostnames", async (c) => {
  const form = await c.req.parseBody();
  const db = getDb(c.env.DB);
  const hostname = str(form, "hostname", 253).toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  if (str(form, "op") === "remove") {
    await db.delete(hostnames).where(eq(hostnames.hostname, hostname));
    return back(c, "Removed.");
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname) && !/^[a-z0-9-]+\.localhost$/.test(hostname)) {
    return back(c, "That doesn't look like a hostname.", "error");
  }
  if (hostname === c.env.MAIN_HOST) return back(c, "That's the main site's hostname.", "error");
  const personId = str(form, "person", 40);
  await db.insert(hostnames).values({ hostname, personId }).onConflictDoUpdate({ target: hostnames.hostname, set: { personId } });
  return back(c, `${hostname} now opens that person's list.`);
});
