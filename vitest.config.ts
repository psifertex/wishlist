import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "jsonc-parser";
import { defineConfig } from "vitest/config";

/**
 * Tests use wrangler.jsonc with one change: roomy rate limits. Every test logs
 * in as the same admin, so the real per-user limits would trip across the
 * suite. Paths are made absolute because the copy lives in .wrangler/.
 */
function testWranglerConfig(): string {
  const root = import.meta.dirname;
  const cfg = parse(readFileSync(resolve(root, "wrangler.jsonc"), "utf8"));
  cfg.main = resolve(root, cfg.main);
  if (cfg.assets?.directory) cfg.assets.directory = resolve(root, cfg.assets.directory);
  for (const db of cfg.d1_databases ?? []) if (db.migrations_dir) db.migrations_dir = resolve(root, db.migrations_dir);
  for (const rl of cfg.ratelimits ?? []) rl.simple = { limit: 10000, period: 60 };
  delete cfg.$schema;
  mkdirSync(resolve(root, ".wrangler"), { recursive: true });
  const out = resolve(root, ".wrangler/wrangler.test.json");
  writeFileSync(out, JSON.stringify(cfg, null, 2));
  return out;
}

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: testWranglerConfig() },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations("./migrations"),
          // Tests pick the login per request with the x-dev-email header.
          DEV_AUTH_EMAIL: "-",
          MAIN_HOST: "gifts.test",
        },
      },
    })),
  ],
  test: {
    include: ["test/**/*.test.{ts,tsx}"],
    setupFiles: ["./test/setup.ts"],
  },
});
