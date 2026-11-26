/**
 * Runs on a product page, from the bookmarklet (loaded as <script src=".../capture.js">)
 * or from the iOS Shortcut's "Run JavaScript on Web Page" action.
 */
import { encodeCapture } from "./encode";
import { extract } from "./extract";
import type { Capture } from "./types";

// Provided by the iOS Shortcuts "Run JavaScript on Web Page" action.
declare const completion: ((result: unknown) => void) | undefined;

function siteOrigin(): string | undefined {
  const s = document.currentScript as HTMLScriptElement | null;
  if (s?.src) return new URL(s.src).origin;
  return (window as unknown as { __wishlistOrigin?: string }).__wishlistOrigin;
}

function run() {
  let data: Capture;
  try {
    data = extract(document, location.href);
  } catch {
    data = { v: 1, url: location.href, title: document.title, images: [] };
  }
  const payload = encodeCapture(data);

  // iOS Shortcut: hand the payload back; the Shortcut opens <site>/add?d=<payload>.
  if (typeof completion === "function") {
    completion(payload);
    return;
  }
  const origin = siteOrigin();
  if (!origin) return;
  const target = `${origin}/add?d=${payload}`;
  const w = window.open(target, "_blank");
  if (!w) location.href = target;
}

run();
