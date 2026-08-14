import { env } from "cloudflare:workers";
import { getRequestExecutionContext } from "vinext/shims/request-context";

export const dynamic = "force-dynamic";

const API_BASE = "https://statsapi.mlb.com/api/v1";
const MINOR_SPORT_IDS = "11,12,13,14,16";
const CARD_TIMEOUT_MS = 3500;
const SCHEDULE_TTL_MS = 3 * 60 * 1000;
const ROSTER_TTL_MS = 15 * 60 * 1000;
const PLAYER_META_TTL_MS = 21 * 24 * 60 * 60 * 1000;
const FAILED_CARD_TTL_MS = 60 * 60 * 1000;

type Dict = Record<string, unknown>;

type TeamSummary = {
  id: number;
  name: string;
  shortName: string;
  abbreviation: string;
};

type Game = {
  gamePk: number;
  gameDate: string;
  status: string;
  venue: string;
  level: string;
  away: TeamSummary;
  home: TeamSummary;
};

type BioStatus = "fresh" | "stale" | "missing";

type Player = {
  id: number;
  name: string;
  teamId: number;
  teamName: string;
  position: string;
  number: string;
  status: string;
  draft: string;
  school: string;
  schoolType: string;
  birthCity: string;
  birthState: string;
  birthCountry: string;
  milbUrl: string;
  bioStatus?: BioStatus;
};

type PlayerCard = Pick<
  Player,
  "draft" | "school" | "schoolType" | "birthCity" | "birthState" | "birthCountry"
>;

type CacheInfo = {
  totalPlayers: number;
  freshBio: number;
  staleBio: number;
  missingBio: number;
  refreshedBio?: number;
};

type CacheEntry<T> = {
  payload: T;
  fetchedAt: number;
  expiresAt: number;
};

type PlayerMetaRow = PlayerCard & {
  playerId: number;
  fetchedAt: number;
  expiresAt: number;
  failCount: number;
};

type CacheStore = {
  db?: D1Database;
};

const cardCache = new Map<number, Promise<Partial<PlayerCard>>>();
const memorySchedule = new Map<string, CacheEntry<Game[]>>();
const memoryRosters = new Map<string, CacheEntry<Player[]>>();
const memoryPlayers = new Map<number, PlayerMetaRow>();
let schemaReady: Promise<void> | null = null;

export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const view = url.searchParams.get("view") ?? "games";
    const date = normalizeDate(url.searchParams.get("date"));
    const cache = await getCacheStore();

    if (view === "games") {
      return Response.json({ games: await getGames(date, cache) });
    }

    if (view === "game" || view === "enrichGame") {
      const gamePk = Number(url.searchParams.get("gamePk"));
      if (!Number.isFinite(gamePk)) {
        return Response.json({ error: "gamePk is required." }, { status: 400 });
      }

      const detail = await getGameDetail(date, gamePk, cache, view === "enrichGame");

      if (view === "game" && shouldRefreshBio(detail.cacheInfo)) {
        getRequestExecutionContext()?.waitUntil(
          enrichGameBio(date, gamePk, cache).catch(() => undefined),
        );
      }

      return Response.json(detail);
    }

    if (view === "players") {
      const games = await getGames(date, cache);
      const teams = uniqueTeams(games);
      const rosters = await mapLimit(teams, 8, (team) =>
        getRoster(team, date, cache, false),
      );
      const players = rosters
        .flatMap((entry) => entry.players)
        .sort((a, b) => a.name.localeCompare(b.name));

      return Response.json({
        players,
        teamCount: teams.length,
        cacheInfo: summarizePlayers(players),
      });
    }

    if (view === "warm") {
      const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
      const limit = Math.min(
        24,
        Math.max(1, Number(url.searchParams.get("limitTeams")) || 12),
      );
      const scope = url.searchParams.get("scope") === "all" ? "all" : "fullSeason";
      const games = await getGames(date, cache);
      const teams = uniqueTeams(
        scope === "all" ? games : games.filter((game) => !isComplexLeagueGame(game)),
      );
      const batch = teams.slice(offset, offset + limit);
      const results = await mapLimit(batch, 4, async (team) => {
        const roster = await getRoster(team, date, cache, false);
        const refreshedBio = await enrichPlayers(roster.players, cache);
        return { teamId: team.id, playerCount: roster.players.length, refreshedBio };
      });

      return Response.json({
        date,
        scope,
        teams: results.length,
        totalTeams: teams.length,
        nextOffset: offset + results.length < teams.length ? offset + results.length : null,
        refreshedBio: results.reduce((sum, item) => sum + item.refreshedBio, 0),
      });
    }

    return Response.json({ error: "Unknown view." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return Response.json({ error: message }, { status: 500 });
  }
}

