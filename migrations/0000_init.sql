CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`item_id` text NOT NULL,
	`list_id` text,
	`quantity` integer DEFAULT 1 NOT NULL,
	`buyer_name` text NOT NULL,
	`buyer_person_id` text,
	`anon_token_hash` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`buyer_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `claims_item_idx` ON `claims` (`item_id`);--> statement-breakpoint
CREATE TABLE `hostnames` (
	`hostname` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `items` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`title` text NOT NULL,
	`url` text,
	`asin` text,
	`isbn` text,
	`format` text,
	`variant_text` text,
	`price_cents` integer,
	`currency` text DEFAULT 'USD' NOT NULL,
	`price_captured_at` integer,
	`image_key` text,
	`source_image_url` text,
	`notes` text,
	`priority` integer DEFAULT 0 NOT NULL,
	`quantity` integer DEFAULT 1 NOT NULL,
	`created_by_person_id` text,
	`created_at` integer NOT NULL,
	`owner_hidden_at` integer,
	`received_at` integer,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`created_by_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `items_person_idx` ON `items` (`person_id`);--> statement-breakpoint
CREATE TABLE `list_items` (
	`list_id` text NOT NULL,
	`item_id` text NOT NULL,
	`position` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`list_id`, `item_id`),
	FOREIGN KEY (`list_id`) REFERENCES `lists`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`item_id`) REFERENCES `items`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `list_items_item_idx` ON `list_items` (`item_id`);--> statement-breakpoint
CREATE TABLE `lists` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`name` text NOT NULL,
	`slug` text NOT NULL,
	`event_date` text,
	`is_default` integer DEFAULT false NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `lists_person_slug_idx` ON `lists` (`person_id`,`slug`);--> statement-breakpoint
CREATE TABLE `managers` (
	`manager_person_id` text NOT NULL,
	`person_id` text NOT NULL,
	PRIMARY KEY(`manager_person_id`, `person_id`),
	FOREIGN KEY (`manager_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`display_name` text NOT NULL,
	`is_admin` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_slug_unique` ON `people` (`slug`);--> statement-breakpoint
CREATE TABLE `usage` (
	`day` text NOT NULL,
	`key` text NOT NULL,
	`count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `key`)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`email` text PRIMARY KEY NOT NULL,
	`person_id` text,
	`status` text NOT NULL,
	`requested_name` text,
	`requested_at` integer NOT NULL,
	`decided_by_person_id` text,
	`decided_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`decided_by_person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `users_status_idx` ON `users` (`status`);