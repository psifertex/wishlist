import type { Partial } from "./types";
import { absolute, currencyFromText, formatFromText, normalizeIsbn, priceToCents, text, uniq } from "./util";

export function isAmazon(url: URL): boolean {
  return /(^|\.)amazon\.[a-z.]+$/.test(url.hostname);
}

/** Amazon image URLs carry a size token like "._AC_SX300_." — dropping it gives the original. */
export function amazonFullSize(src: string): string {
  return src.replace(/\._[^/]*?_\.(jpe?g|png|webp|gif)$/i, ".$1");
}

export function asinFromUrl(url: URL): string | undefined {
  return /\/(?:dp|gp\/product|gp\/aw\/d)\/([A-Z0-9]{10})(?:[/?]|$)/i.exec(url.pathname + "/")?.[1]?.toUpperCase();
}

function price(doc: Document): { cents?: number; currency?: string } {
  const selectors = [
    "#corePriceDisplay_desktop_feature_div .priceToPay .a-offscreen",
    "#corePriceDisplay_desktop_feature_div .apex-pricetopay-value .a-offscreen",
    "#corePrice_feature_div .a-price .a-offscreen",
    "#corePriceDisplay_mobile_feature_div .a-offscreen",
    "#apex_desktop .a-price .a-offscreen",
    "#price_inside_buybox",
    "#newBuyBoxPrice",
    "#kindle-price",
    "#tmmSwatches .swatchElement.selected .slot-price",
    "#priceblock_ourprice",
    "#priceblock_dealprice",
  ];
  for (const sel of selectors) {
    const t = text(doc.querySelector(sel));
    const cents = priceToCents(t);
    if (cents) return { cents, currency: currencyFromText(t) };
  }
  // Price split into whole + fraction spans with no offscreen copy.
  const whole = text(doc.querySelector("#corePriceDisplay_desktop_feature_div .priceToPay .a-price-whole"));
  const frac = text(doc.querySelector("#corePriceDisplay_desktop_feature_div .priceToPay .a-price-fraction"));
  const cents = whole ? priceToCents(`${whole.replace(/\.$/, "")}.${frac ?? "00"}`) : undefined;
  return cents ? { cents, currency: "USD" } : {};
}

function images(doc: Document, base: string): string[] {
  const out: (string | undefined)[] = [];
  for (const sel of ["#landingImage", "#imgBlkFront", "#ebooksImgBlkFront", "#main-image", "#imgTagWrapperId img"]) {
    const el = doc.querySelector(sel);
    if (!el) continue;
    out.push(amazonFullSize(absolute(el.getAttribute("data-old-hires"), base) ?? ""));
    const dyn = el.getAttribute("data-a-dynamic-image");
    if (dyn) {
      try {
        const sizes = JSON.parse(dyn) as Record<string, [number, number]>;
        const best = Object.entries(sizes).sort((a, b) => b[1][0] * b[1][1] - a[1][0] * a[1][1])[0]?.[0];
        if (best) out.push(amazonFullSize(best));
      } catch {
        /* ignore malformed attribute */
      }
    }
    const src = el.getAttribute("src");
    if (src && !src.startsWith("data:")) out.push(amazonFullSize(absolute(src, base) ?? ""));
  }
  // Thumbnail strip: other angles of the same item.
  for (const img of doc.querySelectorAll("#altImages img, #imageBlockThumbs img")) {
    const src = img.getAttribute("src");
    if (src && /\/images\/I\//.test(src)) out.push(amazonFullSize(absolute(src, base) ?? ""));
  }
  return uniq(out).filter((u) => /\/images\/I\//.test(u));
}

/** Selected twister options, e.g. "Color: Blue, Size: M". */
function variant(doc: Document): string | undefined {
  const parts: string[] = [];
  // Classic twister rows: <div id="variation_color_name"><label>Color: </label><span class="selection">Blue</span>
  for (const row of doc.querySelectorAll('[id^="variation_"]')) {
    const sel = text(row.querySelector(".selection"));
    if (!sel) continue;
    const label = text(row.querySelector("label"))?.replace(/:\s*$/, "") ?? row.id.replace(/^variation_|_name$/g, "");
    parts.push(`${label}: ${sel}`);
  }
  // Inline twister: <span id="inline-twister-expanded-dimension-text-size_name">M</span>
  if (!parts.length) {
    for (const el of doc.querySelectorAll('[id^="inline-twister-expanded-dimension-text-"]')) {
      const v = text(el);
      if (!v) continue;
      const dim = el.id.replace("inline-twister-expanded-dimension-text-", "").replace(/_name$/, "").replace(/_/g, " ");
      const row = el.closest('[id^="inline-twister-row-"]');
      const label = text(row?.querySelector(".inline-twister-dim-title, .a-form-label"))?.replace(/:\s*$/, "") ?? dim;
      parts.push(`${label[0]?.toUpperCase()}${label.slice(1)}: ${v}`);
    }
  }
  return parts.length ? parts.join(", ") : undefined;
}

function book(doc: Document, asin: string | undefined): Partial {
  const selectedFormat = text(doc.querySelector("#tmmSwatches .swatchElement.selected .slot-title")) ??
    text(doc.querySelector("#productSubtitle")) ??
    text(doc.querySelector("#tmm-grid-swatch-OTHER.selected"));
  const format = formatFromText(selectedFormat);
  let isbn = normalizeIsbn(text(doc.querySelector("#rpi-attribute-book_details-isbn13 .rpi-attribute-value")));
  if (!isbn) {
    for (const li of doc.querySelectorAll("#detailBullets_feature_div li, #productDetailsTable li, #detailBulletsWrapper_feature_div li")) {
      const t = text(li) ?? "";
      const m = /ISBN-1[03]\s*[:‏‎]*\s*([\dXx-]{10,17})/.exec(t);
      if (m && (isbn = normalizeIsbn(m[1]))) break;
    }
  }
  // Physical books: the ASIN is the ISBN-10.
  if (!isbn && format && format !== "ebook" && format !== "audiobook") isbn = normalizeIsbn(asin);
  return { format, isbn };
}

export function extractAmazon(doc: Document, pageUrl: URL): Partial {
  const asin =
    asinFromUrl(pageUrl) ??
    doc.querySelector<HTMLInputElement>("input#ASIN, input[name='ASIN']")?.value?.toUpperCase() ??
    undefined;
  const p = price(doc);
  const canonical = doc.querySelector('link[rel="canonical"]')?.getAttribute("href");
  return {
    src: "amazon",
    title: text(doc.querySelector("#productTitle")) ?? text(doc.querySelector("#ebooksProductTitle")),
    price: p.cents,
    currency: p.currency,
    images: images(doc, pageUrl.toString()),
    variant: variant(doc),
    asin,
    // A clean product link that still pins the exact variant (each variant has its own ASIN).
    url: asin ? `https://${pageUrl.hostname}/dp/${asin}` : absolute(canonical, pageUrl.toString()),
    ...book(doc, asin),
  };
}
