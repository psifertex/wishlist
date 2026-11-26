export type BookFormat = "hardcover" | "paperback" | "ebook" | "audiobook";

/** What the capture script hands to the add page. Keep field names short: it travels in a URL. */
export interface Capture {
  /** Schema version, so the add page can handle older cached scripts. */
  v: 1;
  url: string;
  title?: string;
  /** Price in cents, when one was found. */
  price?: number;
  currency?: string;
  /** Image URLs, best first. */
  images: string[];
  /** Selected options, e.g. "Color: Blue, Size: M". */
  variant?: string;
  isbn?: string;
  asin?: string;
  format?: BookFormat;
  /** Which extractor produced the title/price, for debugging. */
  src?: string;
  /** Amazon only: element IDs on the page, to diagnose layout changes. */
  dbg?: string;
}

export type Partial = Omit<globalThis.Partial<Capture>, "v" | "images"> & { images?: string[] };
