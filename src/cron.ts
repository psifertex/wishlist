import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { getDb } from "./db";
import { claims, items, lists, usage } from "./db/schema";
import type { Env } from "./env";
import { isRevealed } from "./lib/reveal";
import { DAY_MS } from "./lib/time";

/**
 * Daily job (R14): items whose revealed claims cover the wanted quantity move
 * to the owner's Received archive, which removes them from every list.
 * Items the owner deleted that no longer have any live claim are purged.
 */
export async function runDaily(env: Env, now = Date.now()): Promise<{ received: number; purged: number }> {
  const db = getDb(env.DB);
  const rows = await db
    .select({ item: items, claim: claims, eventDate: lists.eventDate })
    .from(claims)
    .innerJoin(items, eq(items.id, claims.itemId))
    .leftJoin(lists, eq(lists.id, claims.listId))
    .where(and(isNull(claims.revokedAt), isNull(items.receivedAt)))
    .all();

  const revealedQty = new Map<string, { quantity: number; revealed: number }>();
  for (const r of rows) {
    const entry = revealedQty.get(r.item.id) ?? { quantity: r.item.quantity, revealed: 0 };
    if (isRevealed({ claimCreatedAt: r.claim.createdAt, listEventDate: r.eventDate }, now, env.TIMEZONE)) {
      entry.revealed += r.claim.quantity;
    }
    revealedQty.set(r.item.id, entry);
  }
  const done = [...revealedQty].filter(([, v]) => v.revealed >= v.quantity).map(([id]) => id);
  if (done.length) await db.update(items).set({ receivedAt: now }).where(inArray(items.id, done));

  // Owner-deleted items whose claims were all undone.
  const hidden = await db
    .select({ id: items.id, imageKey: items.imageKey })
    .from(items)
    .where(and(isNull(items.receivedAt), lt(items.ownerHiddenAt, now)))
    .all();
  const stillClaimed = new Set(rows.map((r) => r.item.id));
  const purgeRows = hidden.filter((h) => !stillClaimed.has(h.id));
  const purge = purgeRows.map((h) => h.id);
  if (purge.length) {
    await db.delete(items).where(inArray(items.id, purge));
    // Their pictures too, so deleted items don't leave paid-for storage behind.
    const keys = purgeRows.map((h) => h.imageKey).filter((k): k is string => !!k);
    for (let i = 0; i < keys.length; i += 1000) await env.IMAGES.delete(keys.slice(i, i + 1000));
  }

  // Usage counters older than 30 days aren't needed.
  const cutoff = new Date(now - 30 * DAY_MS).toISOString().slice(0, 10);
  await db.delete(usage).where(lt(usage.day, cutoff));

  return { received: done.length, purged: purge.length };
}
