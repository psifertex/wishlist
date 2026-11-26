import { DAY_MS, localDate } from "./time";

/** How long a claim from a list without an event date stays hidden (R13). */
export const UNDATED_REVEAL_MS = 60 * DAY_MS;

export interface RevealInput {
  claimCreatedAt: number;
  /** Event date of the list the claim was made from, if any. */
  listEventDate: string | null | undefined;
}

/**
 * R13: a claim is hidden from the owner until the event date of the list it was
 * claimed from (start of that day in the deployment time zone), or 60 days after
 * the claim when that list has no event date.
 */
export function isRevealed(input: RevealInput, now: number, timeZone: string): boolean {
  if (input.listEventDate) return localDate(now, timeZone) >= input.listEventDate;
  return now >= input.claimCreatedAt + UNDATED_REVEAL_MS;
}
