import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runDaily } from "../src/cron";
import { ADMIN, Client, q } from "./helpers";

type Row = Record<string, any>;

async function bootstrap() {
  const admin = new Client(ADMIN);
  const res = await admin.get("/app");
  expect(res.status).toBe(200);
  const [person] = await q<Row>("SELECT p.* FROM people p JOIN users u ON u.person_id = p.id WHERE u.email = ?", ADMIN);
  const [list] = await q<Row>("SELECT * FROM lists WHERE person_id = ? AND is_default = 1", person!.id);
  return { admin, person: person!, list: list! };
}

async function approve(admin: Client, email: string, name: string, manages = "") {
  const res = await admin.post("/app/admin/approve", { email, person: "new", name, manages });
  expect(res.status).toBe(302);
  const [p] = await q<Row>("SELECT p.* FROM people p JOIN users u ON u.person_id = p.id WHERE u.email = ?", email);
  const [l] = await q<Row>("SELECT * FROM lists WHERE person_id = ? AND is_default = 1", p!.id);
  return { person: p!, list: l! };
}

async function addItem(c: Client, listId: string, title: string, extra: Record<string, string> = {}) {
  const res = await c.post("/add", { list: listId, title, price: "$19.29", quantity: "1", ...extra });
  expect(res.status).toBe(302);
  const [item] = await q<Row>("SELECT * FROM items WHERE title = ? ORDER BY created_at DESC LIMIT 1", title);
  return item!;
}

describe("login and approval (R4a, R4b)", () => {
  it("bootstraps the first admin, queues unknown logins, and approves them", async () => {
    const { admin, person } = await bootstrap();
    expect(person.is_admin).toBe(1);

    const stranger = new Client("kid@example.com");
    let res = await stranger.get("/app");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("waiting for an admin");
    await stranger.post("/app/request", { name: "Kid" });
    expect((await q<Row>("SELECT * FROM users WHERE email = ?", "kid@example.com"))[0]!.requested_name).toBe("Kid");

    expect(await admin.html("/app/admin")).toContain("kid@example.com");
    await approve(admin, "kid@example.com", "Kid");
    res = await stranger.get("/app");
    expect(res.status).toBe(200);

    // The bootstrap email doesn't grant admin once an admin exists.
    const late = new Client("late@example.com");
    expect((await late.get("/app")).status).toBe(403);
  });

  it("rejects, blocks non-admins from admin pages, and protects the last admin", async () => {
    const { admin, person } = await bootstrap();
    await new Client("spam@example.com").get("/app");
    await admin.post("/app/admin/reject", { email: "spam@example.com" });
    const res = await new Client("spam@example.com").get("/app");
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("been approved");

    await new Client("kid@example.com").get("/app");
    await approve(admin, "kid@example.com", "Kid");
    expect((await new Client("kid@example.com").get("/app/admin")).status).toBe(403);

    await admin.post(`/app/admin/people/${person.id}/admin`, { value: "0" });
    expect((await q<Row>("SELECT is_admin FROM people WHERE id = ?", person.id))[0]!.is_admin).toBe(1);
  });

  it("rejects cross-site form posts", async () => {
    const { list } = await bootstrap();
    const body = new FormData();
    body.append("list", list.id);
    body.append("title", "x");
    const { app } = await import("../src/index");
    const res = await app.request(
      "http://gifts.test/add",
      { method: "POST", body, headers: { origin: "https://evil.example", "x-dev-email": ADMIN } },
      env,
    );
    expect(res.status).toBe(403);
  });
});

