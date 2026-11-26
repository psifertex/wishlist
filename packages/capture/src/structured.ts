import type { Partial } from "./types";
import { absolute, currencyFromText, formatFromText, meta, normalizeIsbn, priceToCents, text, uniq } from "./util";

type Json = Record<string, unknown>;

function asArray<T>(x: T | T[] | undefined | null): T[] {
  return x == null ? [] : Array.isArray(x) ? x : [x];
}

function types(node: Json): string[] {
  return asArray(node["@type"] as string | string[]).map((t) => String(t).toLowerCase());
}

/** All JSON-LD nodes on the page, flattening @graph and arrays. */
function jsonLdNodes(doc: Document): Json[] {
  const out: Json[] = [];
  const visit = (n: unknown) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(visit);
    const o = n as Json;
    out.push(o);
    if (o["@graph"]) visit(o["@graph"]);
    if (o.workExample) visit(o.workExample);
    if (o.hasVariant) visit(o.hasVariant);
  };
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      visit(JSON.parse(s.textContent ?? ""));
    } catch {
      /* some sites ship invalid JSON-LD */
    }
  }
  return out;
}

function imageUrls(img: unknown, base: string): string[] {
  return uniq(
    asArray(img as unknown[]).map((i) =>
      typeof i === "string" ? absolute(i, base) : i && typeof i === "object" ? absolute(String((i as Json).url ?? (i as Json).contentUrl ?? ""), base) : undefined,
    ),
  );
}

function offerPrice(offers: unknown): { price?: number; currency?: string } {
  for (const o of asArray(offers as Json[])) {
    if (!o || typeof o !== "object") continue;
    const spec = asArray(o.priceSpecification as Json[])[0];
    const raw = o.price ?? o.lowPrice ?? spec?.price;
    const price = priceToCents(raw);
    if (price) return { price, currency: String(o.priceCurrency ?? spec?.priceCurrency ?? "") || undefined };
  }
  return {};
}

/** schema.org Product / Book data (R25 step 2). */
export function extractJsonLd(doc: Document, pageUrl: URL): Partial {
  const nodes = jsonLdNodes(doc);
  const base = pageUrl.toString();
  const product =
    nodes.find((n) => types(n).some((t) => t === "product" || t === "productgroup")) ??
    nodes.find((n) => types(n).includes("book"));
  if (!product) return {};
  // On variant pages, prefer the variant matching the URL's ?variant= (Shopify) or sku.
  const variantId = pageUrl.searchParams.get("variant");
  const chosen =
    (variantId &&
      asArray(product.hasVariant as Json[]).find((v) => String(v["@id"] ?? v.url ?? v.sku ?? "").includes(variantId))) ||
    product;
  const books = nodes.filter((n) => types(n).includes("book"));
  const bookNode = books.find((b) => b.isbn) ?? books[0];
  const { price, currency } = offerPrice(chosen.offers ?? product.offers);
  return {
    src: "jsonld",
    title: String(chosen.name ?? product.name ?? "").trim() || undefined,
    price,
    currency,
    images: uniq([...imageUrls(chosen.image, base), ...imageUrls(product.image, base)]),
    isbn: normalizeIsbn(String(chosen.isbn ?? bookNode?.isbn ?? chosen.gtin13 ?? product.gtin13 ?? "")),
    format: formatFromText(String(chosen.bookFormat ?? bookNode?.bookFormat ?? "")),
  };
}

/** OpenGraph / product meta tags (R25 step 3). */
export function extractMeta(doc: Document, pageUrl: URL): Partial {
  const base = pageUrl.toString();
  const priceRaw = meta(doc, "product:price:amount", "og:price:amount", "price");
  return {
    src: "meta",
    title: meta(doc, "og:title", "twitter:title"),
    price: priceToCents(priceRaw),
    currency: meta(doc, "product:price:currency", "og:price:currency", "priceCurrency"),
    images: uniq([absolute(meta(doc, "og:image:secure_url", "og:image", "twitter:image"), base)]),
    isbn: normalizeIsbn(meta(doc, "books:isbn", "book:isbn", "isbn")),
    url: absolute(doc.querySelector('link[rel="canonical"]')?.getAttribute("href") ?? meta(doc, "og:url"), base),
  };
}

