import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeEach } from "vitest";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);

// Storage is shared between tests in a file, so start each test empty.
beforeEach(async () => {
  await env.DB.batch(
    ["claims", "list_items", "items", "lists", "hostnames", "managers", "users", "people", "usage"].map((t) =>
      env.DB.prepare(`DELETE FROM ${t}`),
    ),
  );
});