async function getGameDetail(
  date: string,
  gamePk: number,
  cache: CacheStore,
  enrich: boolean,
) {
  const games = await getGames(date, cache);
  const game = games.find((entry) => entry.gamePk === gamePk);
  if (!game) {
    throw new Error("Game was not found for that date.");
  }

  const teams = await Promise.all(
    [game.away, game.home].map(async (team) => {
      const roster = await getRoster(team, date, cache, false);
      const refreshedBio = enrich ? await enrichPlayers(roster.players, cache) : 0;
      const merged = enrich && refreshedBio > 0
        ? await mergeCachedBio(await getBaseRoster(team, date, cache), cache)
        : roster;

      return {
        team,
        players: merged.players,
        cacheInfo: {
          ...merged.cacheInfo,
          refreshedBio,
        },
      };
    }),
  );

  return {
    game,
    teams,
    cacheInfo: teams.reduce<CacheInfo>(
      (summary, team) => ({
        totalPlayers: summary.totalPlayers + team.cacheInfo.totalPlayers,
        freshBio: summary.freshBio + team.cacheInfo.freshBio,
        staleBio: summary.staleBio + team.cacheInfo.staleBio,
        missingBio: summary.missingBio + team.cacheInfo.missingBio,
        refreshedBio:
          (summary.refreshedBio ?? 0) + (team.cacheInfo.refreshedBio ?? 0),
      }),
      { totalPlayers: 0, freshBio: 0, staleBio: 0, missingBio: 0, refreshedBio: 0 },
    ),
  };
}

async function enrichGameBio(date: string, gamePk: number, cache: CacheStore) {
  await getGameDetail(date, gamePk, cache, true);
}

async function getGames(date: string, cache: CacheStore): Promise<Game[]> {
  const cached = await readScheduleCache(date, cache);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  try {
    const payload = await statsApi(
      `/schedule?sportId=${MINOR_SPORT_IDS}&date=${date}&gameTypes=R,F,D,L,W,C&hydrate=team,venue`,
    );
    const dates = arrayOf(payload.dates);
    const games = dates
      .flatMap((day) => arrayOf(objectOf(day).games))
      .map(normalizeGame)
      .filter((game): game is Game => Boolean(game))
      .sort((a, b) => a.gameDate.localeCompare(b.gameDate));

    await writeScheduleCache(date, games, cache);
    return games;
  } catch (error) {
    if (cached) {
      return cached.payload;
    }
    throw error;
  }
}

async function getRoster(
  team: TeamSummary,
  date: string,
  cache: CacheStore,
  forceRosterRefresh: boolean,
): Promise<{ players: Player[]; cacheInfo: CacheInfo }> {
  const players = await getBaseRoster(team, date, cache, forceRosterRefresh);
  return mergeCachedBio(players, cache);
}

