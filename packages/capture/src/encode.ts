import type { Capture } from "./types";

/** JSON -> UTF-8 -> base64url, safe to put in a query string. */
export function encodeCapture(c: Capture): string {
  const bytes = new TextEncoder().encode(JSON.stringify(c));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
