import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { amazonFullSize } from "../src/amazon";
import { encodeCapture } from "../src/encode";
import { extract } from "../src/extract";
import { normalizeIsbn } from "../src/util";

function load(name: string): Document {
  const html = readFileSync(join(import.meta.dirname, "fixtures", name), "utf8");
  return new DOMParser().parseFromString(html, "text/html");
}

describe("amazon", () => {
  it("reads a book page: title, price, format, ISBN, full-size cover", () => {
    const c = extract(load("amazon-book.html"), "https://www.amazon.com/Project-Hail-Mary-Andy-Weir/dp/0593135202/ref=sr_1_1?crid=x");
    expect(c.title).toBe("Project Hail Mary: A Novel");
    expect(c.price).toBe(1929);
    expect(c.currency).toBe("USD");
    expect(c.format).toBe("hardcover");
    expect(c.isbn).toBe("9780593135204");
    expect(c.asin).toBe("0593135202");
    expect(c.url).toBe("https://www.amazon.com/dp/0593135202");
    expect(c.images[0]).toBe("https://m.media-amazon.com/images/I/81zD9kaVW9L.jpg");
  });

  it("reads the selected variant and alternate images", () => {
    const c = extract(load("amazon-variant.html"), "https://www.amazon.com/gp/product/B0TESTASIN?th=1");
    expect(c.title).toBe("Kids Waterproof Rain Jacket");
    expect(c.price).toBe(3499);
    expect(c.variant).toBe("Color: Navy Blue, Size: Large (10-12)");
    expect(c.asin).toBe("B0TESTASIN");
    expect(c.images).toEqual([
      "https://m.media-amazon.com/images/I/71abcDEFghL.jpg",
      "https://m.media-amazon.com/images/I/61xyzUVWabL.jpg",
    ]);
  });

  it("strips size tokens from image URLs", () => {
    expect(amazonFullSize("https://m.media-amazon.com/images/I/81zD9kaVW9L._AC_SY679_.jpg")).toBe(
      "https://m.media-amazon.com/images/I/81zD9kaVW9L.jpg",
    );
  });
});

describe("other stores", () => {
  it("uses JSON-LD and picks the variant in the URL", () => {
    const c = extract(load("shop-jsonld.html"), "https://example-shop.com/products/socks?variant=222");
    expect(c.title).toBe("Cozy Socks - Blue / M");
    expect(c.price).toBe(1450);
    expect(c.images[0]).toBe("https://cdn.example-shop.com/socks-blue.jpg");
    expect(c.url).toContain("variant=222");
    expect(c.variant).toBe("Size: M, Color: Blue");
  });

  it("falls back to page heuristics, including an ISBN in the text", () => {
    const c = extract(load("bookstore-generic.html"), "https://corner-bookshop.example/books/hobbit");
    expect(c.title).toBe("The Hobbit");
    expect(c.price).toBe(1599);
    expect(c.isbn).toBe("9780547928227");
    expect(c.images[0]).toBe("https://corner-bookshop.example/covers/hobbit-large.jpg");
  });
});

describe("helpers", () => {
  it("validates and upgrades ISBNs", () => {
    expect(normalizeIsbn("0593135202")).toBe("9780593135204");
    expect(normalizeIsbn("978-0593135204")).toBe("9780593135204");
    expect(normalizeIsbn("9780593135205")).toBeUndefined();
    expect(normalizeIsbn("B08FHBV4ZX")).toBeUndefined();
  });

  it("encodes as base64url JSON, including non-ASCII text", () => {
    const enc = encodeCapture({ v: 1, url: "https://x.example/", title: "Zoë’s café", images: [] });
    expect(enc).not.toMatch(/[+/=]/);
    const json = new TextDecoder().decode(Uint8Array.from(atob(enc.replace(/-/g, "+").replace(/_/g, "/")), (ch) => ch.charCodeAt(0)));
    expect(JSON.parse(json).title).toBe("Zoë’s café");
  });
});

describe("amazon layouts", () => {
  it("reads a mobile-style page through the layout-independent fallbacks", () => {
    const c = extract(load("amazon-mobile.html"), "https://www.amazon.com/dp/B00MHX7JPW?psc=1");
    expect(c.title).toBe("Bezier Games Ultimate Werewolf");
    expect(c.price).toBe(906); // not the struck-through $12.95
    expect(c.images[0]).toBe("https://m.media-amazon.com/images/I/81abcWOLFxL.jpg");
    expect(c.variant).toBe("Size: Large");
    expect(c.dbg).toContain("corePrice_mobile_feature_div");
  });

  it("cleans Amazon's page titles", async () => {
    const { cleanAmazonTitle } = await import("../src/amazon");
    expect(cleanAmazonTitle("Amazon.com: Bezier Games Ultimate Werewolf | Villagers : Bezier Games: Toys & Games")).toBe(
      "Bezier Games Ultimate Werewolf | Villagers",
    );
    expect(cleanAmazonTitle("Project Hail Mary: A Novel: Weir, Andy: 9780593135204: Amazon.com: Books")).toBe(
      "Project Hail Mary: A Novel",
    );
    expect(cleanAmazonTitle("Amazon.com")).toBeUndefined();
  });
});
