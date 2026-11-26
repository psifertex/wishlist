import { extractAmazon, isAmazon } from "./amazon";
import { extractGeneric, extractJsonLd, extractMeta, genericVariant } from "./structured";
import type { Capture, Partial } from "./types";
import { uniq } from "./util";

const MAX_IMAGES = 8;

/**
 * Runs the extractors in priority order (R25) and merges them: for each field
 * the first extractor that found something wins; images are combined.
 */
export function extract(doc: Document, href: string): Capture {
  const url = new URL(href);
  const layers: Partial[] = [];
  if (isAmazon(url)) layers.push(extractAmazon(doc, url));
  layers.push(extractJsonLd(doc, url), extractMeta(doc, url));
  const generic = extractGeneric(doc, url);
  layers.push(generic);

  const pick = <K extends keyof Partial>(k: K): Partial[K] => layers.find((l) => l[k] != null && l[k] !== "")?.[k];
  const priceLayer = layers.find((l) => l.price != null);
  const out: Capture = {
    v: 1,
    url: pick("url") ?? href,
    title: (pick("title") ?? doc.title.trim())?.slice(0, 200) || undefined,
    price: priceLayer?.price,
    currency: priceLayer?.currency ?? (priceLayer ? "USD" : undefined),
    images: pickImages(layers),
    variant: (pick("variant") ?? genericVariant(doc))?.slice(0, 200),
    isbn: pick("isbn"),
    asin: pick("asin"),
    format: pick("format"),
    src: layers.find((l) => l.title)?.src,
  };
  // Keep Shopify-style variant ids in the saved link.
  const variantId = url.searchParams.get("variant");
  if (variantId && !out.url.includes("variant=")) {
    const u = new URL(out.url);
    u.searchParams.set("variant", variantId);
    out.url = u.toString();
  }
  for (const k of Object.keys(out) as (keyof Capture)[]) if (out[k] === undefined) delete out[k];
  return out;
}

/**
 * A site-specific extractor's images are trusted on their own; otherwise
 * structured data and meta tags are combined, and page heuristics are used
 * only when nothing else found an image (they pick up unrelated images).
 */
function pickImages(layers: Partial[]): string[] {
  const site = layers.find((l) => l.src !== "jsonld" && l.src !== "meta" && l.src !== "generic");
  if (site?.images?.length) return site.images.slice(0, MAX_IMAGES);
  const structured = uniq(layers.filter((l) => l.src === "jsonld" || l.src === "meta").flatMap((l) => l.images ?? []));
  if (structured.length) return structured.slice(0, MAX_IMAGES);
  return uniq(layers.flatMap((l) => l.images ?? [])).slice(0, MAX_IMAGES);
}
