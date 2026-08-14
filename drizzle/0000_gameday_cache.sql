CREATE TABLE `player_meta_cache` (
	`player_id` integer PRIMARY KEY NOT NULL,
	`draft` text DEFAULT '' NOT NULL,
	`school` text DEFAULT '' NOT NULL,
	`school_type` text DEFAULT '' NOT NULL,
	`birth_city` text DEFAULT '' NOT NULL,
	`birth_state` text DEFAULT '' NOT NULL,
	`birth_country` text DEFAULT '' NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`fail_count` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `roster_cache` (
	`team_id` integer NOT NULL,
	`date` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	PRIMARY KEY(`team_id`, `date`)
);
--> statement-breakpoint
CREATE TABLE `schedule_cache` (
	`date` text PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_player_meta_cache_expires_at` ON `player_meta_cache` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_roster_cache_expires_at` ON `roster_cache` (`expires_at`);
--> statement-breakpoint
CREATE INDEX `idx_schedule_cache_expires_at` ON `schedule_cache` (`expires_at`);
