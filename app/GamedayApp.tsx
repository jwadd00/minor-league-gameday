"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Game = {
  gamePk: number;
  gameDate: string;
  status: string;
  venue: string;
  level: string;
  away: TeamSummary;
  home: TeamSummary;
};

type TeamSummary = {
  id: number;
  name: string;
  shortName: string;
  abbreviation: string;
};

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
  bioStatus?: "fresh" | "stale" | "missing";
};

type CacheInfo = {
  totalPlayers: number;
  freshBio: number;
  staleBio: number;
  missingBio: number;
  refreshedBio?: number;
};

type GameDetail = {
  game: Game;
  teams: Array<{
    team: TeamSummary;
    players: Player[];
    cacheInfo?: CacheInfo;
  }>;
  cacheInfo?: CacheInfo;
};

type PlayerIndex = {
  players: Player[];
  teamCount: number;
  cacheInfo?: CacheInfo;
};

type ApiState<T> = {
  status: "idle" | "loading" | "ready" | "error";
  data?: T;
  error?: string;
};

type GameCategory =
  | "fullSeason"
  | "all"
  | "Triple-A"
  | "Double-A"
  | "High-A"
  | "Single-A"
  | "Rookie";

type PlayerSortKey =
  | "name"
  | "teamName"
  | "position"
  | "number"
  | "draft"
  | "school"
  | "birthCity"
  | "state";

type SortState = {
  key: PlayerSortKey;
  direction: "asc" | "desc";
};

const GAME_CATEGORIES: Array<{ value: GameCategory; label: string }> = [
  { value: "fullSeason", label: "Full-season" },
  { value: "all", label: "All" },
  { value: "Triple-A", label: "AAA" },
  { value: "Double-A", label: "AA" },
  { value: "High-A", label: "High-A" },
  { value: "Single-A", label: "Single-A" },
  { value: "Rookie", label: "Rookie" },
];

const LEVEL_ORDER = ["Triple-A", "Double-A", "High-A", "Single-A", "Rookie"];

const PLAYER_COLUMNS: Array<{ key: PlayerSortKey; label: string }> = [
  { key: "name", label: "Player" },
  { key: "teamName", label: "Team" },
  { key: "position", label: "Pos" },
  { key: "number", label: "No." },
  { key: "draft", label: "Draft Spot" },
  { key: "school", label: "College or High School" },
  { key: "birthCity", label: "Birth City" },
  { key: "state", label: "State" },
];

const todayValue = () => new Date().toISOString().slice(0, 10);

function formatGameTime(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  }).format(new Date(value));
}

function compactDraft(value: string) {
  if (value === "Not listed by MiLB") {
    return "Not listed";
  }

  const match = value.match(
    /^(\d{4}).*?Round:\s*([^,]+),\s*Overall Pick:\s*(\d+)/i,
  );
  return match ? `${match[1]} R${match[2]} / #${match[3]}` : value;
}

function compactPlayerMeta(player: Player) {
  const position = [player.position, player.number ? `#${player.number}` : ""]
    .filter(Boolean)
    .join(" ");
  const birthplace = [
    player.birthCity,
    player.birthState || player.birthCountry,
  ]
    .filter(Boolean)
    .join(", ");

  return [position, birthplace].filter(Boolean).join(" / ");
}

function labelForDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(new Date(`${value}T12:00:00`));
}

async function getJson<T>(path: string): Promise<T> {
  const response = await fetch(path);
  const payload = (await response.json()) as T & { error?: string };

  if (!response.ok) {
    throw new Error(payload.error ?? "Could not load MiLB data.");
  }

  return payload;
}

function teamLine(game: Game) {
  return `${game.away.shortName || game.away.name} at ${
    game.home.shortName || game.home.name
  }`;
}

function teamLogoUrl(teamId: number) {
  return `https://www.mlbstatic.com/team-logos/${teamId}.svg`;
}

function uniqueSorted(values: string[]) {
  return Array.from(new Set(values.filter(Boolean))).sort((a, b) =>
    a.localeCompare(b),
  );
}

