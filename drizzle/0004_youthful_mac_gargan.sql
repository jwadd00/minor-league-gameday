CREATE TABLE `api_rate_limit` (
	`client_key` text NOT NULL,
	`bucket` text NOT NULL,
	`window_start` integer NOT NULL,
	`request_count` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`client_key`, `bucket`, `window_start`)
);
--> statement-breakpoint
CREATE INDEX `idx_api_rate_limit_window_start` ON `api_rate_limit` (`window_start`);