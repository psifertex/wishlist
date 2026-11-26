import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// All timestamps are Unix epoch milliseconds. Event dates are calendar dates
// ("YYYY-MM-DD") interpreted in the deployment's TIMEZONE.

export const people = sqliteTable("people", {
  id: text("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  displayName: text("display_name").notNull(),
  isAdmin: integer("is_admin", { mode: "boolean" }).notNull().default(false),
  createdAt: integer("created_at").notNull(),
});

export const USER_STATUSES = ["pending", "active", "rejected"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

/** Login identities. Unknown emails are recorded as pending until an admin decides. */
export const users = sqliteTable(
  "users",
  {
    email: text("email").primaryKey(),
    personId: text("person_id").references(() => people.id, { onDelete: "set null" }),
    status: text("status", { enum: USER_STATUSES }).notNull(),
    requestedName: text("requested_name"),
    requestedAt: integer("requested_at").notNull(),
    decidedByPersonId: text("decided_by_person_id").references(() => people.id, { onDelete: "set null" }),
    decidedAt: integer("decided_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [index("users_status_idx").on(t.status)],
);

/** manager (parent) can edit person's (kid's) lists and sees claims on them. */
export const managers = sqliteTable(
  "managers",
  {
    managerPersonId: text("manager_person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.managerPersonId, t.personId] })],
);

export const hostnames = sqliteTable("hostnames", {
  hostname: text("hostname").primaryKey(),
  personId: text("person_id")
    .notNull()
    .references(() => people.id, { onDelete: "cascade" }),
});

export const lists = sqliteTable(
  "lists",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    eventDate: text("event_date"),
    isDefault: integer("is_default", { mode: "boolean" }).notNull().default(false),
    archivedAt: integer("archived_at"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [uniqueIndex("lists_person_slug_idx").on(t.personId, t.slug)],
);

export const BOOK_FORMATS = ["hardcover", "paperback", "ebook", "audiobook", "any"] as const;
export type BookFormat = (typeof BOOK_FORMATS)[number];

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    personId: text("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    url: text("url"),
    asin: text("asin"),
    isbn: text("isbn"),
    format: text("format", { enum: BOOK_FORMATS }),
    variantText: text("variant_text"),
    priceCents: integer("price_cents"),
    currency: text("currency").notNull().default("USD"),
    priceCapturedAt: integer("price_captured_at"),
    imageKey: text("image_key"),
    sourceImageUrl: text("source_image_url"),
    notes: text("notes"),
    /** 0 = normal, 1 = really want it */
    priority: integer("priority").notNull().default(0),
    quantity: integer("quantity").notNull().default(1),
    createdByPersonId: text("created_by_person_id").references(() => people.id, { onDelete: "set null" }),
    createdAt: integer("created_at").notNull(),
    /** Owner deleted it while an unrevealed claim existed; hidden from owner only. */
    ownerHiddenAt: integer("owner_hidden_at"),
    /** Fully claimed and revealed; moved to the owner's Received archive. */
    receivedAt: integer("received_at"),
  },
  (t) => [index("items_person_idx").on(t.personId)],
);

export const listItems = sqliteTable(
  "list_items",
  {
    listId: text("list_id")
      .notNull()
      .references(() => lists.id, { onDelete: "cascade" }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    position: integer("position").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.listId, t.itemId] }), index("list_items_item_idx").on(t.itemId)],
);

export const claims = sqliteTable(
  "claims",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    /** The list it was claimed from; decides the reveal date. */
    listId: text("list_id").references(() => lists.id, { onDelete: "set null" }),
    quantity: integer("quantity").notNull().default(1),
    buyerName: text("buyer_name").notNull(),
    buyerPersonId: text("buyer_person_id").references(() => people.id, { onDelete: "set null" }),
    /** SHA-256 of the anonymous undo token stored in the buyer's cookie. */
    anonTokenHash: text("anon_token_hash"),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (t) => [index("claims_item_idx").on(t.itemId)],
);

/** Daily usage counters for free-tier budgets (R31). */
export const usage = sqliteTable(
  "usage",
  {
    day: text("day").notNull(),
    key: text("key").notNull(),
    count: integer("count").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.key] })],
);

export type Person = typeof people.$inferSelect;
export type User = typeof users.$inferSelect;
export type List = typeof lists.$inferSelect;
export type Item = typeof items.$inferSelect;
export type Claim = typeof claims.$inferSelect;
