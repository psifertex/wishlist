import type { Env } from "../env";

export const BUYER_OK_COOKIE = "wl_ok";
const BUYER_OK_TTL_MS = 24 * 60 * 60 * 1000;

export function turnstileEnabled(env: Env): boolean {
  return !!env.TURNSTILE_SITE_KEY && !!env.TURNSTILE_SECRET;
}

export async function verifyTurnstile(env: Env, token: string, ip: string): Promise<boolean> {
  if (!turnstileEnabled(env)) return true;
  const body = new FormData();
  body.append("secret", env.TURNSTILE_SECRET!);
  body.append("response", token);
  body.append("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body });
  if (!res.ok) return false;
  const data = (await res.json()) as { success?: boolean };
  return data.success === true;
}

async function hmacKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(`buyer-ok:${env.TURNSTILE_SECRET ?? ""}`),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * After one Turnstile challenge, the buyer gets a signed cookie good for a day,
 * so a list with many items needs one challenge, not one per claim.
 */
export async function signBuyerOk(env: Env, now = Date.now()): Promise<string> {
  const exp = String(now + BUYER_OK_TTL_MS);
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(exp));
  return `${exp}.${b64url(sig)}`;
}

export async function checkBuyerOk(env: Env, value: string | undefined, now = Date.now()): Promise<boolean> {
  if (!turnstileEnabled(env)) return true;
  if (!value) return false;
  const [exp, sig] = value.split(".");
  if (!exp || !sig || Number(exp) < now) return false;
  const expected = await crypto.subtle.sign("HMAC", await hmacKey(env), new TextEncoder().encode(exp));
  return b64url(expected) === sig;
}
