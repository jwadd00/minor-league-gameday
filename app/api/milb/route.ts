import { env } from "cloudflare:workers";

export const dynamic = "force-dynamic";

const API_BASE = "https://statsapi.mlb.com/api/v1";
const MINOR_SPORT_IDS = "11,12,13,14,16";
const CARD_TIMEOUT_MS = 20_000;
const PEOPLE_BATCH_SIZE = 200;
const PEOPLE_FETCH_CONCURRENCY = 2;
const META_READ_BATCH_SIZE = 100;
const CARD_FETCH_ATTEMPTS = 4;
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
  awayScore: number | null;
  homeScore: number | null;
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

type GameStats = {
  batting?: {
    summary: string;
    atBats: number;
    hits: number;
    runs: number;
    rbi: number;
    homeRuns: number;
    baseOnBalls: number;
    strikeOuts: number;
  };
  pitching?: {
    summary: string;
    inningsPitched: string;
    hits: number;
    runs: number;
    earnedRuns: number;
    baseOnBalls: number;
    strikeOuts: number;
  };
};

type ActionPlayer = Player & {
  gamePk: number;
  opponent: string;
  stats: GameStats;
};

type PlayerCard = Pick<
  Player,
  "draft" | "school" | "schoolType" | "birthCity" | "birthState" | "birthCountry"
>;

type FetchedPlayerCard = Partial<PlayerCard> & {
  checked: boolean;
};

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

type SnapshotState = {
  date: string;
  generation: string;
  teamCount: number;
  playerCount: number;
  missingDraft: number;
  missingSchool: number;
  builtAt: number;
};

type DailySnapshot = {
  state: SnapshotState;
  players: Player[];
};

