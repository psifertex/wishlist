export function text(el: Element | null | undefined): string | undefined {
  const t = el?.textContent?.replace(/\s+/g, " ").trim();
  return t || undefined;
}

export function meta(doc: Document, ...names: string[]): string | undefined {
  for (const n of names) {
    const el = doc.querySelector(`meta[property="${n}"], meta[name="${n}"], meta[itemprop="${n}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return undefined;
}

/** "$1,234.56" -> 123456. Returns undefined for anything that isn't a plain price. */
export function priceToCents(input: unknown): number | undefined {
  if (input == null) return undefined;
  const s = String(input).replace(/[,\s]/g, "").replace(/^[^\d.]+/, "").replace(/[^\d.]+$/, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return undefined;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  return cents > 0 && cents < 100_000_000 ? cents : undefined;
}

export function currencyFromText(s: string | undefined): string | undefined {
  if (!s) return undefined;
  if (s.includes("$")) return "USD";
  if (s.includes("£")) return "GBP";
  if (s.includes("€")) return "EUR";
  return undefined;
}

export function absolute(url: string | null | undefined, base: string): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url.trim(), base);
    return u.protocol === "https:" || u.protocol === "http:" ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/** Normalises and validates an ISBN-10 or ISBN-13; returns ISBN-13 when possible. */
export function normalizeIsbn(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const s = raw.replace(/[^0-9Xx]/g, "").toUpperCase();
  if (s.length === 13 && /^97[89]\d{10}$/.test(s)) {
    const sum = [...s.slice(0, 12)].reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0);
    return (10 - (sum % 10)) % 10 === Number(s[12]) ? s : undefined;
  }
  if (s.length === 10 && /^\d{9}[\dX]$/.test(s)) {
    const sum = [...s].reduce((n, d, i) => n + (d === "X" ? 10 : Number(d)) * (10 - i), 0);
    if (sum % 11 !== 0) return undefined;
    const core = `978${s.slice(0, 9)}`;
    const s13 = [...core].reduce((n, d, i) => n + Number(d) * (i % 2 ? 3 : 1), 0);
    return core + ((10 - (s13 % 10)) % 10);
  }
  return undefined;
}

export function formatFromText(s: string | undefined): "hardcover" | "paperback" | "ebook" | "audiobook" | undefined {
  if (!s) return undefined;
  const t = s.toLowerCase();
  if (/hardcover|hardback|hard cover/.test(t)) return "hardcover";
  if (/paperback|softcover|mass market/.test(t)) return "paperback";
  if (/kindle|ebook|e-book|nook book|digital/.test(t)) return "ebook";
  if (/audio|audible/.test(t)) return "audiobook";
  return undefined;
}

export function uniq(xs: (string | undefined)[]): string[] {
  return [...new Set(xs.filter((x): x is string => !!x))];
}
