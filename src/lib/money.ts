/** Parse "$1,234.56" / "19.29" / "19" into cents. Returns null if not a price. */
export function parsePriceToCents(input: string | null | undefined): number | null {
  if (input == null) return null;
  const s = String(input).replace(/[,\s]/g, "").replace(/^[^\d.]+/, "");
  const m = /^(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const cents = Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents < 100_000_000 ? cents : null;
}

export function formatCents(cents: number | null | undefined, currency = "USD"): string {
  if (cents == null) return "";
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
