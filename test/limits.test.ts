import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAtMost, saveImageFromUrl } from "../src/lib/images";
import { CAPS } from "../src/lib/limits";
import { ADMIN, Client, q } from "./helpers";

/** A stream of `total` bytes in 64 KiB chunks, counting how many chunks were pulled. */
function bigStream(total: number) {
  const pulled = { chunks: 0 };
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(ctrl) {
      if (sent >= total) return ctrl.close();
      const n = Math.min(64 * 1024, total - sent);
      sent += n;
      pulled.chunks++;
      ctrl.enqueue(new Uint8Array(n));
    },
  });
  return { stream, pulled };
}

afterEach(() => vi.restoreAllMocks());

describe("image size limits (R32)", () => {
  it("stops reading a stream as soon as it passes the limit", async () => {
    const { stream, pulled } = bigStream(50 * 1024 * 1024);
    expect(await readAtMost(stream, CAPS.imageBytes)).toBeNull();
    // 2 MiB / 64 KiB = 32 chunks; it must not read the whole 50 MiB.
    expect(pulled.chunks).toBeLessThan(40);
    const small = bigStream(1000);
    expect((await readAtMost(small.stream, CAPS.imageBytes))?.byteLength).toBe(1000);
  });

  it("rejects an image download with no Content-Length that's too large", async () => {
    const { stream, pulled } = bigStream(50 * 1024 * 1024);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(stream, { headers: { "content-type": "image/jpeg" } }));
    const r = await saveImageFromUrl(env, "https://images.example/huge.jpg");
    expect(r).toEqual({ ok: false, reason: "That image is larger than 2 MB." });
    expect(pulled.chunks).toBeLessThan(40);
  });

  it("rejects an image download whose Content-Length understates the body", async () => {
    const { stream } = bigStream(5 * 1024 * 1024);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(stream, { headers: { "content-type": "image/jpeg", "content-length": "1000" } }),
    );
    expect((await saveImageFromUrl(env, "https://images.example/liar.jpg")).ok).toBe(false);
  });

  it("refuses oversized request bodies before parsing them", async () => {
    const admin = new Client(ADMIN);
    await admin.get("/app");
    const [list] = await q<{ id: string }>("SELECT id FROM lists LIMIT 1");
    const body = new FormData();
    body.append("list", list!.id);
    body.append("title", "Huge photo");
    body.append("image_file", new File([new Uint8Array(CAPS.imageBytes + 512 * 1024)], "big.jpg", { type: "image/jpeg" }));
    expect((await admin.fetch("/add", { method: "POST", body })).status).toBe(413);
    expect(await q("SELECT * FROM items")).toHaveLength(0);

    // Public endpoints only take small forms.
    const claim = await new Client(null).post("/api/claim", { name: "x".repeat(100 * 1024), item: "a", list: "b", back: "/" });
    expect(claim.status).toBe(413);
  });

  it("still accepts a normal photo upload", async () => {
    const admin = new Client(ADMIN);
    await admin.get("/app");
    const [list] = await q<{ id: string }>("SELECT id FROM lists LIMIT 1");
    const body = new FormData();
    body.append("list", list!.id);
    body.append("title", "Small photo");
    body.append("image_file", new File([new Uint8Array(300 * 1024)], "ok.jpg", { type: "image/jpeg" }));
    expect((await admin.fetch("/add", { method: "POST", body })).status).toBe(302);
    const [item] = await q<{ image_key: string | null }>("SELECT image_key FROM items");
    expect(item!.image_key).toMatch(/^items\/.+\.jpg$/);
  });
});
