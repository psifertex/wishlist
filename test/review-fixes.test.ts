import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runDaily } from "../src/cron";
import { ADMIN, Client, q } from "./helpers";

type Row = Record<string, any>;

async function setup() {
  const admin = new Client(ADMIN);
  await admin.get("/app");
  const [person] = await q<Row>("SELECT * FROM people");
  const [list] = await q<Row>("SELECT * FROM lists WHERE person_id = ?", person!.id);
  return { admin, person: person!, list: list! };
}

async function addItem(admin: Client, listId: string, title: string, quantity = "1") {
  await admin.post("/add", { list: listId, title, price: "10", quantity });
  return (await q<Row>("SELECT * FROM items WHERE title = ?", title))[0]!;
}

const liveClaims = (itemId: string) => q<Row>("SELECT * FROM claims WHERE item_id = ? AND revoked_at IS NULL", itemId);

describe("claims are atomic", () => {
  it("two buyers racing for the last unit: only one wins", async () => {
    const { admin, person, list } = await setup();
    const item = await addItem(admin, list.id, "Only one");
    const back = `/${person.slug}/${list.slug}?buying=1`;
    const buyers = Array.from({ length: 5 }, () => new Client(null));
    const results = await Promise.all(
      buyers.map((b, i) => b.post("/api/claim", { list: list.id, item: item.id, name: `Buyer ${i}`, back })),
    );
    expect(await liveClaims(item.id)).toHaveLength(1);
    expect(results.filter((r) => r.headers.get("location")?.includes("err=")).length).toBe(4);
  });

  it("clamps a claim to the quantity that's left", async () => {
    const { admin, list } = await setup();
    const item = await addItem(admin, list.id, "Three socks", "3");
    await new Client(null).post("/api/claim", { list: list.id, item: item.id, name: "A", quantity: "2", back: "/" });
    await new Client(null).post("/api/claim", { list: list.id, item: item.id, name: "B", quantity: "5", back: "/" });
    expect((await liveClaims(item.id)).map((c) => c.quantity).sort()).toEqual([1, 2]);
  });
});

describe("list membership", () => {
  it("editing an item leaves its archived-list memberships alone", async () => {
    const { admin, person, list } = await setup();
    const item = await addItem(admin, list.id, "Keeper");
    const res = await admin.post("/app/lists", { person: person.id, name: "Old event", items: [item.id] });
    const oldId = res.headers.get("location")!.split("/").pop()!;
    await admin.post(`/app/lists/${oldId}`, { name: "Old event", archive: "1" });
    await admin.post(`/app/items/${item.id}`, { title: "Keeper (edited)", lists: [list.id] });
    const memberships = (await q<Row>("SELECT list_id FROM list_items WHERE item_id = ?", item.id)).map((r) => r.list_id);
    expect(memberships.sort()).toEqual([list.id, oldId].sort());
  });

  it("a buyer still sees and can undo a claim after the item leaves the list", async () => {
    const { admin, person, list } = await setup();
    const item = await addItem(admin, list.id, "Removed later");
    const buyer = new Client(null);
    const back = `/${person.slug}/${list.slug}?buying=1`;
    await buyer.post("/api/claim", { list: list.id, item: item.id, name: "Grandpa", back });
    await admin.post(`/app/lists/${list.id}/remove/${item.id}`, {});
    expect(await q("SELECT * FROM list_items WHERE item_id = ?", item.id)).toHaveLength(0);

    const html = await buyer.html(back);
    expect(html).toContain("Also getting for");
    expect(html).toContain("Removed later");
    expect(html).not.toContain(`name="item" value="${item.id}"`); // can't claim it again from here
    expect(await new Client(null).html(back)).not.toContain("Removed later");

    const [claim] = await liveClaims(item.id);
    await buyer.post(`/api/claim/${claim!.id}/undo`, { back });
    expect(await liveClaims(item.id)).toHaveLength(0);
  });
});

describe("daily purge", () => {
  it("deletes the picture of an owner-deleted item once its claims are undone", async () => {
    const { admin, person, list } = await setup();
    const item = await addItem(admin, list.id, "With picture");
    await env.IMAGES.put("items/test-purge.jpg", new Uint8Array(10));
    await env.DB.prepare("UPDATE items SET image_key = 'items/test-purge.jpg' WHERE id = ?").bind(item.id).run();

    const buyer = new Client(null);
    const back = `/${person.slug}/${list.slug}?buying=1`;
    await buyer.post("/api/claim", { list: list.id, item: item.id, name: "Aunt", back });
    await admin.post(`/app/items/${item.id}/delete`, {});
    expect(await env.IMAGES.head("items/test-purge.jpg")).not.toBeNull(); // still claimed: kept

    const [claim] = await liveClaims(item.id);
    await buyer.post(`/api/claim/${claim!.id}/undo`, { back });
    const r = await runDaily(env, Date.now() + 1000);
    expect(r.purged).toBe(1);
    expect(await q("SELECT * FROM items WHERE id = ?", item.id)).toHaveLength(0);
    expect(await env.IMAGES.head("items/test-purge.jpg")).toBeNull();
  });
});
