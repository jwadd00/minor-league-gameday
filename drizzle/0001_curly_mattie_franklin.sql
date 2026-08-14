CREATE TABLE `daily_snapshot_state` (
	`date` text PRIMARY KEY NOT NULL,
	`generation` text NOT NULL,
	`team_count` integer NOT NULL,
	`player_count` integer NOT NULL,
	`missing_draft` integer NOT NULL,
	`missing_school` integer NOT NULL,
	`built_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `daily_team_snapshot` (
	`date` text NOT NULL,
	`generation` text NOT NULL,
	`team_id` integer NOT NULL,
	`team_name` text NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL,
	PRIMARY KEY(`date`, `generation`, `team_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_daily_team_snapshot_lookup` ON `daily_team_snapshot` (`date`,`generation`,`team_id`);