async function getBaseRoster(
  team: TeamSummary,
  date: string,
  cache: CacheStore,
  forceRefresh = false,
): Promise<Player[]> {
  const cacheKey = `${team.id}:${date}`;
  const cached = await readRosterCache(team.id, date, cache);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
    return cached.payload;
  }

  try {
    const season = date.slice(0, 4);
    const payload = await statsApi(
      `/teams/${team.id}/roster?rosterType=fullRoster&season=${season}&date=${date}&hydrate=person`,
    );
    const roster = arrayOf(payload.roster);
    const players = roster
      .map((entry) => normalizePlayer(objectOf(entry), team))
      .filter((player): player is Player => Boolean(player))
      .sort((a, b) => {
        const position = a.position.localeCompare(b.position);
        return position || a.name.localeCompare(b.name);
      });

    await writeRosterCache(team.id, date, players, cache);
    return players;
  } catch (error) {
    if (cached) {
      return cached.payload;
    }
    memoryRosters.delete(cacheKey);
    throw error;
  }
}

async function mergeCachedBio(
  players: Player[],
  cache: CacheStore,
): Promise<{ players: Player[]; cacheInfo: CacheInfo }> {
  const now = Date.now();
  const metas = await readPlayerMetas(players.map((player) => player.id), cache);
  let freshBio = 0;
  let staleBio = 0;
  let missingBio = 0;

  const merged = players.map((player) => {
    const meta = metas.get(player.id);
    const bioStatus: BioStatus = !meta
      ? "missing"
      : meta.expiresAt > now && hasBackgroundBio(meta, player)
        ? "fresh"
        : "stale";

    if (bioStatus === "fresh") {
      freshBio += 1;
    } else if (bioStatus === "stale") {
      staleBio += 1;
    } else {
      missingBio += 1;
    }

    return {
      ...player,
      ...emptyFallback(meta ?? {}, player),
      bioStatus,
    };
  });

  return {
    players: merged,
    cacheInfo: {
      totalPlayers: players.length,
      freshBio,
      staleBio,
      missingBio,
    },
  };
}

async function enrichPlayers(players: Player[], cache: CacheStore) {
  const now = Date.now();
  const metas = await readPlayerMetas(players.map((player) => player.id), cache);
  const stalePlayers = players.filter((player) => {
    const meta = metas.get(player.id);
    return !meta || meta.expiresAt <= now || !hasBackgroundBio(meta, player);
  });

  const refreshed = await mapLimit(stalePlayers, 6, async (player) => {
    const current = metas.get(player.id);
    const card = await getOfficialPlayerCard(player.id);
    const merged = emptyFallback(card, player);
    const useful = hasBackgroundBio(card, player);
    const failCount = useful ? 0 : (current?.failCount ?? 0) + 1;
    await writePlayerMeta(
      {
        playerId: player.id,
        ...merged,
        fetchedAt: now,
        expiresAt: now + (useful ? PLAYER_META_TTL_MS : FAILED_CARD_TTL_MS),
        failCount,
      },
      cache,
    );
    return useful ? 1 : 0;
  });

  return refreshed.reduce((sum, item) => sum + item, 0);
}

async function getOfficialPlayerCard(playerId: number): Promise<Partial<PlayerCard>> {
  const cached = cardCache.get(playerId);
  if (cached) {
    return cached;
  }

  const promise = fetchPlayerCard(playerId);
  cardCache.set(playerId, promise);
  return promise;
}

async function fetchPlayerCard(playerId: number): Promise<Partial<PlayerCard>> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CARD_TIMEOUT_MS);

  try {
    const response = await fetch(`https://www.milb.com/player/${playerId}`, {
      headers: {
        accept: "text/html,application/xhtml+xml",
        "user-agent": "Minor League Gameday Scout",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return {};
    }

    return extractCardDetails(await response.text());
  } catch {
    return {};
  } finally {
    clearTimeout(timeout);
  }
}

async function statsApi(path: string): Promise<Dict> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
  });

  if (!response.ok) {
    throw new Error(`MiLB data request failed with status ${response.status}.`);
  }

  return objectOf(await response.json());
}

