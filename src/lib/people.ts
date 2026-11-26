import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db";
import { lists, managers, people, type Person } from "../db/schema";
import { newId, slugify } from "./ids";

/** Slugs that would collide with main-site routes (R20: /<person>/<list>). */
export const RESERVED_SLUGS = new Set([
  "app", "add", "api", "install", "login", "logout", "img", "dev", "admin", "static", "capture.js", "styles.css",
]);

export async function uniquePersonSlug(db: Db, base: string): Promise<string> {
  const root = slugify(base) || "person";
  for (let i = 0; i < 100; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`;
    if (RESERVED_SLUGS.has(slug)) continue;
    const hit = await db.select({ id: people.id }).from(people).where(eq(people.slug, slug)).get();
    if (!hit) return slug;
  }
  return `${root}-${newId(4)}`;
}

export async function uniqueListSlug(db: Db, personId: string, base: string): Promise<string> {
  const root = slugify(base) || "list";
  for (let i = 0; i < 100; i++) {
    const slug = i === 0 ? root : `${root}-${i + 1}`;
    const hit = await db
      .select({ id: lists.id })
      .from(lists)
      .where(and(eq(lists.personId, personId), eq(lists.slug, slug)))
      .get();
    if (!hit) return slug;
  }
  return `${root}-${newId(4)}`;
}

/** Creates a Person together with their default list. */
export async function createPerson(
  db: Db,
  opts: { displayName: string; slug?: string; isAdmin?: boolean; now?: number },
): Promise<Person> {
  const now = opts.now ?? Date.now();
  const person: Person = {
    id: newId(),
    slug: await uniquePersonSlug(db, opts.slug || opts.displayName),
    displayName: opts.displayName.trim() || "Someone",
    isAdmin: opts.isAdmin ?? false,
    createdAt: now,
  };
  await db.batch([
    db.insert(people).values(person),
    db.insert(lists).values({
      id: newId(),
      personId: person.id,
      name: "Wishlist",
      slug: "wishlist",
      isDefault: true,
      createdAt: now,
    }),
  ]);
  return person;
}

export async function managedIdsFor(db: Db, personId: string): Promise<Set<string>> {
  const rows = await db.select({ id: managers.personId }).from(managers).where(eq(managers.managerPersonId, personId));
  return new Set(rows.map((r) => r.id));
}

export async function peopleByIds(db: Db, ids: string[]): Promise<Person[]> {
  if (ids.length === 0) return [];
  return db.select().from(people).where(inArray(people.id, ids));
}
