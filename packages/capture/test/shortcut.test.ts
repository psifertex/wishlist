import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
// Runs the built public/capture.js (pnpm build:capture first) the way the iOS
// Shortcuts "Run JavaScript on Web Page" action does: as a function body with completion().
it("built script returns a full add URL to completion()", () => {
  const html = readFileSync(join(import.meta.dirname, "fixtures/amazon-book.html"), "utf8");
  (window as any).happyDOM.setURL("https://www.amazon.com/dp/0593135202");
  document.open(); document.write(html); document.close();
  const code = 'var __WL_ORIGIN = "https://gifts.example.com";\n' + readFileSync(join(import.meta.dirname, "../../../public/capture.js"), "utf8");
  let result: unknown = "NOT CALLED";
  new Function("completion", code)((r: unknown) => { result = r; });
  expect(String(result)).toMatch(/^https:\/\/gifts\.example\.com\/add\?d=[A-Za-z0-9_-]{50,}$/);
  const d = String(result).split("d=")[1]!;
  const json = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(d.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0))));
  expect(json.title).toBe("Project Hail Mary: A Novel");
  expect(json.price).toBe(1929);
});