const cardCache = new Map<number, Promise<FetchedPlayerCard>>();
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

    if (view === "game") {
      const gamePk = Number(url.searchParams.get("gamePk"));
      if (!Number.isFinite(gamePk)) {
        return Response.json({ error: "gamePk is required." }, { status: 400 });
      }

      const detail = await getSnapshotGameDetail(date, gamePk, cache);
      return detail
        ? snapshotJson(detail)
        : snapshotUnavailable(date);
    }

    if (view === "players") {
      const snapshot = await readDailySnapshot(date, cache);
      if (!snapshot) {
        return snapshotUnavailable(date);
      }

      return snapshotJson({
        players: snapshot.players,
        teamCount: snapshot.state.teamCount,
        cacheInfo: summarizePlayers(snapshot.players),
        snapshot: snapshot.state,
      });
    }

    if (view === "action") {
      const snapshot = await readDailySnapshot(date, cache);
      if (!snapshot) {
        return snapshotUnavailable(date);
      }

      const players = await getActionPlayers(date, snapshot, cache);
      return snapshotJson({
        players,
        gameCount: new Set(players.map((player) => player.gamePk)).size,
        snapshot: snapshot.state,
      });
    }

    return Response.json({ error: "Unknown view." }, { status: 400 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const url = new URL(request.url);
    if (url.searchParams.get("view") !== "materialize") {
      return Response.json({ error: "Unknown view." }, { status: 400 });
    }

    const configuredToken = (env as unknown as { CACHE_WARM_TOKEN?: string })
      .CACHE_WARM_TOKEN;
    const suppliedToken = request.headers.get("x-gameday-cache-token");
    if (!configuredToken || suppliedToken !== configuredToken) {
      return Response.json({ error: "Unauthorized." }, { status: 401 });
    }

    return Response.json(
      await materializeDailySnapshot(normalizeDate(url.searchParams.get("date"))),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected error.";
    return Response.json({ error: message }, { status: 500 });
  }
}

export async function materializeDailySnapshot(date: string) {
  const cache = await getCacheStore();
  if (!cache.db) {
    throw new Error("Daily snapshots require the configured database.");
  }

  const games = await getGames(date, cache, true);
  const teams = uniqueTeams(games);
  const generation = `${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
  const builtAt = Date.now();
  const baseSnapshots = await mapLimit(teams, 8, async (team) => ({
    team,
    players: await getBaseRoster(team, date, cache, true),
  }));
  const teamSnapshots = baseSnapshots.map((entry) => ({
    team: entry.team,
    players: entry.players.map((player) =>
      withExplicitMissingValues({ ...player, bioStatus: "fresh" }),
    ),
  }));

  const players = teamSnapshots.flatMap((entry) => entry.players);
  const unresolvedPlayers = players.filter(
    (player) => player.bioStatus !== "fresh",
  );
  if (teams.length === 0 || players.length === 0) {
    throw new Error("Snapshot validation failed because the schedule or rosters were empty.");
  }
  if (unresolvedPlayers.length > 0) {
    throw new Error(
      `Snapshot validation failed because ${unresolvedPlayers.length} player records were not verified.`,
    );
  }
  const missingDraft = players.filter((player) => isNotListed(player.draft)).length;
  const missingSchool = players.filter((player) => isNotListed(player.school)).length;

  const writes = teamSnapshots.map((entry) =>
    cache.db!.prepare(
      "INSERT INTO daily_team_snapshot (date, generation, team_id, team_name, payload, fetched_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(
      date,
      generation,
      entry.team.id,
      entry.team.shortName || entry.team.name,
      JSON.stringify(entry.players),
      builtAt,
    ),
  );

  for (const batch of chunkArray(writes, 50)) {
    await cache.db.batch(batch);
  }

  await cache.db.batch([
    cache.db.prepare(
      "INSERT INTO daily_snapshot_state (date, generation, team_count, player_count, missing_draft, missing_school, built_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(date) DO UPDATE SET generation = excluded.generation, team_count = excluded.team_count, player_count = excluded.player_count, missing_draft = excluded.missing_draft, missing_school = excluded.missing_school, built_at = excluded.built_at",
    ).bind(
      date,
      generation,
      teams.length,
      players.length,
      missingDraft,
      missingSchool,
      builtAt,
    ),
    cache.db.prepare(
      "DELETE FROM daily_team_snapshot WHERE date = ? AND generation <> ?",
    ).bind(date, generation),
    cache.db.prepare(
      "DELETE FROM daily_team_snapshot WHERE date < date(?, '-3 days')",
    ).bind(date),
    cache.db.prepare(
      "DELETE FROM daily_snapshot_state WHERE date < date(?, '-3 days')",
    ).bind(date),
  ]);

  return {
    date,
    generation,
    teamCount: teams.length,
    playerCount: players.length,
    missingDraft,
    missingSchool,
    builtAt,
  };
}

async function readDailySnapshot(
  date: string,
  cache: CacheStore,
): Promise<DailySnapshot | null> {
  if (!cache.db) {
    return null;
  }

  const stateRow = await cache.db.prepare(
    "SELECT date, generation, team_count, player_count, missing_draft, missing_school, built_at FROM daily_snapshot_state WHERE date = ?",
  ).bind(date).first<{
    date: string;
    generation: string;
    team_count: number;
    player_count: number;
    missing_draft: number;
    missing_school: number;
    built_at: number;
  }>();

  if (!stateRow) {
    return null;
  }

  const rows = await cache.db.prepare(
    "SELECT payload FROM daily_team_snapshot WHERE date = ? AND generation = ? ORDER BY team_name",
  ).bind(date, stateRow.generation).all<{ payload: string }>();
  const players = (rows.results ?? [])
    .flatMap((row) => JSON.parse(row.payload) as Player[])
    .sort((a, b) => a.name.localeCompare(b.name));

  if (players.length !== stateRow.player_count) {
    return null;
  }

  return {
    state: {
      date: stateRow.date,
      generation: stateRow.generation,
      teamCount: stateRow.team_count,
      playerCount: stateRow.player_count,
      missingDraft: stateRow.missing_draft,
      missingSchool: stateRow.missing_school,
      builtAt: stateRow.built_at,
    },
    players,
  };
}

async function getSnapshotGameDetail(
  date: string,
  gamePk: number,
  cache: CacheStore,
) {
  const [games, snapshot] = await Promise.all([
    getGames(date, cache),
    readDailySnapshot(date, cache),
  ]);
  const game = games.find((entry) => entry.gamePk === gamePk);
  if (!game) {
    throw new Error("Game was not found for that date.");
  }
  if (!snapshot) {
    return null;
  }

  const teams = [game.away, game.home].map((team) => {
    const players = snapshot.players.filter((player) => player.teamId === team.id);
    return { team, players, cacheInfo: summarizePlayers(players) };
  });
  return {
    game,
    teams,
    cacheInfo: summarizePlayers(teams.flatMap((entry) => entry.players)),
    snapshot: snapshot.state,
  };
}

function snapshotUnavailable(date: string) {
  return Response.json(
    {
      error: `The complete player snapshot for ${date} is not ready yet.`,
      code: "SNAPSHOT_NOT_READY",
    },
    { status: 503, headers: { "retry-after": "60" } },
  );
}

function snapshotJson(payload: unknown) {
  return Response.json(payload, {
    headers: {
      "cache-control": "public, max-age=60, s-maxage=300, stale-while-revalidate=600",
    },
  });
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

async function getGames(
  date: string,
  cache: CacheStore,
  forceRefresh = false,
): Promise<Game[]> {
  const cached = await readScheduleCache(date, cache);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
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

async function getActionPlayers(
  date: string,
  snapshot: DailySnapshot,
  cache: CacheStore,
): Promise<ActionPlayer[]> {
  const games = (await getGames(date, cache)).filter(
    (game) => !/scheduled|preview|postponed|cancelled/i.test(game.status),
  );
  const snapshotByPlayer = new Map<string, Player>();
  for (const player of snapshot.players) {
    snapshotByPlayer.set(`${player.teamId}:${player.id}`, player);
    snapshotByPlayer.set(`player:${player.id}`, player);
  }

  const gamePlayers = await mapLimit(games, 8, async (game) => {
    const boxscore = await statsApi(`/game/${game.gamePk}/boxscore`);
    const teams = objectOf(boxscore.teams);

    return ([
      { side: "away", opponent: game.home.shortName || game.home.name },
      { side: "home", opponent: game.away.shortName || game.away.name },
    ] as const).flatMap(({ side, opponent }) => {
      const boxTeam = objectOf(teams[side]);
      const team = side === "away" ? game.away : game.home;

      return Object.values(objectOf(boxTeam.players))
        .map((entry) => normalizeActionPlayer(
          objectOf(entry),
          team,
          opponent,
          game.gamePk,
          snapshotByPlayer,
        ))
        .filter((player): player is ActionPlayer => Boolean(player));
    });
  });

  return gamePlayers
    .flat()
    .sort((a, b) => a.name.localeCompare(b.name) || a.gamePk - b.gamePk);
}

function normalizeActionPlayer(
  entry: Dict,
  team: TeamSummary,
  opponent: string,
  gamePk: number,
  snapshotByPlayer: Map<string, Player>,
): ActionPlayer | null {
  const person = objectOf(entry.person);
  const id = numberOf(person.id);
  const name = stringOf(person.fullName);
  const stats = normalizeGameStats(objectOf(entry.stats));

  if (!id || !name || (!stats.batting && !stats.pitching)) {
    return null;
  }

  const snapshotPlayer =
    snapshotByPlayer.get(`${team.id}:${id}`) ??
    snapshotByPlayer.get(`player:${id}`);
  const fallback: Player = {
    id,
    name,
    teamId: team.id,
    teamName: team.shortName || team.name,
    position: stringOf(objectOf(entry.position).abbreviation),
    number: stringOf(entry.jerseyNumber),
    status: stringOf(objectOf(entry.status).description),
    draft: "Not listed by MiLB",
    school: "Not listed by MiLB",
    schoolType: "Not listed",
    birthCity: "Not listed",
    birthState: "",
    birthCountry: "Not listed",
    milbUrl: `https://www.milb.com/player/${id}`,
  };

  return {
    ...fallback,
    ...snapshotPlayer,
    teamId: team.id,
    teamName: team.shortName || team.name,
    position:
      stringOf(objectOf(entry.position).abbreviation) || snapshotPlayer?.position || "",
    number: stringOf(entry.jerseyNumber) || snapshotPlayer?.number || "",
    gamePk,
    opponent,
    stats,
  };
}

