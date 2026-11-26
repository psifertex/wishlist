#!/usr/bin/env node
// Applies config/family.local.jsonc (gitignored) to the deployment:
//   - sets routes and MAIN_HOST in wrangler.deploy.jsonc (created from the example if missing)
//   - writes .wrangler/family-seed.sql with people, logins, admins, managers and hostnames
//   - with --local or --remote, runs that SQL against the D1 database
// Usage: pnpm family [--local | --remote] [--config path]
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { applyEdits, modify, parse, printParseErrorCode } from "jsonc-parser";

const args = process.argv.slice(2);
const target = args.includes("--remote") ? "remote" : args.includes("--local") ? "local" : null;
const configPath = args.includes("--config") ? args[args.indexOf("--config") + 1] : "config/family.local.jsonc";

// Keep in sync with RESERVED_SLUGS in src/lib/people.ts.
const RESERVED = new Set(["app", "add", "api", "install", "login", "logout", "img", "dev", "admin", "static"]);

function fail(msg) {
  console.error(`family: ${msg}`);
  process.exit(1);
}

function readJsonc(path) {
  const errors = [];
  const value = parse(readFileSync(path, "utf8"), errors, { allowTrailingComma: true });
  if (errors.length) fail(`${path}: ${errors.map((e) => `${printParseErrorCode(e.error)} at offset ${e.offset}`).join(", ")}`);
  return value;
}

if (!existsSync(configPath)) {
  fail(`${configPath} not found. Copy config/family.example.jsonc to config/family.local.jsonc and fill it in.`);
}
const config = readJsonc(configPath);

// ------------------------------------------------------------------ validate
const hostRe = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/;
const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
if (!hostRe.test(config.mainHost ?? "")) fail("mainHost must be a hostname like gifts.example.com");
if (!Array.isArray(config.people) || config.people.length === 0) fail("people must be a non-empty list");

const slugs = new Set();
const allHosts = new Set([config.mainHost]);
const allEmails = new Set();
for (const p of config.people) {
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(p.slug ?? "")) fail(`bad slug ${JSON.stringify(p.slug)} (lowercase letters, digits, dashes)`);
  if (RESERVED.has(p.slug)) fail(`slug "${p.slug}" is reserved`);
  if (slugs.has(p.slug)) fail(`duplicate slug "${p.slug}"`);
  slugs.add(p.slug);
  if (!p.name?.trim()) fail(`person "${p.slug}" needs a name`);
  p.emails = (p.emails ?? []).map((e) => e.trim().toLowerCase());
  p.hostnames = (p.hostnames ?? []).map((h) => h.trim().toLowerCase());
  p.managedBy = p.managedBy ?? [];
  for (const e of p.emails) {
    if (!emailRe.test(e)) fail(`bad email "${e}" for ${p.slug}`);
    if (allEmails.has(e)) fail(`email "${e}" is listed twice`);
    allEmails.add(e);
  }
  for (const h of p.hostnames) {
    if (!hostRe.test(h)) fail(`bad hostname "${h}" for ${p.slug}`);
    if (allHosts.has(h)) fail(`hostname "${h}" is listed twice`);
    allHosts.add(h);
  }
}
for (const p of config.people) {
  for (const m of p.managedBy) if (!slugs.has(m) || m === p.slug) fail(`${p.slug}.managedBy: unknown person "${m}"`);
}
if (!config.people.some((p) => p.admin && p.emails.length)) {
  console.warn("family: warning: no admin has an email yet, so nobody can approve logins (BOOTSTRAP_ADMIN_EMAIL still works).");
}

// ------------------------------------------------------------------ wrangler.deploy.jsonc
const deployPath = "wrangler.deploy.jsonc";
if (!existsSync(deployPath)) {
  copyFileSync("wrangler.deploy.example.jsonc", deployPath);
  console.log(`Created ${deployPath} from the example. Fill in the remaining <placeholders> before deploying.`);
}
let deployText = readFileSync(deployPath, "utf8");
const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2 } };
const routes = [...allHosts].map((pattern) => ({ pattern, custom_domain: true }));
deployText = applyEdits(deployText, modify(deployText, ["routes"], routes, fmt));
deployText = applyEdits(deployText, modify(deployText, ["vars", "MAIN_HOST"], config.mainHost, fmt));
writeFileSync(deployPath, deployText);
console.log(`Updated ${deployPath}: MAIN_HOST and ${routes.length} routes.`);

// ------------------------------------------------------------------ seed SQL
const q = (s) => (s == null ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const id = () => {
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  return [...randomBytes(12)].map((b) => alphabet[b % alphabet.length]).join("");
};
const personId = (slug) => `(SELECT id FROM people WHERE slug = ${q(slug)})`;
const now = Date.now();
const sql = [];

for (const p of config.people) {
  sql.push(
    `INSERT INTO people (id, slug, display_name, is_admin, created_at) VALUES (${q(id())}, ${q(p.slug)}, ${q(p.name.trim())}, ${p.admin ? 1 : 0}, ${now})
  ON CONFLICT (slug) DO UPDATE SET display_name = excluded.display_name, is_admin = excluded.is_admin;`,
    // Every person starts with a default list.
    `INSERT INTO lists (id, person_id, name, slug, is_default, created_at)
  SELECT ${q(id())}, ${personId(p.slug)}, 'Wishlist', 'wishlist', 1, ${now}
  WHERE NOT EXISTS (SELECT 1 FROM lists WHERE person_id = ${personId(p.slug)});`,
  );
  for (const e of p.emails) {
    sql.push(
      `INSERT INTO users (email, person_id, status, requested_at, decided_at, created_at) VALUES (${q(e)}, ${personId(p.slug)}, 'active', ${now}, ${now}, ${now})
  ON CONFLICT (email) DO UPDATE SET person_id = excluded.person_id, status = 'active', decided_at = excluded.decided_at;`,
    );
  }
  const hosts = target === "local" ? [`${p.slug}.localhost`] : p.hostnames;
  for (const h of hosts) {
    sql.push(
      `INSERT INTO hostnames (hostname, person_id) VALUES (${q(h)}, ${personId(p.slug)})
  ON CONFLICT (hostname) DO UPDATE SET person_id = excluded.person_id;`,
    );
  }
}
for (const p of config.people) {
  for (const m of p.managedBy) {
    sql.push(`INSERT OR IGNORE INTO managers (manager_person_id, person_id) VALUES (${personId(m)}, ${personId(p.slug)});`);
  }
}

mkdirSync(".wrangler", { recursive: true });
const seedPath = ".wrangler/family-seed.sql";
writeFileSync(seedPath, `${sql.join("\n")}\n`);
console.log(`Wrote ${seedPath} (${config.people.length} people).`);

if (target) {
  const wranglerArgs = ["exec", "wrangler", "d1", "execute", "DB", `--${target}`, `--file=${seedPath}`];
  if (target === "remote") wranglerArgs.push("-c", deployPath);
  else console.log("Local dev uses <slug>.localhost hostnames, e.g. http://riley.localhost:8787");
  execFileSync("pnpm", wranglerArgs, { stdio: "inherit" });
}
