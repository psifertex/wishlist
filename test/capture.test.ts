import { describe, expect, it } from "vitest";
import { encodeCapture } from "../packages/capture/src/encode";
import { decodeCapture } from "../src/lib/capture";
import { ADMIN, Client } from "./helpers";

describe("capture handoff", () => {
  const payload = encodeCapture({
    v: 1,
    url: "https://www.amazon.com/dp/0593135202",
    title: "Project Hail Mary: A Novel",
    price: 1929,
    currency: "USD",
    images: ["https://m.media-amazon.com/images/I/81zD9kaVW9L.jpg", "javascript:alert(1)"],
    isbn: "9780593135204",
    asin: "0593135202",
    format: "hardcover",
  });

  it("decodes what the capture script encodes and drops unsafe values", () => {
    const d = decodeCapture(payload)!;
    expect(d.title).toBe("Project Hail Mary: A Novel");
    expect(d.priceCents).toBe(1929);
    expect(d.images).toEqual(["https://m.media-amazon.com/images/I/81zD9kaVW9L.jpg"]);
    expect(decodeCapture("not-base64!")).toBeNull();
  });

  it("pre-fills the add form, offers the pictures plus an Open Library cover", async () => {
    const admin = new Client(ADMIN);
    const html = await admin.html(`/add?d=${payload}`);
    expect(html).toContain('value="Project Hail Mary: A Novel"');
    expect(html).toContain('value="19.29"');
    expect(html).toContain('value="https://m.media-amazon.com/images/I/81zD9kaVW9L.jpg"');
    expect(html).toContain("covers.openlibrary.org/b/isbn/9780593135204");
    expect(html).toContain('<option value="hardcover" selected="">');
    expect(html).toContain('name="asin" value="0593135202"');
  });

  it("asks for the price when the page didn't have one", async () => {
    const noPrice = encodeCapture({ v: 1, url: "https://shop.example/x", title: "Thing", images: [] });
    const html = await new Client(ADMIN).html(`/add?d=${noPrice}`);
    expect(html).toContain("couldn&#39;t find the price");
    expect(html).toMatch(/name="price"[^>]*required/);
  });

  it("serves an install page with a bookmarklet pointing at this site", async () => {
    const html = await new Client(null).html("/install");
    expect(html).toContain("javascript:(function(){var o=&quot;http://gifts.test&quot;");
  });
});

describe("finding the button", () => {
  it("links the install page from every logged-in page and the add form", async () => {
    const admin = new Client(ADMIN);
    expect(await admin.html("/app")).toContain('href="/install">Get the button');
    expect(await admin.html("/add")).toContain("Add to Wishlist button</a>");
    expect(await admin.html("/install")).toContain("Log out");
  });
});

describe("iOS Shortcut script", () => {
  it("serves capture.js with the site address baked in", async () => {
    const res = await new Client(null).get("/shortcut.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    const js = await res.text();
    expect(js.startsWith('var __WL_ORIGIN = "http://gifts.test";')).toBe(true);
    expect(js).toContain("completion");
  });
});
