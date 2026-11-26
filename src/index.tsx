import { eq } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { runDaily } from "./cron";
import { getDb } from "./db";
import { hostnames, people } from "./db/schema";
import type { AppEnv, Env } from "./env";
import { devAuthEnabled } from "./lib/auth";
import { CAPS } from "./lib/limits";
import { adminRoutes } from "./routes/admin";
import { appRoutes } from "./routes/app";
import { mainUrl } from "./routes/util";
import { installRoutes } from "./routes/install";
import { publicRoutes } from "./routes/public";
import { Message } from "./views/layout";

export const app = new Hono<AppEnv>();

app.use(secureHeaders({ crossOriginOpenerPolicy: false, referrerPolicy: "strict-origin-when-cross-origin" }));
// Rejects cross-site form posts (Origin must match this host).
app.use(csrf());

// Caps request bodies before anything parses them (R32). Only the item forms
// carry a photo; everything else is a few small fields. bodyLimit also counts
// bytes on bodies sent without a Content-Length.
const tooLarge = (c: Context) => c.text("That upload is too large.", 413);
const smallBody = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
const photoBody = bodyLimit({ maxSize: CAPS.imageBytes + 256 * 1024, onError: tooLarge });
app.use(async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const path = new URL(c.req.url).pathname;
  const hasPhoto = path === "/add" || /^\/app\/items\/[^/]+$/.test(path);
  return (hasPhoto ? photoBody : smallBody)(c, next);
});

// Host routing (R18-R21): the main site, or a person's public hostname.
app.use(async (c, next) => {
  const host = new URL(c.req.url).hostname.toLowerCase();
  if (host === c.env.MAIN_HOST) {
    c.set("site", { kind: "main" });
    return next();
  }
  const db = getDb(c.env.DB);
  const row = await db
    .select({ person: people })
    .from(hostnames)
    .innerJoin(people, eq(people.id, hostnames.personId))
    .where(eq(hostnames.hostname, host))
    .get();
  if (!row) return c.text("Unknown site.", 404);
  c.set("site", { kind: "person", person: row.person });
  return next();
});

// Local development only: switch the pretend login, e.g. /dev/login?email=kid@example.com
app.get("/dev/login", (c) => {
  if (!devAuthEnabled(c.env)) return c.notFound();
  setCookie(c, "dev_email", c.req.query("email") ?? "-", { path: "/", httpOnly: true, sameSite: "Lax" });
  return c.redirect("/app");
});

// Log out (works from any of the site's hostnames). Access keeps two sessions:
// this site's CF_Authorization cookie and the team-wide session at the team
// domain. Clearing only the first would sign straight back in as the same
// account, so after clearing it we send the browser to the team logout, which
// ends both and shows the login-method choice next time.
app.get("/logout", (c) => {
  if (c.get("site").kind !== "main") return c.redirect(`${mainUrl(c)}/logout`);
  const secure = new URL(c.req.url).protocol === "https:";
  deleteCookie(c, "CF_Authorization", { path: "/", secure });
  deleteCookie(c, "dev_email", { path: "/" });
  if (c.env.ACCESS_TEAM_DOMAIN && !devAuthEnabled(c.env)) {
    return c.redirect(`https://${c.env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/logout`);
  }
  return c.redirect("/");
});

// The capture script for the iOS Shortcut, with this site's address baked in
// so the script can return the complete add-page URL.
app.get("/shortcut.js", async (c) => {
  const res = await c.env.ASSETS?.fetch(new URL("/capture.js", c.req.url));
  if (!res?.ok) return c.notFound();
  const body = `var __WL_ORIGIN = ${JSON.stringify(mainUrl(c))};\n${await res.text()}`;
  return c.body(body, 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
});

app.route("/", appRoutes);
app.route("/", adminRoutes);
app.route("/", installRoutes);
app.route("/", publicRoutes);

app.notFound((c) => c.html(<Message title="Not found">There's nothing here.</Message>, 404));
app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  console.error(err);
  return c.html(<Message title="Something went wrong">Please try again in a moment.</Message>, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(runDaily(env).then((r) => console.log("daily", r)));
  },
} satisfies ExportedHandler<Env>;
