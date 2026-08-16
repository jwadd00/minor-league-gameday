import { index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const scheduleCache = sqliteTable(
  "schedule_cache",
  {
    date: text("date").primaryKey(),
    payload: text("payload").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("idx_schedule_cache_expires_at").on(table.expiresAt),
  ],
);

export const rosterCache = sqliteTable(
  "roster_cache",
  {
    teamId: integer("team_id").notNull(),
    date: text("date").notNull(),
    payload: text("payload").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.teamId, table.date] }),
    index("idx_roster_cache_expires_at").on(table.expiresAt),
  ],
);

export const playerMetaCache = sqliteTable(
  "player_meta_cache",
  {
    playerId: integer("player_id").primaryKey(),
    draft: text("draft").notNull().default(""),
    school: text("school").notNull().default(""),
    schoolType: text("school_type").notNull().default(""),
    birthCity: text("birth_city").notNull().default(""),
    birthState: text("birth_state").notNull().default(""),
    birthCountry: text("birth_country").notNull().default(""),
    fetchedAt: integer("fetched_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    failCount: integer("fail_count").notNull().default(0),
  },
  (table) => [
    index("idx_player_meta_cache_expires_at").on(table.expiresAt),
  ],
);

export const dailySnapshotState = sqliteTable("daily_snapshot_state", {
  date: text("date").primaryKey(),
  generation: text("generation").notNull(),
  teamCount: integer("team_count").notNull(),
  playerCount: integer("player_count").notNull(),
  missingDraft: integer("missing_draft").notNull(),
  missingSchool: integer("missing_school").notNull(),
  builtAt: integer("built_at").notNull(),
});

export const dailyTeamSnapshot = sqliteTable(
  "daily_team_snapshot",
  {
    date: text("date").notNull(),
    generation: text("generation").notNull(),
    teamId: integer("team_id").notNull(),
    teamName: text("team_name").notNull(),
    payload: text("payload").notNull(),
    fetchedAt: integer("fetched_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.date, table.generation, table.teamId] }),
    index("idx_daily_team_snapshot_lookup").on(
      table.date,
      table.generation,
      table.teamId,
    ),
  ],
);

export const gameBoxScoreCache = sqliteTable("game_box_score_cache", {
  gamePk: integer("game_pk").primaryKey(),
  payload: text("payload").notNull(),
  fetchedAt: integer("fetched_at").notNull(),
});

export const backfillDayState = sqliteTable(
  "backfill_day_state",
  {
    date: text("date").primaryKey(),
    status: text("status").notNull(),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error").notNull().default(""),
    startedAt: integer("started_at").notNull().default(0),
    completedAt: integer("completed_at").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [index("idx_backfill_day_state_status_date").on(table.status, table.date)],
);

export const apiRateLimit = sqliteTable(
  "api_rate_limit",
  {
    clientKey: text("client_key").notNull(),
    bucket: text("bucket").notNull(),
    windowStart: integer("window_start").notNull(),
    requestCount: integer("request_count").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.clientKey, table.bucket, table.windowStart] }),
    index("idx_api_rate_limit_window_start").on(table.windowStart),
  ],
);
