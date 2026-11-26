import type { Context } from "hono";
import type { AppEnv } from "../env";

/** Absolute URL of the main site, keeping the dev port (e.g. http://localhost:8787). */
export function mainUrl(c: Context<AppEnv>): string {
  const u = new URL(c.req.url);
  const port = u.port && c.env.ENVIRONMENT === "development" ? `:${u.port}` : "";
  return `${u.protocol}//${c.env.MAIN_HOST}${port}`;
}

/** Only same-site relative paths are allowed as redirect targets. */
export function safeBack(path: string): string {
  return path.startsWith("/") && !path.startsWith("//") && !path.includes("\\") ? path : "/";
}

export function tooMany(c: Context<AppEnv>) {
  return c.text("You're going a bit fast. Please wait a minute and try again.", 429);
}

type Form = Record<string, string | File | (string | File)[]>;

export function str(form: Form, key: string, max = 500): string {
  const v = form[key];
  return typeof v === "string" ? v.trim().slice(0, max) : "";
}

export function strOrNull(form: Form, key: string, max = 500): string | null {
  return str(form, key, max) || null;
}

export function int(form: Form, key: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(str(form, key, 12), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

export function all(form: Form, key: string): string[] {
  const v = form[key] ?? form[`${key}[]`];
  const arr = Array.isArray(v) ? v : v == null ? [] : [v];
  return arr.filter((x): x is string => typeof x === "string");
}
