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