function normalizeGameStats(value: Dict): GameStats {
  const batting = objectOf(value.batting);
  const pitching = objectOf(value.pitching);
  const battingPlayed = statNumber(batting.gamesPlayed) > 0;
  const pitchingPlayed =
    statNumber(pitching.gamesPitched) > 0 || statNumber(pitching.outs) > 0;

  return {
    batting: battingPlayed
      ? {
          summary: stringOf(batting.summary),
          atBats: statNumber(batting.atBats),
          hits: statNumber(batting.hits),
          runs: statNumber(batting.runs),
          rbi: statNumber(batting.rbi),
          homeRuns: statNumber(batting.homeRuns),
          baseOnBalls: statNumber(batting.baseOnBalls),
          strikeOuts: statNumber(batting.strikeOuts),
        }
      : undefined,
    pitching: pitchingPlayed
      ? {
          summary: stringOf(pitching.summary),
          inningsPitched: stringOf(pitching.inningsPitched),
          hits: statNumber(pitching.hits),
          runs: statNumber(pitching.runs),
          earnedRuns: statNumber(pitching.earnedRuns),
          baseOnBalls: statNumber(pitching.baseOnBalls),
          strikeOuts: statNumber(pitching.strikeOuts),
        }
      : undefined,
  };
}

function statNumber(value: unknown) {
  const result = numberOf(value);
  return Number.isFinite(result) ? result : 0;
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
      `/teams/${team.id}/roster?rosterType=fullRoster&season=${season}&date=${date}&hydrate=person(draft,education)`,
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
      : isFailedMeta(meta) || isUnverifiedBackgroundMeta(meta)
        ? "stale"
        : meta.expiresAt > now
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

async function enrichPlayers(
  players: Player[],
  cache: CacheStore,
  errors: string[] = [],
) {
  const now = Date.now();
  const metas = await readPlayerMetas(players.map((player) => player.id), cache);
  const stalePlayers = players.filter((player) => {
    const meta = metas.get(player.id);
    return (
      !meta ||
      meta.expiresAt <= now ||
      isFailedMeta(meta) ||
      isUnverifiedBackgroundMeta(meta)
    );
  });

  const batches = chunkArray(stalePlayers, PEOPLE_BATCH_SIZE);
  const refreshed = await mapLimit(
    batches,
    PEOPLE_FETCH_CONCURRENCY,
    async (batch) => {
      const cards = await fetchPlayerCardBatch(
        batch.map((player) => player.id),
        errors,
      );
      let usefulCards = 0;

      const rows = batch.map((player) => {
        const current = metas.get(player.id);
        const card = cards.get(player.id) ?? { checked: false };
        const merged = emptyFallback(card, player);
        const hasDraftOrSchool = hasBackgroundBio(merged, player);
        const checked = card.checked;

        if (hasDraftOrSchool) {
          usefulCards += 1;
        }

        return {
          playerId: player.id,
          ...merged,
          fetchedAt: now,
          expiresAt: now + (checked ? PLAYER_META_TTL_MS : FAILED_CARD_TTL_MS),
          failCount: checked
            ? hasDraftOrSchool
              ? 0
              : -1
            : Math.max(0, current?.failCount ?? 0) + 1,
        };
      });

      await writePlayerMetas(rows, cache);

      return usefulCards;
    },
  );

  return refreshed.reduce((sum, item) => sum + item, 0);
}

async function getOfficialPlayerCard(playerId: number): Promise<FetchedPlayerCard> {
  const cached = cardCache.get(playerId);
  if (cached) {
    return cached;
  }

  const promise = fetchPlayerCardBatch([playerId]).then(
    (cards) => cards.get(playerId) ?? { checked: false },
  );
  cardCache.set(playerId, promise);
  return promise;
}

async function fetchPlayerCardBatch(playerIds: number[], errors: string[] = []) {
  const uniqueIds = Array.from(new Set(playerIds)).filter(Number.isFinite);

  if (uniqueIds.length === 0) {
    return new Map<number, FetchedPlayerCard>();
  }

  const results = new Map<number, FetchedPlayerCard>();
  let pendingIds = uniqueIds;

  for (let attempt = 1; attempt <= CARD_FETCH_ATTEMPTS; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CARD_TIMEOUT_MS);

    try {
      const payload = await statsApi(
        `/people?personIds=${pendingIds.join(",")}&hydrate=draft,education`,
        controller.signal,
      );
      for (const person of arrayOf(payload.people)) {
        try {
          const normalized = normalizePersonCard(objectOf(person));
          if (normalized) {
            results.set(normalized.playerId, normalized.card);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unknown error";
          if (errors.length < 10) {
            errors.push(`Player normalization failed: ${message}`);
          }
        }
      }
      pendingIds = pendingIds.filter((playerId) => !results.has(playerId));
      if (pendingIds.length === 0) {
        return results;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (errors.length < 10) {
        errors.push(message);
      }
      console.error(
        JSON.stringify({
          event: "player_card_batch_failed",
          attempt,
          pendingPlayers: pendingIds.length,
          message,
        }),
      );
    } finally {
      clearTimeout(timeout);
    }

    if (attempt < CARD_FETCH_ATTEMPTS) {
      await delay(attempt * 500);
    }
  }

  return results;
}

async function statsApi(path: string, signal?: AbortSignal): Promise<Dict> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: { accept: "application/json" },
    cache: "no-store",
    signal,
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
    db.prepare(
      "CREATE TABLE IF NOT EXISTS daily_snapshot_state (date TEXT PRIMARY KEY, generation TEXT NOT NULL, team_count INTEGER NOT NULL, player_count INTEGER NOT NULL, missing_draft INTEGER NOT NULL, missing_school INTEGER NOT NULL, built_at INTEGER NOT NULL)",
    ),
    db.prepare(
      "CREATE TABLE IF NOT EXISTS daily_team_snapshot (date TEXT NOT NULL, generation TEXT NOT NULL, team_id INTEGER NOT NULL, team_name TEXT NOT NULL, payload TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (date, generation, team_id))",
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_schedule_cache_expires_at ON schedule_cache (expires_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_roster_cache_expires_at ON roster_cache (expires_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_player_meta_cache_expires_at ON player_meta_cache (expires_at)"),
    db.prepare("CREATE INDEX IF NOT EXISTS idx_daily_team_snapshot_lookup ON daily_team_snapshot (date, generation, team_id)"),
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

  type PlayerMetaResult = {
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
  };

  const results = await mapLimit(
    chunkArray(ids, META_READ_BATCH_SIZE),
    8,
    async (batch) => {
      const placeholders = batch.map(() => "?").join(",");
      return cache.db!
        .prepare(
          `SELECT player_id, draft, school, school_type, birth_city, birth_state, birth_country, fetched_at, expires_at, fail_count FROM player_meta_cache WHERE player_id IN (${placeholders})`,
        )
        .bind(...batch)
        .all<PlayerMetaResult>();
    },
  );

  for (const row of results.flatMap((result) => result.results ?? [])) {
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
  await writePlayerMetas([row], cache);
}

async function writePlayerMetas(rows: PlayerMetaRow[], cache: CacheStore) {
  if (!cache.db) {
    for (const row of rows) {
      memoryPlayers.set(row.playerId, row);
    }
    return;
  }

  const statements = rows.map((row) => cache.db!.prepare(
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
    ));

  for (const batch of chunkArray(statements, 50)) {
    await cache.db.batch(batch);
  }
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
    awayScore: numberOf(objectOf(teams.away).score) ?? null,
    homeScore: numberOf(objectOf(teams.home).score) ?? null,
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

function normalizePersonCard(
  person: Dict,
): { playerId: number; card: FetchedPlayerCard } | null {
  const playerId = numberOf(person.id);
  if (!playerId) {
    return null;
  }

  const draftEntry = latestDraftEntry(person);
  const education = extractEducation(person);
  const draftSchool = formatSchool(objectOf(draftEntry.school));
  const draft = formatDraft(draftEntry, person);
  const school = draftSchool || education.school;

  return {
    playerId,
    card: {
      checked: true,
      draft,
      school,
      schoolType: draftSchool
        ? schoolTypeFromDraftSchool(objectOf(draftEntry.school))
        : education.schoolType,
      birthCity: stringOf(person.birthCity),
      birthState: stringOf(person.birthStateProvince),
      birthCountry: stringOf(person.birthCountry),
    },
  };
}

function latestDraftEntry(person: Dict) {
  return arrayOrSingle(person.drafts)
    .map(objectOf)
    .filter((draft) => draft.isDrafted !== false && draft.isPass !== true)
    .sort((a, b) => stringOf(b.year).localeCompare(stringOf(a.year)))[0] ?? {};
}

function formatDraft(draft: Dict, person: Dict) {
  const year = stringOf(draft.year) || stringOf(person.draftYear);
  const team = stringOf(objectOf(draft.team).name);
  const round = stringOf(draft.pickRound);
  const pick = stringOf(draft.displayPickNumber) || stringOf(draft.pickNumber);

  if (year && team && round && pick) {
    return `${year}, ${team}, Round: ${round}, Overall Pick: ${pick}`;
  }

  if (year && round && pick) {
    return `${year}, Round: ${round}, Overall Pick: ${pick}`;
  }

  return year ? `${year} Draft` : "";
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
  const education = objectOf(person.education);
  const educationCollege = formatSchool(
    arrayOrSingle(education.colleges).map(objectOf)[0],
  );
  const educationHighSchool = formatSchool(
    arrayOrSingle(education.highschools).map(objectOf)[0],
  );

  if (educationCollege) {
    return { school: educationCollege, schoolType: "College" };
  }

  if (educationHighSchool) {
    return { school: educationHighSchool, schoolType: "High School" };
  }

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

function formatSchool(value: unknown) {
  const school = objectOf(value);
  const name = stringOf(school.name);
  if (!name) {
    return "";
  }

  const city = stringOf(school.city);
  const state = stringOf(school.state);
  if (city && state) {
    return `${name}, ${city}, ${state}`;
  }

  return name;
}

function schoolTypeFromDraftSchool(school: Dict) {
  const schoolClass = stringOf(school.schoolClass);
  return /HS|HIGH/i.test(schoolClass) ? "High School" : "College";
}

function extractDraft(person: Dict) {
  const draft = latestDraftEntry(person);
  return formatDraft(draft, person);
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

function withExplicitMissingValues(player: Player): Player {
  return {
    ...player,
    draft: player.draft || "Not listed by MiLB",
    school: player.school || "Not listed by MiLB",
    schoolType: player.schoolType || "Not listed",
    birthCity: player.birthCity || "Not listed",
    birthState: player.birthState || "",
    birthCountry: player.birthCountry || "Not listed",
  };
}

function isNotListed(value: string) {
  return !value || value === "Not listed by MiLB" || value === "Not listed";
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

function isFailedMeta(meta: PlayerMetaRow) {
  return meta.failCount > 0;
}

function isUnverifiedBackgroundMeta(meta: PlayerMetaRow) {
  return meta.failCount === 0 && !hasCachedBackgroundBio(meta);
}

function hasCachedBackgroundBio(card: Partial<PlayerCard>) {
  return Boolean(card.draft || card.school || card.schoolType);
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

function chunkArray<T>(items: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }
  return chunks;
}

function delay(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function objectOf(value: unknown): Dict {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Dict)
    : {};
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function arrayOrSingle(value: unknown): unknown[] {
  if (Array.isArray(value)) {
    return value;
  }

  if (value && typeof value === "object") {
    return [value];
  }

  return [];
}

function stringOf(value: unknown): string {
  return typeof value === "string" || typeof value === "number"
    ? String(value)
    : "";
}

function numberOf(value: unknown): number {
  return typeof value === "number" ? value : Number(value);
}
