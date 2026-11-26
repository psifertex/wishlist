import { and, asc, eq, gte, inArray, isNull, or } from "drizzle-orm";
import type { Db } from "../db";
import { claims, items, listItems, lists, type Claim, type Item, type List } from "../db/schema";
import type { Viewer } from "../env";
import { isRevealed } from "./reveal";

/**
 * R19: the list a person's hostname opens: the next upcoming event, else the
 * default list, else the oldest list.
 */
export async function targetList(db: Db, personId: string, today: string): Promise<List | undefined> {
  const live = and(eq(lists.personId, personId), isNull(lists.archivedAt));
  const upcoming = await db
    .select()
    .from(lists)
    .where(and(live, gte(lists.eventDate, today)))
    .orderBy(asc(lists.eventDate))
    .get();
  if (upcoming) return upcoming;
  const fallback = await db
    .select()
    .from(lists)
    .where(live)
    .orderBy(asc(lists.isDefault), asc(lists.createdAt))
    .all();
  return fallback.find((l) => l.isDefault) ?? fallback[0];
}

export interface ClaimView {
  claim: Claim;
  revealed: boolean;
  /** This browser (anon token) or this logged-in person made it. */
  mine: boolean;
}

export interface ItemView {
  item: Item;
  position: number;
  /** Claims the current viewer may see. */
  claims: ClaimView[];
  claimedQty: number;
  remainingQty: number;
}

export interface Perspective {
  /** Logged-in viewer, if any. */
  viewer: Viewer | null;
  /** SHA-256 of this browser's anonymous buyer token, if any. */
  anonTokenHash: string | null;
  now: number;
  timeZone: string;
}

/** True when the viewer is the list's owner and must not see unrevealed claims (R13, R16). */
export function isOwnerView(ownerId: string, p: Perspective): boolean {
  return p.viewer?.person.id === ownerId;
}

/**
 * Items on a list with the claims this perspective is allowed to see.
 * Owners see only revealed claims and never see items they've hidden.
 * Everyone else sees all live claims, so nobody buys a duplicate (R11).
 */
export async function listItemViews(db: Db, list: List, p: Perspective): Promise<ItemView[]> {
  const rows = await db
    .select({ item: items, position: listItems.position })
    .from(listItems)
    .innerJoin(items, eq(items.id, listItems.itemId))
    .where(and(eq(listItems.listId, list.id), isNull(items.receivedAt)))
    .orderBy(asc(listItems.position), asc(items.createdAt))
    .all();
  return itemViewsFor(db, list.personId, rows, p);
}

export async function itemViewsFor(
  db: Db,
  ownerId: string,
  rows: { item: Item; position: number }[],
  p: Perspective,
): Promise<ItemView[]> {
  const owner = isOwnerView(ownerId, p);
  const ids = rows.map((r) => r.item.id);
  const claimRows = ids.length
    ? await db
        .select({ claim: claims, eventDate: lists.eventDate })
        .from(claims)
        .leftJoin(lists, eq(lists.id, claims.listId))
        .where(and(inArray(claims.itemId, ids), isNull(claims.revokedAt)))
        .all()
    : [];

  const byItem = new Map<string, ClaimView[]>();
  for (const { claim, eventDate } of claimRows) {
    const revealed = isRevealed({ claimCreatedAt: claim.createdAt, listEventDate: eventDate }, p.now, p.timeZone);
    if (owner && !revealed) continue;
    const mine =
      (!!p.anonTokenHash && claim.anonTokenHash === p.anonTokenHash) ||
      (!!p.viewer && claim.buyerPersonId === p.viewer.person.id);
    const arr = byItem.get(claim.itemId) ?? [];
    arr.push({ claim, revealed, mine });
    byItem.set(claim.itemId, arr);
  }

  const out: ItemView[] = [];
  for (const { item, position } of rows) {
    const cs = byItem.get(item.id) ?? [];
    if (item.ownerHiddenAt) {
      // R15: the owner deleted it. Hidden from the owner; buyers who already
      // claimed it still see it. Nobody new can claim it.
      if (owner || !cs.some((c) => c.mine)) continue;
    }
    const claimedQty = cs.reduce((n, c) => n + c.claim.quantity, 0);
    out.push({ item, position, claims: cs, claimedQty, remainingQty: Math.max(0, item.quantity - claimedQty) });
  }
  return out;
}

/**
 * Claims this buyer (browser token or logged-in person) still holds on a
 * person's items that aren't shown on the current list: the item was taken off
 * the list, the list was archived, or it's on another list. Without this, a
 * buyer could lose sight of a live claim and never be able to undo it.
 */
export async function myOtherClaims(db: Db, personId: string, shownItemIds: string[], p: Perspective): Promise<ItemView[]> {
  const mine = [
    p.anonTokenHash ? eq(claims.anonTokenHash, p.anonTokenHash) : undefined,
    p.viewer ? eq(claims.buyerPersonId, p.viewer.person.id) : undefined,
  ].filter((x) => x !== undefined);
  if (mine.length === 0 || isOwnerView(personId, p)) return [];
  const rows = await db
    .select({ item: items, claim: claims })
    .from(claims)
    .innerJoin(items, eq(items.id, claims.itemId))
    .where(and(eq(items.personId, personId), isNull(claims.revokedAt), isNull(items.receivedAt), or(...mine)))
    .all();
  const byItem = new Map<string, ItemView>();
  for (const { item, claim } of rows) {
    if (shownItemIds.includes(item.id)) continue;
    const v = byItem.get(item.id) ?? { item, position: 0, claims: [], claimedQty: 0, remainingQty: 0 };
    v.claims.push({ claim, revealed: false, mine: true });
    v.claimedQty += claim.quantity;
    byItem.set(item.id, v);
  }
  return [...byItem.values()];
}

/** Live (non-revoked) claimed quantity for an item, regardless of viewer. */
export async function claimedQuantity(db: Db, itemId: string): Promise<number> {
  const rows = await db
    .select({ q: claims.quantity })
    .from(claims)
    .where(and(eq(claims.itemId, itemId), isNull(claims.revokedAt)))
    .all();
  return rows.reduce((n, r) => n + r.q, 0);
}
