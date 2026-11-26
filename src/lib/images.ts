import type { Env } from "../env";
import { newId } from "./ids";
import { CAPS, consumeBudget } from "./limits";

const EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/avif": "avif",
};

export function imageUrl(env: Env, key: string | null | undefined): string | null {
  if (!key) return null;
  return env.IMAGE_BASE_URL ? `${env.IMAGE_BASE_URL.replace(/\/$/, "")}/${key}` : `/img/${key}`;
}

export type SaveImageResult = { ok: true; key: string } | { ok: false; reason: string };

/** Stores image bytes in R2 after type, size and budget checks (R31, R32). */
export async function saveImageBytes(env: Env, bytes: ArrayBuffer, contentType: string): Promise<SaveImageResult> {
  const type = contentType.split(";")[0]!.trim().toLowerCase();
  const ext = EXT[type];
  if (!ext) return { ok: false, reason: "That file isn't a supported image type." };
  if (bytes.byteLength > CAPS.imageBytes) return { ok: false, reason: "That image is larger than 2 MB." };
  if (!(await consumeBudget(env.DB, "r2_write"))) return { ok: false, reason: "Daily image limit reached; try again tomorrow." };
  const key = `items/${newId(16)}.${ext}`;
  await env.IMAGES.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
  return { ok: true, key };
}

/** R27a step 1: the Worker downloads the chosen image URL. */
export async function saveImageFromUrl(env: Env, url: string): Promise<SaveImageResult> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, reason: "Invalid image URL." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { ok: false, reason: "Invalid image URL." };
  if (!(await consumeBudget(env.DB, "outbound_fetch"))) return { ok: false, reason: "Daily fetch limit reached." };
  let res: Response;
  try {
    res = await fetch(parsed.toString(), { headers: { accept: "image/*" }, redirect: "follow" });
  } catch {
    return { ok: false, reason: "Couldn't download that image." };
  }
  if (!res.ok) return { ok: false, reason: `The store refused the image download (${res.status}).` };
  const len = Number(res.headers.get("content-length") ?? "0");
  if (len > CAPS.imageBytes) return { ok: false, reason: "That image is larger than 2 MB." };
  return saveImageBytes(env, await res.arrayBuffer(), res.headers.get("content-type") ?? "");
}
