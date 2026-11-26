import { env } from "cloudflare:workers";
import { app } from "../src/index";

export const MAIN = "http://gifts.test";

export class Client {
  cookies = new Map<string, string>();
  /** Each client gets its own IP so per-IP rate limits don't leak between tests. */
  ip = `10.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}.${Math.floor(Math.random() * 255)}`;
  constructor(public email: string | null, public origin = MAIN) {}

  async fetch(path: string, init: RequestInit = {}): Promise<Response> {
    const url = path.startsWith("http") ? path : `${this.origin}${path}`;
    const headers = new Headers(init.headers);
    headers.set("x-dev-email", this.email ?? "-");
    headers.set("cf-connecting-ip", this.ip);
    if (this.cookies.size) headers.set("cookie", [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; "));
    if (init.method === "POST") headers.set("origin", new URL(url).origin);
    const res = await app.request(url, { ...init, headers, redirect: "manual" }, env);
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(";");
      const i = pair!.indexOf("=");
      this.cookies.set(pair!.slice(0, i), pair!.slice(i + 1));
    }
    return res;
  }

  get(path: string) {
    return this.fetch(path);
  }

  post(path: string, fields: Record<string, string | string[]>) {
    const body = new FormData();
    for (const [k, v] of Object.entries(fields)) for (const x of [v].flat()) body.append(k, x);
    return this.fetch(path, { method: "POST", body });
  }

  async html(path: string): Promise<string> {
    const res = await this.get(path);
    return res.text();
  }
}

/** First admin per wrangler.jsonc's BOOTSTRAP_ADMIN_EMAIL. */
export const ADMIN = "admin@example.com";

export async function q<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]> {
  const { results } = await env.DB.prepare(sql).bind(...params).all<T>();
  return results;
}
