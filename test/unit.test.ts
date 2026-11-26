import { describe, expect, it } from "vitest";
import { slugify } from "../src/lib/ids";
import { parsePriceToCents } from "../src/lib/money";
import { isRevealed, UNDATED_REVEAL_MS } from "../src/lib/reveal";
import { isIsoDate, localDate } from "../src/lib/time";

const TZ = "America/New_York";
const at = (iso: string) => new Date(iso).getTime();

describe("reveal rule (R13)", () => {
  it("hides claims on dated lists until the event day in the deployment time zone", () => {
    const claim = { claimCreatedAt: at("2026-11-01T12:00:00Z"), listEventDate: "2026-12-25" };
    expect(isRevealed(claim, at("2026-12-24T23:00:00-05:00"), TZ)).toBe(false);
    expect(isRevealed(claim, at("2026-12-25T00:00:00-05:00"), TZ)).toBe(true);
    // Already 25th in UTC but still the 24th in New York.
    expect(isRevealed(claim, at("2026-12-25T03:00:00Z"), TZ)).toBe(false);
  });

  it("reveals undated claims 60 days later", () => {
    const created = at("2026-01-01T00:00:00Z");
    const claim = { claimCreatedAt: created, listEventDate: null };
    expect(isRevealed(claim, created + UNDATED_REVEAL_MS - 1, TZ)).toBe(false);
    expect(isRevealed(claim, created + UNDATED_REVEAL_MS, TZ)).toBe(true);
  });
});

describe("helpers", () => {
  it("parses prices", () => {
    expect(parsePriceToCents("$19.29")).toBe(1929);
    expect(parsePriceToCents("1,234.5")).toBe(123450);
    expect(parsePriceToCents("19")).toBe(1900);
    expect(parsePriceToCents("free")).toBeNull();
    expect(parsePriceToCents("")).toBeNull();
  });

  it("slugifies", () => {
    expect(slugify("Birthday 2027!")).toBe("birthday-2027");
    expect(slugify("Zoë's Wish List")).toBe("zoe-s-wish-list");
  });

  it("handles dates", () => {
    expect(localDate(at("2026-12-25T03:00:00Z"), TZ)).toBe("2026-12-24");
    expect(isIsoDate("2026-02-30")).toBe(false);
    expect(isIsoDate("2026-02-28")).toBe(true);
  });
});

describe("picture URLs", () => {
  it("prefers the stored copy and falls back to an https source link", async () => {
    const { imageUrl } = await import("../src/lib/images");
    const env = { IMAGE_BASE_URL: undefined } as unknown as import("../src/env").Env;
    expect(imageUrl(env, "items/a.jpg", "https://x/y.jpg")).toBe("/img/items/a.jpg");
    expect(imageUrl(env, null, "https://x/y.jpg")).toBe("https://x/y.jpg");
    expect(imageUrl(env, null, "javascript:alert(1)")).toBeNull();
  });
});
