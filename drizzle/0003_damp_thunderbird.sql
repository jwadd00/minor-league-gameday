CREATE TABLE `backfill_day_state` (
	`date` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text DEFAULT '' NOT NULL,
	`started_at` integer DEFAULT 0 NOT NULL,
	`completed_at` integer DEFAULT 0 NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_backfill_day_state_status_date` ON `backfill_day_state` (`status`,`date`);