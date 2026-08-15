CREATE TABLE `game_box_score_cache` (
	`game_pk` integer PRIMARY KEY NOT NULL,
	`payload` text NOT NULL,
	`fetched_at` integer NOT NULL
);