async function getCacheStore(): Promise<CacheStore> {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) {
    return {};
  }

  schemaReady ??= ensureSchema(db);
  await schemaReady;
  return { db };
}

async function ensureSchema(db: D1Database) {
  await db.batch([
    db.prepare(
      "CREATE TABLE IF NOT EXISTS schedule_cache (date TEXT PRIMARY KEY, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS roster_cache (team_id INTEGER NOT NULL, date TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (team_id, date))",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS player_meta_cache (player_id INTEGER PRIMARY KEY, draft TEXT NOT NULL DEFAULT '', school TEXT NOT NULL DEFAULT '', school_type TEXT NOT NULL DEFAULT '', birth_city TEXT NOT NULL DEFAULT '', birth_state TEXT NOT NULL DEFAULT '', birth_country TEXT NOT NULL DEFAULT '', fetched_at INTEGER NOT NULL, expires_at INTEGER NOT NULL, fail_count INTEGER NOT NULL DEFAULT 0)",
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_schedule_cache_expires_at ON schedule_cache (expires_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_roster_cache_expires_at ON roster_cache (expires_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_player_meta_cache_expires_at ON player_meta_cache (expires_at)"),
    db.prepare("PRAGMA optimize"),
  ]);
}

async function readScheduleCache(date: string, cache: CacheStore) {
  if (!cache.db) {
    return memorySchedule.get(date);
  }

  const row = await cache.db
    .prepare("SELECT payload, fetched_at, expires_at FROM schedule_cache WHERE date = ?")
    .bind(date)
    .first<{ payload: string; fetched_at: number; expires_at: number }>();

  return row
    ? {
        payload: JSON.parse(row.payload) as Game[],
        fetchedAt: row.fetched_at,
        expiresAt: row.expires_at,
      }
    : undefined;
}

async function writeScheduleCache(date: string, games: Game[], cache: CacheStore) {
  const now = Date.now();
  const entry = { payload: games, fetchedAt: now, expiresAt: now + SCHEDULE_TTL_MS };

  if (!cache.db) {
    memorySchedule.set(date, entry);
    return;
  }

  await cache.db
    .prepare(
      "INSERT INTO schedule_cache (date, payload, fetched_at, expires_at) VALUES (?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
    )
    .bind(date, JSON.stringify(games), entry.fetchedAt, entry.expiresAt)
    .run();
}

async function readRosterCache(teamId: number, date: string, cache: CacheStore) {
  const key = `${teamId}:${date}`;
  if (!cache.db) {
    return memoryRosters.get(key);
  }

  const row = await cache.db
    .prepare("SELECT payload, fetched_at, expires_at FROM roster_cache WHERE team_id = ? AND date = ?")
    .bind(teamId, date)
    .first<{ payload: string; fetched_at: number; expires_at: number }>();

  return row
    ? {
        payload: JSON.parse(row.payload) as Player[],
        fetchedAt: row.fetched_at,
        expiresAt: row.expires_at,
      }
    : undefined;
}

async function writeRosterCache(
  teamId: number,
  date: string,
  players: Player[],
  cache: CacheStore,
) {
  const now = Date.now();
  const key = `${teamId}:${date}`;
  const entry = { payload: players, fetchedAt: now, expiresAt: now + ROSTER_TTL_MS };

  if (!cache.db) {
    memoryRosters.set(key, entry);
    return;
  }

  await cache.db
    .prepare(
      "INSERT INTO roster_cache (team_id, date, payload, fetched_at, expires_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(team_id, date) DO UPDATE SET payload = excluded.payload, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at",
    )
    .bind(teamId, date, JSON.stringify(players), entry.fetchedAt, entry.expiresAt)
    .run();
}

async function readPlayerMetas(playerIds: number[], cache: CacheStore) {
  const ids = Array.from(new Set(playerIds)).filter(Number.isFinite);
  const rows = new Map<number, PlayerMetaRow>();

  if (ids.length === 0) {
    return rows;
  }

  if (!cache.db) {
    for (const id of ids) {
      const row = memoryPlayers.get(id);
      if (row) {
        rows.set(id, row);
      }
    }
    return rows;
  }

  const placeholders = ids.map(() => "?").join(",");
  const result = await cache.db
    .prepare(
      `SELECT player_id, draft, school, school_type, birth_city, birth_state, birth_country, fetched_at, expires_at, fail_count FROM player_meta_cache WHERE player_id IN (${placeholders})`,
    )
    .bind(...ids)
    .all<{
      player_id: number;
      draft: string;
      school: string;
      school_type: string;
      birth_city: string;
      birth_state: string;
      birth_country: string;
      fetched_at: number;
      expires_at: number;
      fail_count: number;
    }>();

  for (const row of result.results ?? []) {
    rows.set(row.player_id, {
      playerId: row.player_id,
      draft: cleanField(row.draft),
      school: cleanField(row.school),
      schoolType: cleanField(row.school_type),
      birthCity: cleanField(row.birth_city),
      birthState: cleanField(row.birth_state),
      birthCountry: cleanField(row.birth_country),
      fetchedAt: row.fetched_at,
      expiresAt: row.expires_at,
      failCount: row.fail_count,
    });
  }

  return rows;
}

async function writePlayerMeta(row: PlayerMetaRow, cache: CacheStore) {
  if (!cache.db) {
    memoryPlayers.set(row.playerId, row);
    return;
  }

  await cache.db
    .prepare(
      "INSERT INTO player_meta_cache (player_id, draft, school, school_type, birth_city, birth_state, birth_country, fetched_at, expires_at, fail_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(player_id) DO UPDATE SET draft = excluded.draft, school = excluded.school, school_type = excluded.school_type, birth_city = excluded.birth_city, birth_state = excluded.birth_state, birth_country = excluded.birth_country, fetched_at = excluded.fetched_at, expires_at = excluded.expires_at, fail_count = excluded.fail_count",
    )
    .bind(
      row.playerId,
      cleanField(row.draft),
      cleanField(row.school),
      cleanField(row.schoolType),
      cleanField(row.birthCity),
      cleanField(row.birthState),
      cleanField(row.birthCountry),
      row.fetchedAt,
      row.expiresAt,
      row.failCount,
    )
    .run();
}

function normalizeGame(value: unknown): Game | null {
  const game = objectOf(value);
  const teams = objectOf(game.teams);
  const away = normalizeTeam(objectOf(teams.away));
  const home = normalizeTeam(objectOf(teams.home));
  const gamePk = numberOf(game.gamePk);
  const gameDate = stringOf(game.gameDate);

  if (!away || !home || !gamePk || !gameDate) {
    return null;
  }

  return {
    gamePk,
    gameDate,
    status: stringOf(objectOf(game.status).detailedState) || "Scheduled",
    venue: stringOf(objectOf(game.venue).name) || "Venue TBD",
    level: stringOf(objectOf(objectOf(objectOf(homeRaw(teams)).team).sport).name) || "MiLB",
    away,
    home,
  };
}

function homeRaw(teams: Dict) {
  return objectOf(teams.home);
}

function normalizeTeam(side: Dict): TeamSummary | null {
  const team = objectOf(side.team);
  const id = numberOf(team.id);
  const name = stringOf(team.name);

  if (!id || !name) {
    return null;
  }

  return {
    id,
    name,
    shortName: stringOf(team.shortName) || name,
    abbreviation: stringOf(team.abbreviation) || "",
  };
}

function normalizePlayer(entry: Dict, team: TeamSummary): Player | null {
  const person = objectOf(entry.person);
  const id = numberOf(person.id);
  const name = stringOf(person.fullName);

  if (!id || !name) {
    return null;
  }

  const education = extractEducation(person);
  const draft = extractDraft(person);
  const birthCity = stringOf(person.birthCity);
  const birthState = stringOf(person.birthStateProvince);
  const birthCountry = stringOf(person.birthCountry);

  return {
    id,
    name,
    teamId: team.id,
    teamName: team.shortName || team.name,
    position:
      stringOf(objectOf(entry.position).abbreviation) ||
      stringOf(objectOf(person.primaryPosition).abbreviation),
    number: stringOf(entry.jerseyNumber),
    status: stringOf(objectOf(entry.status).description),
    draft,
    school: education.school,
    schoolType: education.schoolType,
    birthCity,
    birthState,
    birthCountry,
    milbUrl: `https://www.milb.com/player/${id}`,
  };
}

function extractCardDetails(html: string): Partial<PlayerCard> {
  const text = htmlToText(html);
  const draft = fieldAfter(text, "Draft", [
    "College",
    "High School",
    "Relationship",
    "Relationship(s)",
    "Follow",
    "Latest Transactions",
    "Stats",
    "2026 Stats",
    "MiLB Career Stats",
  ]);
  const college = fieldAfter(text, "College", [
    "High School",
    "Relationship",
    "Relationship(s)",
    "Follow",
    "Latest Transactions",
    "Stats",
    "2026 Stats",
    "MiLB Career Stats",
  ]);
  const highSchool = fieldAfter(text, "High School", [
    "College",
    "Relationship",
    "Relationship(s)",
    "Follow",
    "Latest Transactions",
    "Stats",
    "2026 Stats",
    "MiLB Career Stats",
  ]);
  const born = fieldAfter(text, "Born", [
    "Draft",
    "College",
    "High School",
    "Relationship",
    "Relationship(s)",
    "Follow",
    "2026 Stats",
    "MiLB Career Stats",
  ]);
  const birthplace = parseBirthplace(born);

  return {
    draft,
    school: college || highSchool,
    schoolType: college ? "College" : highSchool ? "High School" : "",
    ...birthplace,
  };
}

function htmlToText(html: string) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function fieldAfter(text: string, label: string, nextLabels: string[]) {
  const marker = `${label}:`;
  const start = text.indexOf(marker);
  if (start === -1) {
    return "";
  }

  const after = text.slice(start + marker.length).trim();
  const stops = nextLabels
    .flatMap((next) => {
      const withColon = after.indexOf(`${next}:`);
      const plain = after.indexOf(` ${next} `);
      return [withColon, plain];
    })
    .filter((index) => index > 0);
  const end = stops.length ? Math.min(...stops) : after.length;

  return cleanField(after.slice(0, end));
}

function cleanField(value: string) {
  return value
    .replace(/\s+\d{4}\s+Stats\b.*$/i, "")
    .replace(/\s+MiLB\s+Career\s+Stats\b.*$/i, "")
    .replace(/\s+Relationship(?:\(s\))?\b.*$/i, "")
    .replace(/\s+Follow\b.*$/i, "")
    .replace(/\s+\|\s+.*$/, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseBirthplace(value: string): Partial<PlayerCard> {
  const location = value.match(/\bin\s+(.+)$/i)?.[1] ?? "";
  const parts = location.split(",").map((part) => part.trim()).filter(Boolean);

  if (parts.length === 0) {
    return {};
  }

  const region = parts[1] ?? "";
  const looksLikeState = /^[A-Z]{2}$/.test(region);

  return {
    birthCity: parts[0] ?? "",
    birthState: looksLikeState ? region : "",
    birthCountry: looksLikeState ? (parts[2] ?? "") : region,
  };
}

function extractEducation(person: Dict) {
  const highSchool =
    stringOf(person.highSchool) ||
    stringOf(findNestedValue(person, ["highSchool", "high_school"]));
  const college =
    stringOf(person.college) ||
    stringOf(person.school) ||
    stringOf(findNestedValue(person, ["college", "schoolName", "school"]));

  if (college) {
    return { school: college, schoolType: "College" };
  }

  if (highSchool) {
    return { school: highSchool, schoolType: "High School" };
  }

  return { school: "", schoolType: "" };
}

function extractDraft(person: Dict) {
  const draft = objectOf(findNestedValue(person, ["draft"]));
  const year = stringOf(draft.year) || stringOf(person.draftYear);
  const team = stringOf(objectOf(draft.team).name) || stringOf(draft.teamName);
  const round = stringOf(draft.pickRound) || stringOf(draft.round);
  const pick = stringOf(draft.pickNumber) || stringOf(draft.overallPick);

  if (year && team && round && pick) {
    return `${year}, ${team}, Round: ${round}, Overall Pick: ${pick}`;
  }

  return "";
}

function findNestedValue(value: unknown, keys: string[], depth = 0): unknown {
  if (depth > 4 || !value || typeof value !== "object") {
    return undefined;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findNestedValue(item, keys, depth + 1);
      if (found) {
        return found;
      }
    }
    return undefined;
  }

  const dict = value as Dict;
  for (const key of keys) {
    if (typeof dict[key] === "string" && dict[key]) {
      return dict[key];
    }
    if (dict[key] && typeof dict[key] === "object") {
      return dict[key];
    }
  }

  for (const item of Object.values(dict)) {
    const found = findNestedValue(item, keys, depth + 1);
    if (found) {
      return found;
    }
  }

  return undefined;
}

function uniqueTeams(games: Game[]) {
  const teams = new Map<number, TeamSummary>();
  for (const game of games) {
    teams.set(game.away.id, game.away);
    teams.set(game.home.id, game.home);
  }
  return Array.from(teams.values()).sort((a, b) => a.name.localeCompare(b.name));
}

function isComplexLeagueGame(game: Game) {
  const text = `${game.away.name} ${game.home.name} ${game.away.abbreviation} ${game.home.abbreviation}`;
  return /\b(DSL|ACL|FCL)\b/i.test(text) || game.level === "Rookie";
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;

  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(items[index]);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );

  return results;
}

function emptyFallback(card: Partial<PlayerCard>, player: Player) {
  return {
    draft: card.draft || player.draft,
    school: card.school || player.school,
    schoolType: card.schoolType || player.schoolType,
    birthCity: card.birthCity || player.birthCity,
    birthState: card.birthState || player.birthState,
    birthCountry: card.birthCountry || player.birthCountry,
  };
}

function hasUsefulBio(card: Partial<PlayerCard>) {
  return Boolean(
    card.draft ||
      card.school ||
      card.schoolType ||
      card.birthCity ||
      card.birthState ||
      card.birthCountry,
  );
}

function hasBackgroundBio(card: Partial<PlayerCard>, player: Player) {
  return Boolean(
    card.draft ||
      card.school ||
      card.schoolType ||
      player.draft ||
      player.school ||
      player.schoolType,
  );
}

function summarizePlayers(players: Player[]): CacheInfo {
  return players.reduce<CacheInfo>(
    (summary, player) => {
      if (player.bioStatus === "fresh") {
        summary.freshBio += 1;
      } else if (player.bioStatus === "stale") {
        summary.staleBio += 1;
      } else {
        summary.missingBio += 1;
      }
      summary.totalPlayers += 1;
      return summary;
    },
    { totalPlayers: 0, freshBio: 0, staleBio: 0, missingBio: 0 },
  );
}

function shouldRefreshBio(cacheInfo: CacheInfo) {
  return cacheInfo.missingBio + cacheInfo.staleBio > 0;
}

function normalizeDate(value: string | null) {
  if (value && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return value;
  }
  return new Date().toISOString().slice(0, 10);
}

function objectOf(value: unknown): Dict {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : {};
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringOf(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}