describe("lists, claims and secrecy", () => {
  it("hides claims from the owner, shows them to buyers and managers, and lets buyers undo", async () => {
    const { admin } = await bootstrap();
    const kidLogin = new Client("kid@example.com");
    await kidLogin.get("/app");
    const kid = await approve(admin, "kid@example.com", "Kid");
    // A parent who manages the kid.
    await new Client("parent@example.com").get("/app");
    const parent = await approve(admin, "parent@example.com", "Parent", kid.person.id);
    const parentLogin = new Client("parent@example.com");

    // Parent adds to the kid's list (R3).
    const item = await addItem(parentLogin, kid.list.id, "Project Hail Mary", { format: "hardcover" });
    expect(item.person_id).toBe(kid.person.id);
    expect(item.price_cents).toBe(1929);

    // Anonymous buyer: first view has no status, buying mode has the claim form.
    const buyer = new Client(null);
    let html = await buyer.html(`/${kid.person.slug}`);
    expect(html).toContain("Project Hail Mary");
    expect(html).toContain("I&#39;m buying a gift");
    expect(html).not.toContain("I&#39;m getting this");
    html = await buyer.html(`/${kid.person.slug}?buying=1`);
    expect(html).toContain("I&#39;m getting this");

    const back = `/${kid.person.slug}/${kid.list.slug}?buying=1`;
    let res = await buyer.post("/api/claim", { list: kid.list.id, item: item.id, name: "Grandma", back });
    expect(res.status).toBe(302);
    expect(await q("SELECT * FROM claims WHERE item_id = ?", item.id)).toHaveLength(1);

    // Another buyer sees it taken and can't claim it.
    const other = new Client(null);
    expect(await other.html(back)).toContain("Already taken");
    res = await other.post("/api/claim", { list: kid.list.id, item: item.id, name: "Uncle", back });
    expect(res.headers.get("location")).toContain("err=");

    // The owner (logged in on the main host) doesn't see it.
    html = await kidLogin.html(`/${kid.person.slug}/${kid.list.slug}?buying=1`);
    expect(html).toContain("This is your list");
    expect(html).not.toContain("Bought for you");
    expect(html).not.toContain("Grandma");
    html = await kidLogin.html(`/app/lists/${kid.list.id}`);
    expect(html).not.toContain("Grandma");

    // The manager does.
    expect(await parentLogin.html(`/app/lists/${kid.list.id}`)).toContain("Grandma is getting it");

    // Only the original browser can undo.
    const [claim] = await q<Row>("SELECT * FROM claims WHERE item_id = ?", item.id);
    await other.post(`/api/claim/${claim!.id}/undo`, { back });
    expect((await q<Row>("SELECT revoked_at FROM claims WHERE id = ?", claim!.id))[0]!.revoked_at).toBeNull();
    await buyer.post(`/api/claim/${claim!.id}/undo`, { back });
    expect((await q<Row>("SELECT revoked_at FROM claims WHERE id = ?", claim!.id))[0]!.revoked_at).not.toBeNull();
    expect(parent.person.id).toBeTruthy();
  });

  it("deleting a claimed item only hides it from the owner (R15)", async () => {
    const { admin, person, list } = await bootstrap();
    const item = await addItem(admin, list.id, "Lego set");
    const buyer = new Client(null);
    const back = `/${person.slug}/${list.slug}?buying=1`;
    await buyer.post("/api/claim", { list: list.id, item: item.id, name: "Aunt", back });
    await admin.post(`/app/items/${item.id}/delete`, {});
    expect((await q<Row>("SELECT owner_hidden_at FROM items WHERE id = ?", item.id))[0]!.owner_hidden_at).not.toBeNull();
    expect(await admin.html(`/app/lists/${list.id}`)).not.toContain("Lego set");
    expect(await buyer.html(back)).toContain("Lego set");
    expect(await new Client(null).html(back)).not.toContain("Lego set");
  });

  it("new lists can include existing items, and a claim shows on every list (R6, R11)", async () => {
    const { admin, person, list } = await bootstrap();
    const a = await addItem(admin, list.id, "Book A");
    await addItem(admin, list.id, "Book B");
    const res = await admin.post("/app/lists", { person: person.id, name: "Birthday", event_date: "2099-05-01", items: [a.id] });
    const newListId = res.headers.get("location")!.split("/").pop()!;
    const items = await q<Row>("SELECT item_id FROM list_items WHERE list_id = ?", newListId);
    expect(items.map((r) => r.item_id)).toEqual([a.id]);

    const buyer = new Client(null);
    await buyer.post("/api/claim", { list: newListId, item: a.id, name: "Friend", back: "/" });
    expect(await new Client(null).html(`/${person.slug}/${list.slug}?buying=1`)).toContain("Already taken");
  });
});

describe("hostnames and reveal", () => {
  it("a person's hostname opens their next upcoming event list (R19)", async () => {
    const { admin, person, list } = await bootstrap();
    await admin.post("/app/admin/hostnames", { op: "add", person: person.id, hostname: "me.example" });
    await addItem(admin, list.id, "Default thing");
    let html = await new Client(null, "http://me.example").html("/");
    expect(html).toContain("Default thing");

    await admin.post("/app/lists", { person: person.id, name: "Far event", event_date: "2099-12-25" });
    await admin.post("/app/lists", { person: person.id, name: "Soon event", event_date: "2098-01-01" });
    await admin.post("/app/lists", { person: person.id, name: "Past event", event_date: "2001-01-01" });
    html = await new Client(null, "http://me.example").html("/");
    expect(html).toContain("Soon event");

    expect((await new Client(null, "http://unknown.example").get("/")).status).toBe(404);
  });

  it("the daily job moves revealed, fully claimed items to Received (R14)", async () => {
    const { admin, person, list } = await bootstrap();
    const item = await addItem(admin, list.id, "Socks");
    await env.DB.prepare("UPDATE lists SET event_date = '2001-01-01' WHERE id = ?").bind(list.id).run();
    await new Client(null).post("/api/claim", { list: list.id, item: item.id, name: "Mom", back: "/" });

    // Revealed immediately (event in the past): the owner sees it as bought.
    expect(await admin.html(`/${person.slug}/${list.slug}`)).toContain("Bought for you");
    const r = await runDaily(env);
    expect(r.received).toBe(1);
    expect(await admin.html(`/app/lists/${list.id}`)).not.toContain("Socks");
    expect(await admin.html(`/app/received`)).toContain("Mom");
  });
});