/** Last resort (R25 step 4): page heuristics. */
export function extractGeneric(doc: Document, pageUrl: URL): Partial {
  const base = pageUrl.toString();
  const title = text(doc.querySelector("h1")) ?? text(doc.querySelector("title"));

  // A price-looking element near the top of the product area.
  let price: number | undefined;
  let currency: string | undefined;
  for (const el of doc.querySelectorAll('[itemprop="price"], [class*="price" i], [id*="price" i], [data-price]')) {
    const raw = el.getAttribute("content") ?? el.getAttribute("data-price") ?? text(el);
    if (!raw || raw.length > 30) continue;
    const cents = priceToCents(raw);
    if (cents) {
      price = cents;
      currency = currencyFromText(raw);
      break;
    }
  }

  // Large images on the page, biggest first.
  const imgs = [...doc.querySelectorAll("img")]
    .map((img) => ({
      src: absolute(img.getAttribute("src") ?? img.getAttribute("data-src"), base),
      area: (img.naturalWidth || Number(img.getAttribute("width")) || 0) * (img.naturalHeight || Number(img.getAttribute("height")) || 0),
    }))
    .filter((i) => i.src && !i.src.startsWith("data:") && !/sprite|logo|icon|pixel|spacer/i.test(i.src))
    .sort((a, b) => b.area - a.area)
    .slice(0, 8)
    .map((i) => i.src);

  // ISBN anywhere in the visible text, e.g. "ISBN-13: 9780593135204".
  const body = doc.body?.textContent ?? "";
  const m = /ISBN(?:-1[03])?\s*:?\s*([\dXx][\dXx\s-]{8,16}[\dXx])/i.exec(body);

  return { src: "generic", title, price, currency, images: uniq(imgs), isbn: normalizeIsbn(m?.[1]), variant: genericVariant(doc) };
}

/** Selected options from labelled <select>s and checked radio groups. */
export function genericVariant(doc: Document): string | undefined {
  const parts: string[] = [];
  const nameOf = (el: Element): string | undefined => {
    const id = el.getAttribute("id");
    const lab = id ? doc.querySelector(`label[for="${CSS.escape(id)}"]`) : null;
    return (text(lab) ?? text(el.closest("fieldset")?.querySelector("legend")) ?? el.getAttribute("name") ?? undefined)
      ?.replace(/:\s*$/, "")
      .replace(/\boption\b/i, "")
      .trim();
  };
  const interesting = /size|color|colour|style|option|format|edition|variant|width|length/i;
  for (const sel of doc.querySelectorAll("select")) {
    const label = nameOf(sel);
    if (!label || !interesting.test(`${label} ${sel.getAttribute("name") ?? ""}`)) continue;
    const opt = (sel as HTMLSelectElement).selectedOptions?.[0] ?? sel.querySelector("option[selected]");
    const v = text(opt);
    if (v && !/^(choose|select|pick)/i.test(v)) parts.push(`${label}: ${v}`);
  }
  for (const radio of doc.querySelectorAll<HTMLInputElement>('input[type="radio"]:checked')) {
    const label = text(radio.closest("fieldset")?.querySelector("legend"))?.replace(/:\s*$/, "") ?? radio.name;
    if (!interesting.test(`${label} ${radio.name}`)) continue;
    const v = radio.value || text(doc.querySelector(`label[for="${CSS.escape(radio.id)}"]`));
    if (v) parts.push(`${label}: ${v}`);
  }
  return parts.length ? uniq(parts).join(", ") : undefined;
}
