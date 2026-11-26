import type { Context } from "hono";

/** Daily global ceilings (R31). Reset at UTC midnight. */
export const BUDGETS = {
  claim: 200,
  r2_write: 200,
  outbound_fetch: 300,
} as const;
export type BudgetKey = keyof typeof BUDGETS;

/** Hard caps on stored data (R32). */
export const CAPS = {
  maxPendingRequests: 25,
  itemsPerPerson: 500,
  listsPerPerson: 30,
  imageBytes: 2 * 1024 * 1024,
} as const;

export function clientIp(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? "local";
}

/** True when the caller is over the limit. A missing binding never limits. */
export async function isRateLimited(binding: RateLimit | undefined, key: string): Promise<boolean> {
  if (!binding) return false;
  const { success } = await binding.limit({ key });
  return !success;
}

export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Atomically counts one use; returns false once today's budget is used up. */
export async function consumeBudget(db: D1Database, key: BudgetKey, now = Date.now()): Promise<boolean> {
  const row = await db
    .prepare(
      "INSERT INTO usage (day, key, count) VALUES (?1, ?2, 1) ON CONFLICT (day, key) DO UPDATE SET count = count + 1 RETURNING count",
    )
    .bind(utcDay(now), key)
    .first<{ count: number }>();
  return (row?.count ?? 0) <= BUDGETS[key];
}

export async function usageToday(db: D1Database, now = Date.now()): Promise<Record<BudgetKey, number>> {
  const { results } = await db
    .prepare("SELECT key, count FROM usage WHERE day = ?1")
    .bind(utcDay(now))
    .all<{ key: string; count: number }>();
  const out = Object.fromEntries(Object.keys(BUDGETS).map((k) => [k, 0])) as Record<BudgetKey, number>;
  for (const r of results) if (r.key in out) out[r.key as BudgetKey] = r.count;
  return out;
}
