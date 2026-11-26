import { BOOK_FORMATS, type BookFormat } from "../db/schema";

/** Server-side view of the capture script's payload (packages/capture/src/types.ts). */
export interface CaptureData {
  url?: string;
  title?: string;
  priceCents?: number;
  currency?: string;
  images: string[];
  variant?: string;
  isbn?: string;
  asin?: string;
  format?: BookFormat;
}

const httpUrl = (s: unknown): string | undefined => {
  if (typeof s !== "string" || s.length > 2000) return undefined;
  try {
    const u = new URL(s);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
};
const shortText = (s: unknown, max: number): string | undefined =>
  typeof s === "string" && s.trim() ? s.trim().slice(0, max) : undefined;

/** Decodes and validates the ?d= payload. Anything malformed is dropped, never trusted. */
export function decodeCapture(d: string | undefined): CaptureData | null {
  if (!d || d.length > 16_000) return null;
  let raw: Record<string, unknown>;
  try {
    const bin = atob(d.replace(/-/g, "+").replace(/_/g, "/"));
    raw = JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0))));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || raw.v !== 1) return null;
  const price = typeof raw.price === "number" && Number.isSafeInteger(raw.price) && raw.price > 0 ? raw.price : undefined;
  const format = (BOOK_FORMATS as readonly unknown[]).includes(raw.format) ? (raw.format as BookFormat) : undefined;
  const images = Array.isArray(raw.images) ? raw.images.map(httpUrl).filter((u): u is string => !!u).slice(0, 8) : [];
  const isbn = typeof raw.isbn === "string" && /^\d{13}$/.test(raw.isbn) ? raw.isbn : undefined;
  return {
    url: httpUrl(raw.url),
    title: shortText(raw.title, 200),
    priceCents: price,
    currency: typeof raw.currency === "string" && /^[A-Z]{3}$/.test(raw.currency) ? raw.currency : undefined,
    images,
    variant: shortText(raw.variant, 200),
    isbn,
    asin: typeof raw.asin === "string" && /^[A-Z0-9]{10}$/.test(raw.asin) ? raw.asin : undefined,
    format,
  };
}

/** Open Library cover for an ISBN (R26). default=false makes a missing cover a 404, not a blank image. */
export function openLibraryCover(isbn: string): string {
  return `https://covers.openlibrary.org/b/isbn/${isbn}-L.jpg?default=false`;
}
