import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { setCookie } from "hono/cookie";
import { csrf } from "hono/csrf";
import { HTTPException } from "hono/http-exception";
import { secureHeaders } from "hono/secure-headers";
import { runDaily } from "./cron";
import { getDb } from "./db";
import { hostnames, people } from "./db/schema";
import type { AppEnv, Env } from "./env";
import { devAuthEnabled } from "./lib/auth";
import { adminRoutes } from "./routes/admin";
import { appRoutes } from "./routes/app";
import { publicRoutes } from "./routes/public";
import { Message } from "./views/layout";

export const app = new Hono<AppEnv>();

app.use(secureHeaders({ crossOriginOpenerPolicy: false, referrerPolicy: "strict-origin-when-cross-origin" }));
// Rejects cross-site form posts (Origin must match this host).
app.use(csrf());

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

app.route("/", appRoutes);
app.route("/", adminRoutes);
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
