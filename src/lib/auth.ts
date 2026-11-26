import { and, count, eq } from "drizzle-orm";
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { getDb, type Db } from "../db";
import { people, users, type User } from "../db/schema";
import type { AppEnv, Env, Viewer } from "../env";
import { CAPS } from "./limits";
import { createPerson, managedIdsFor } from "./people";

const jwksByTeam = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

/** Dev auth is allowed only for local development without Access configured. */
export function devAuthEnabled(env: Env): boolean {
  return env.ENVIRONMENT === "development" && !env.ACCESS_AUD && !!env.DEV_AUTH_EMAIL;
}

/**
 * Returns the verified login email, or null. In production this is the email
 * in a valid Cloudflare Access JWT (header set by Access on protected paths,
 * or the CF_Authorization cookie on unprotected paths of the main host).
 */
export async function verifiedEmail(c: Context<AppEnv>): Promise<string | null> {
  const env = c.env;
  if (devAuthEnabled(env)) {
    const email = c.req.header("x-dev-email") ?? getCookie(c, "dev_email") ?? env.DEV_AUTH_EMAIL!;
    return email === "-" ? null : email.trim().toLowerCase();
  }
  const token = c.req.header("cf-access-jwt-assertion") ?? getCookie(c, "CF_Authorization");
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  let jwks = jwksByTeam.get(issuer);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
    jwksByTeam.set(issuer, jwks);
  }
  try {
    const { payload } = await jwtVerify(token, jwks, { issuer, audience: env.ACCESS_AUD });
    return typeof payload.email === "string" ? payload.email.toLowerCase() : null;
  } catch {
    return null;
  }
}

export type LoginState =
  | { kind: "active"; viewer: Viewer }
  | { kind: "pending"; user: User }
  | { kind: "rejected" }
  | { kind: "queue_full" };

async function adminExists(db: Db): Promise<boolean> {
  const row = await db.select({ n: count() }).from(people).where(eq(people.isAdmin, true)).get();
  return (row?.n ?? 0) > 0;
}

/**
 * Maps a verified email to a login state (R4a/R4b). Unknown emails become
 * pending requests. The bootstrap admin email is promoted automatically, but
 * only while no admin exists, so it can't be used to take over later.
 */
export async function resolveLogin(env: Env, email: string, now = Date.now()): Promise<LoginState> {
  const db = getDb(env.DB);
  let user = await db.select().from(users).where(eq(users.email, email)).get();

  const bootstrap = env.BOOTSTRAP_ADMIN_EMAIL?.trim().toLowerCase();
  if (bootstrap && bootstrap === email && !(await adminExists(db))) {
    const person = await createPerson(db, {
      displayName: email.split("@")[0] ?? "Admin",
      isAdmin: true,
      now,
    });
    await db
      .insert(users)
      .values({ email, personId: person.id, status: "active", requestedAt: now, decidedAt: now, createdAt: now })
      .onConflictDoUpdate({
        target: users.email,
        set: { personId: person.id, status: "active", decidedAt: now },
      });
    user = await db.select().from(users).where(eq(users.email, email)).get();
  }

  if (!user) {
    const pending = await db.select({ n: count() }).from(users).where(eq(users.status, "pending")).get();
    if ((pending?.n ?? 0) >= CAPS.maxPendingRequests) return { kind: "queue_full" };
    const row: User = {
      email,
      personId: null,
      status: "pending",
      requestedName: null,
      requestedAt: now,
      decidedByPersonId: null,
      decidedAt: null,
      createdAt: now,
    };
    await db.insert(users).values(row).onConflictDoNothing();
    return { kind: "pending", user: row };
  }

  if (user.status === "rejected") return { kind: "rejected" };
  if (user.status === "pending" || !user.personId) return { kind: "pending", user };

  const person = await db.select().from(people).where(eq(people.id, user.personId)).get();
  if (!person) return { kind: "pending", user };
  return {
    kind: "active",
    viewer: { email, person, isAdmin: person.isAdmin, managedIds: await managedIdsFor(db, person.id) },
  };
}

/** Active viewer from a login cookie, without creating pending requests. */
export async function optionalViewer(c: Context<AppEnv>): Promise<Viewer | null> {
  const email = await verifiedEmail(c);
  if (!email) return null;
  const db = getDb(c.env.DB);
  const user = await db
    .select()
    .from(users)
    .where(and(eq(users.email, email), eq(users.status, "active")))
    .get();
  if (!user?.personId) return null;
  const person = await db.select().from(people).where(eq(people.id, user.personId)).get();
  if (!person) return null;
  return { email, person, isAdmin: person.isAdmin, managedIds: await managedIdsFor(db, person.id) };
}

export function canEditPerson(viewer: Viewer, personId: string): boolean {
  return viewer.person.id === personId || viewer.isAdmin || viewer.managedIds.has(personId);
}
