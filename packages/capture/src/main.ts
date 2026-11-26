/**
 * Runs on a product page, from the bookmarklet (loaded as <script src=".../capture.js">)
 * or from the iOS Shortcut's "Run JavaScript on Web Page" action.
 */
import { encodeCapture } from "./encode";
import { extract } from "./extract";
import type { Capture } from "./types";

// Provided by the iOS Shortcuts "Run JavaScript on Web Page" action.
declare const completion: ((result: unknown) => void) | undefined;
// Prepended by the site when the script is fetched from /shortcut.js.
declare const __WL_ORIGIN: string | undefined;

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
  let payload: string;
  try {
    payload = encodeCapture(data);
  } catch {
    payload = encodeCapture({ v: 1, url: location.href, images: [] });
  }

  // iOS Shortcut: return the full add-page address, so the Shortcut's next
  // action ("Open URLs") just opens the JavaScript Result. Shortcuts must
  // always get a completion() call, or the action hangs.
  if (typeof completion === "function") {
    const origin = typeof __WL_ORIGIN === "string" ? __WL_ORIGIN : undefined;
    completion(origin ? `${origin}/add?d=${payload}` : payload);
    return;
  }
  const origin = siteOrigin();
  if (!origin) return;
  const target = `${origin}/add?d=${payload}`;
  const w = window.open(target, "_blank");
  if (!w) location.href = target;
}

run();