function isComplexLeagueGame(game: Game) {
  const text = `${game.away.name} ${game.home.name} ${game.away.abbreviation} ${game.home.abbreviation}`;
  return /\b(DSL|ACL|FCL)\b/i.test(text) || game.level === "Rookie";
}

function gameMatchesCategory(game: Game, category: GameCategory) {
  if (category === "all") {
    return true;
  }

  if (category === "fullSeason") {
    return !isComplexLeagueGame(game);
  }

  return game.level === category;
}

function playerValue(player: Player, key: PlayerSortKey) {
  if (key === "state") {
    return player.birthState || player.birthCountry;
  }

  return player[key] ?? "";
}

function comparePlayers(a: Player, b: Player, sort: SortState) {
  if (sort.key === "number") {
    const left = Number.parseInt(a.number, 10);
    const right = Number.parseInt(b.number, 10);
    const result = (Number.isFinite(left) ? left : 999) - (Number.isFinite(right) ? right : 999);
    return sort.direction === "asc" ? result : -result;
  }

  const result = String(playerValue(a, sort.key)).localeCompare(
    String(playerValue(b, sort.key)),
    undefined,
    { numeric: true, sensitivity: "base" },
  );

  return sort.direction === "asc" ? result : -result;
}

export function GamedayApp() {
  const gamesRef = useRef<HTMLDivElement | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const playersRef = useRef<HTMLElement | null>(null);
  const [activeTab, setActiveTab] = useState<"games" | "players">("games");
  const [date, setDate] = useState(todayValue);
  const [games, setGames] = useState<ApiState<Game[]>>({ status: "idle" });
  const [selectedGamePk, setSelectedGamePk] = useState<number | null>(null);
  const [gameDetail, setGameDetail] = useState<ApiState<GameDetail>>({
    status: "idle",
  });
  const [allPlayers, setAllPlayers] = useState<ApiState<PlayerIndex>>({
    status: "idle",
  });
  const [query, setQuery] = useState("");
  const [school, setSchool] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [gameQuery, setGameQuery] = useState("");
  const [gameCategory, setGameCategory] = useState<GameCategory>("fullSeason");

  useEffect(() => {
    let cancelled = false;
    setGames({ status: "loading" });
    setSelectedGamePk(null);
    setGameDetail({ status: "idle" });
    setAllPlayers({ status: "loading" });

    getJson<{ games: Game[] }>(`/api/milb?view=games&date=${date}`)
      .then((payload) => {
        if (!cancelled) {
          setGames({ status: "ready", data: payload.games });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setGames({ status: "error", error: error.message });
        }
      });

    getJson<PlayerIndex>(`/api/milb?view=players&date=${date}`)
      .then((payload) => {
        if (!cancelled) {
          setAllPlayers({ status: "ready", data: payload });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setAllPlayers({ status: "error", error: error.message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [date]);

  useEffect(() => {
    if (!selectedGamePk) {
      return;
    }

    let cancelled = false;
    setGameDetail({ status: "loading" });

    getJson<GameDetail>(`/api/milb?view=game&date=${date}&gamePk=${selectedGamePk}`)
      .then((payload) => {
        if (!cancelled) {
          setGameDetail({ status: "ready", data: payload });
        }
      })
      .catch((error: Error) => {
        if (!cancelled) {
          setGameDetail({ status: "error", error: error.message });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [date, selectedGamePk]);

  const selectedGame =
    games.data?.find((game) => game.gamePk === selectedGamePk) ?? null;

  const playersForPage = allPlayers.data?.players ?? [];

  function scrollTo(ref: { current: Element | null }) {
    setTimeout(() => {
      ref.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 80);
  }

  function showGames() {
    setActiveTab("games");
    scrollTo(gamesRef);
  }

  function showPlayers() {
    setActiveTab("players");
    scrollTo(playersRef);
  }

  function selectGame(gamePk: number) {
    setActiveTab("games");
    setSelectedGamePk(gamePk);
    scrollTo(detailRef);
  }

  const filteredGames = useMemo(() => {
    const normalizedQuery = gameQuery.trim().toLowerCase();

    return (games.data ?? []).filter((game) => {
      const searchable = [
        teamLine(game),
        game.away.name,
        game.home.name,
        game.away.abbreviation,
        game.home.abbreviation,
        game.venue,
        game.level,
      ]
        .join(" ")
        .toLowerCase();

      return (
        gameMatchesCategory(game, gameCategory) &&
        (!normalizedQuery || searchable.includes(normalizedQuery))
      );
    });
  }, [gameCategory, gameQuery, games.data]);

  const gameGroups = useMemo(() => {
    const groups = new Map<string, Game[]>();
    for (const game of filteredGames) {
      const label = isComplexLeagueGame(game) ? "Complex/Rookie" : game.level;
      groups.set(label, [...(groups.get(label) ?? []), game]);
    }

    return Array.from(groups.entries()).sort(([a], [b]) => {
      const left = a === "Complex/Rookie" ? 99 : LEVEL_ORDER.indexOf(a);
      const right = b === "Complex/Rookie" ? 99 : LEVEL_ORDER.indexOf(b);
      return (left === -1 ? 50 : left) - (right === -1 ? 50 : right);
    });
  }, [filteredGames]);

  const categoryCounts = useMemo(() => {
    const rows = games.data ?? [];
    return new Map<GameCategory, number>(
      GAME_CATEGORIES.map((category) => [
        category.value,
        rows.filter((game) => gameMatchesCategory(game, category.value)).length,
      ]),
    );
  }, [games.data]);

  const playerRows = useMemo(() => {
    const rows = playersForPage;
    const normalizedQuery = query.trim().toLowerCase();

    return rows.filter((player) => {
      const searchable = [
        player.name,
        player.teamName,
        player.position,
        player.draft,
        player.school,
        player.birthCity,
        player.birthState,
        player.birthCountry,
      ]
        .join(" ")
        .toLowerCase();

      return (
        (!normalizedQuery || searchable.includes(normalizedQuery)) &&
        (!school || player.school === school) &&
        (!city || player.birthCity === city) &&
        (!state || player.birthState === state)
      );
    });
  }, [city, playersForPage, query, school, state]);

  const filterOptions = useMemo(() => {
    const rows = playersForPage;
    return {
      schools: uniqueSorted(rows.map((player) => player.school)),
      cities: uniqueSorted(rows.map((player) => player.birthCity)),
      states: uniqueSorted(rows.map((player) => player.birthState)),
    };
  }, [playersForPage]);

  return (
    <main className="min-h-screen bg-[#07111c] text-[#eaf7ff]">
      <section className="topbar">
        <nav className="topnav" aria-label="Site">
          <strong>GAMEDAY SCOUT</strong>
          <button
            type="button"
            className={activeTab === "games" ? "active" : ""}
            onClick={showGames}
          >
            Games
          </button>
          <button
            type="button"
            className={activeTab === "players" ? "active" : ""}
            onClick={showPlayers}
          >
            Players
          </button>
        </nav>
        <div>
          <p className="eyebrow">Live minor league roster finder</p>
          <h1>Today&apos;s Games</h1>
          <p className="lede">
            Pick a matchup and pull the roster details fans ask for: number,
            position, draft slot, school, birthplace, and current MiLB card.
          </p>
        </div>
        <div className="date-control" aria-label="Game date">
          <button
            type="button"
            aria-label="Previous day"
            onClick={() =>
              setDate((current) => {
                const next = new Date(`${current}T12:00:00`);
                next.setDate(next.getDate() - 1);
                return next.toISOString().slice(0, 10);
              })
            }
          >
            ‹
          </button>
          <label>
            <span>Date</span>
            <input
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </label>
          <button
            type="button"
            aria-label="Next day"
            onClick={() =>
              setDate((current) => {
                const next = new Date(`${current}T12:00:00`);
                next.setDate(next.getDate() + 1);
                return next.toISOString().slice(0, 10);
              })
            }
          >
            ›
          </button>
        </div>
      </section>

      <section className="workspace">
        {activeTab === "games" ? (
          <div className="games-grid" ref={gamesRef}>
            <aside className="games-panel">
              <div className="panel-heading">
                <div>
                  <p className="eyebrow">Schedule</p>
                  <h2>{labelForDate(date)}</h2>
                </div>
                <span>
                  {filteredGames.length}/{games.data?.length ?? 0} games
                </span>
              </div>

              <div className="game-tools">
                <label>
                  <span>Team search</span>
                  <input
                    value={gameQuery}
                    placeholder="Myrtle Beach, Hill City, HC..."
                    onChange={(event) => setGameQuery(event.target.value)}
                  />
                </label>
                <div className="category-row" aria-label="Game category">
                  {GAME_CATEGORIES.map((category) => (
                    <button
                      type="button"
                      key={category.value}
                      className={gameCategory === category.value ? "active" : ""}
                      onClick={() => setGameCategory(category.value)}
                    >
                      <span>{category.label}</span>
                      <small>{categoryCounts.get(category.value) ?? 0}</small>
                    </button>
                  ))}
                </div>
              </div>

              {games.status === "loading" ? (
                <LoadingBlock label="Loading today's MiLB slate" />
              ) : null}

              {games.status === "error" ? (
                <EmptyState title="Schedule unavailable" text={games.error ?? ""} />
              ) : null}

              {games.status === "ready" && games.data?.length === 0 ? (
                <EmptyState
                  title="No minor league games found"
                  text="Try another date or check back closer to first pitch."
                />
              ) : null}

              {games.status === "ready" &&
              (games.data?.length ?? 0) > 0 &&
              filteredGames.length === 0 ? (
                <EmptyState
                  title="No games match"
                  text="Try All games or clear the team search."
                />
              ) : null}

              <div className="game-list-head" aria-hidden="true">
                <span>Level</span>
                <span>Away team</span>
                <span>Matchup</span>
                <span>Home team</span>
                <span>Start / venue</span>
                <span>Status</span>
                <span>Roster</span>
              </div>
              <div className="game-list">
                {filteredGames.map((game) => (
                  <button
                    type="button"
                    key={game.gamePk}
                    className={game.gamePk === selectedGamePk ? "game active" : "game"}
                    onClick={() => selectGame(game.gamePk)}
                  >
                    <span className="level">{game.level}</span>
                    <span className="game-away">
                      <TeamName team={game.away} />
                    </span>
                    <span className="game-matchup">at</span>
                    <span className="game-home">
                      <TeamName team={game.home} />
                    </span>
                    <span className="game-schedule">
                      {formatGameTime(game.gameDate)} · {game.venue}
                    </span>
                    <span className="game-status">{game.status}</span>
                    <span className="game-action">View roster</span>
                  </button>
                ))}
              </div>
            </aside>

            <section className="detail-panel" ref={detailRef}>
              {selectedGame ? (
                <div className="detail-head">
                  <div>
                    <p className="eyebrow">Roster table</p>
                    <h2>{teamLine(selectedGame)}</h2>
                  </div>
                  <a
                    href={`https://www.milb.com/gameday/${selectedGame.gamePk}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    MiLB Gameday
                  </a>
                </div>
              ) : (
                <EmptyState
                  title="Choose a game"
                  text="Each matchup opens into a combined table for both current rosters."
                />
              )}

              {gameDetail.status === "loading" ? (
                <LoadingBlock label="Opening roster cards" />
              ) : null}

              {gameDetail.status === "error" ? (
                <EmptyState title="Roster unavailable" text={gameDetail.error ?? ""} />
              ) : null}

              {gameDetail.status === "ready" && gameDetail.data ? (
                <RosterTables detail={gameDetail.data} />
              ) : null}
            </section>
          </div>
        ) : (
          <section className="players-panel" ref={playersRef}>
            <div className="panel-heading wide">
              <div>
                <p className="eyebrow">Player finder</p>
                <h2>Players Taking The Field {labelForDate(date)}</h2>
              </div>
              <span>
                {playerRows.length}/{playersForPage.length} shown
              </span>
            </div>

            <div className="filters">
              <label className="search">
                <span>Search</span>
                <input
                  value={query}
                  placeholder="Name, team, draft, school..."
                  onChange={(event) => setQuery(event.target.value)}
                />
              </label>
              <label>
                <span>College or high school</span>
                <select
                  value={school}
                  onChange={(event) => setSchool(event.target.value)}
                >
                  <option value="">All schools</option>
                  {filterOptions.schools.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Birth city</span>
                <select value={city} onChange={(event) => setCity(event.target.value)}>
                  <option value="">All cities</option>
                  {filterOptions.cities.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                <span>Birth state</span>
                <select
                  value={state}
                  onChange={(event) => setState(event.target.value)}
                >
                  <option value="">All states</option>
                  {filterOptions.states.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            {allPlayers.status === "loading" ? (
              <div className="inline-status player-status" role="status" aria-live="polite">
                Loading the day-wide player table
              </div>
            ) : null}

            {allPlayers.status === "error" ? (
              <EmptyState
                title="Player index unavailable"
                text={allPlayers.error ?? ""}
              />
            ) : null}

            {playerRows.length > 0 ? (
              <PlayerTableEnhanced players={playerRows} />
            ) : null}
          </section>
        )}
      </section>
    </main>
  );
}

function LoadingBlock({ label }: { label: string }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span />
      {label}
    </div>
  );
}

function TeamLogo({ team }: { team: TeamSummary | { id: number; name: string } }) {
  return (
    <span className="team-logo" aria-hidden="true">
      <img
        src={teamLogoUrl(team.id)}
        alt=""
        loading="lazy"
        onError={(event) => {
          event.currentTarget.style.display = "none";
        }}
      />
      <span>{team.name.slice(0, 2).toUpperCase()}</span>
    </span>
  );
}

function TeamName({ team }: { team: TeamSummary }) {
  return (
    <span className="team-name">
      <TeamLogo team={team} />
      <span>{team.shortName || team.name}</span>
    </span>
  );
}

function PlayerTeamName({ player }: { player: Player }) {
  return (
    <span className="team-name">
      <TeamLogo team={{ id: player.teamId, name: player.teamName }} />
      <span>{player.teamName}</span>
    </span>
  );
}

function EmptyState({ title, text }: { title: string; text: string }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      <p>{text}</p>
    </div>
  );
}

function RosterTables({ detail }: { detail: GameDetail }) {
  const players = detail.teams.flatMap((entry) => entry.players);

  return (
    <div className="roster-stack">
      <div className="summary-strip">
        {detail.teams.map((entry) => (
          <span key={entry.team.id}>
            <strong>{entry.players.length}</strong> <TeamName team={entry.team} />
          </span>
        ))}
      </div>
      <PlayerTableEnhanced players={players} />
    </div>
  );
}

function PlayerTable({ players }: { players: Player[] }) {
  if (players.length === 0) {
    return (
      <EmptyState
        title="No players match"
        text="Clear a filter or try a broader search term."
      />
    );
  }

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Player</th>
            <th>Team</th>
            <th>Pos</th>
            <th>No.</th>
            <th>Draft Spot</th>
            <th>College or High School</th>
            <th>Birth City</th>
            <th>State</th>
          </tr>
        </thead>
        <tbody>
          {players.map((player) => (
            <tr key={`${player.teamId}-${player.id}`}>
              <td>
                <a href={player.milbUrl} target="_blank" rel="noreferrer">
                  {player.name}
                </a>
                <span>{player.status}</span>
              </td>
              <td>{player.teamName}</td>
              <td>{player.position || "—"}</td>
              <td>{player.number || "—"}</td>
              <td>{player.draft || "—"}</td>
              <td>
                {player.school || "—"}
                {player.schoolType ? <span>{player.schoolType}</span> : null}
              </td>
              <td>{player.birthCity || "—"}</td>
              <td>{player.birthState || player.birthCountry || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function PlayerTableEnhanced({ players }: { players: Player[] }) {
  const [tableQuery, setTableQuery] = useState("");
  const [teamFilter, setTeamFilter] = useState("");
  const [positionFilter, setPositionFilter] = useState("");
  const [schoolFilter, setSchoolFilter] = useState("");
  const [sort, setSort] = useState<SortState>({
    key: "name",
    direction: "asc",
  });

  const options = useMemo(
    () => ({
      teams: uniqueSorted(players.map((player) => player.teamName)),
      positions: uniqueSorted(players.map((player) => player.position)),
      schools: uniqueSorted(players.map((player) => player.school)),
    }),
    [players],
  );

  const rows = useMemo(() => {
    const normalizedQuery = tableQuery.trim().toLowerCase();

    return players
      .filter((player) => {
        const searchable = [
          player.name,
          player.teamName,
          player.position,
          player.number,
          player.draft,
          player.school,
          player.birthCity,
          player.birthState,
          player.birthCountry,
        ]
          .join(" ")
          .toLowerCase();

        return (
          (!normalizedQuery || searchable.includes(normalizedQuery)) &&
          (!teamFilter || player.teamName === teamFilter) &&
          (!positionFilter || player.position === positionFilter) &&
          (!schoolFilter || player.school === schoolFilter)
        );
      })
      .sort((a, b) => comparePlayers(a, b, sort));
  }, [players, positionFilter, schoolFilter, sort, tableQuery, teamFilter]);

  function toggleSort(key: PlayerSortKey) {
    setSort((current) =>
      current.key === key
        ? {
            key,
            direction: current.direction === "asc" ? "desc" : "asc",
          }
        : { key, direction: "asc" },
    );
  }

  if (players.length === 0) {
    return (
      <EmptyState
        title="No players match"
        text="Clear a filter or try a broader search term."
      />
    );
  }

  return (
    <div className="player-table-shell">
      <div className="table-tools">
        <label className="search">
          <span>Table search</span>
          <input
            value={tableQuery}
            placeholder="Player, team, city, draft..."
            onChange={(event) => setTableQuery(event.target.value)}
          />
        </label>
        <label>
          <span>Team</span>
          <select
            value={teamFilter}
            onChange={(event) => setTeamFilter(event.target.value)}
          >
            <option value="">All teams</option>
            {options.teams.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Position</span>
          <select
            value={positionFilter}
            onChange={(event) => setPositionFilter(event.target.value)}
          >
            <option value="">All positions</option>
            {options.positions.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>School</span>
          <select
            value={schoolFilter}
            onChange={(event) => setSchoolFilter(event.target.value)}
          >
            <option value="">All schools</option>
            {options.schools.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="table-meta">
        <span>
          {rows.length}/{players.length} players
        </span>
        <button
          type="button"
          onClick={() => {
            setTableQuery("");
            setTeamFilter("");
            setPositionFilter("");
            setSchoolFilter("");
          }}
        >
          Clear filters
        </button>
      </div>

      {rows.length === 0 ? (
        <EmptyState
          title="No players match"
          text="Clear a table filter or try a broader search term."
        />
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                {PLAYER_COLUMNS.map((column) => (
                  <th key={column.key} className={`col-${column.key}`}>
                    <button
                      type="button"
                      className="sort-button"
                      onClick={() => toggleSort(column.key)}
                    >
                      {column.label}
                      <span aria-hidden="true">
                        {sort.key === column.key
                          ? sort.direction === "asc"
                            ? " ↑"
                            : " ↓"
                          : ""}
                      </span>
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((player) => (
                <tr key={`${player.teamId}-${player.id}`}>
                  <td className="col-name">
                    <a href={player.milbUrl} target="_blank" rel="noreferrer">
                      {player.name}
                    </a>
                    <span className="desktop-player-status">{player.status}</span>
                    <span className="mobile-player-team">{player.teamName}</span>
                    <span className="mobile-player-meta">
                      {compactPlayerMeta(player)}
                    </span>
                  </td>
                  <td className="col-teamName">
                    <PlayerTeamName player={player} />
                  </td>
                  <td className="col-position">{player.position || "-"}</td>
                  <td className="col-number">{player.number || "-"}</td>
                  <td className="col-draft">
                    <span className="desktop-cell-value">{player.draft || "-"}</span>
                    <span className="mobile-cell-value" title={player.draft}>
                      {compactDraft(player.draft || "-")}
                    </span>
                  </td>
                  <td className="col-school">
                    {player.school || "-"}
                    {player.schoolType ? <span>{player.schoolType}</span> : null}
                  </td>
                  <td className="col-birthCity">{player.birthCity || "-"}</td>
                  <td className="col-state">
                    {player.birthState || player.birthCountry || "-"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
