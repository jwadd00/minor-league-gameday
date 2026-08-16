import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

const templateRoot = new URL("../", import.meta.url);

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Gameday Scout shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Minor League Gameday Scout<\/title>/i);
  assert.match(html, /GAMEDAY SCOUT/);
  assert.match(html, /Today&#x27;s Games/);
  assert.match(html, /Live minor league roster finder/i);
  assert.match(html, /Team search/i);
  assert.match(html, /Full-season/);
  assert.match(html, /Players/);
  assert.match(html, /Yesterday&#x27;s Action/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|Building your site/i);
});

test("keeps the product styling and removes starter preview assets", async () => {
  const [css, page, layout] = await Promise.all([
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
  ]);

  assert.match(css, /--bg:\s*#121212/);
  assert.match(css, /--blue:\s*#4de8ff/);
  assert.match(css, /--green:\s*#24f5c1/);
  assert.match(css, /url\("\/old-ballpark-bg\.png"\)/);
  assert.match(css, /font-family:\s*"Brush Script MT"/);
  assert.match(css, /backdrop-filter:\s*blur/);
  assert.match(css, /\.game::after/);
  assert.match(css, /content:\s*"View roster"/);
  assert.match(css, /\.game-teams::before/);
  assert.match(page, /<GamedayApp \/>/);
  assert.match(layout, /title:\s*"Minor League Gameday Scout"/);
  assert.doesNotMatch(layout, /codex-preview|_sites-preview|Starter Project/);

  await assert.rejects(access(new URL("app/_sites-preview", templateRoot)));
});

test("condenses games into a responsive schedule board", async () => {
  const [client, css] = await Promise.all([
    readFile(new URL("../app/GamedayApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(client, /className="game-list-head"/);
  assert.match(client, /<span>Away team<\/span>/);
  assert.match(client, /className="game-away"/);
  assert.match(client, /className="game-home"/);
  assert.match(client, /className="game-schedule"/);
  assert.match(client, /game\.status === "Final"/);
  assert.match(client, /game\.awayScore\}-\{game\.homeScore/);
  assert.match(client, /className="game-action">View roster/);
  assert.match(
    css,
    /\.game-list-head,[\s\S]*?\.game\s*{[\s\S]*?grid-template-columns:\s*82px\s*minmax\(130px,\s*1fr\)\s*44px\s*minmax\(130px,\s*1fr\)\s*minmax\(180px,\s*1\.25fr\)\s*96px\s*92px;/,
  );
  assert.match(css, /\.game\s*{[\s\S]*?min-height:\s*50px;/);
  assert.match(css, /\.game > span\.game-away,[\s\S]*?grid-column:\s*auto;/);
  assert.match(css, /\.game > span\.game-schedule\s*{\s*grid-column:\s*2 \/ span 2;/);
  assert.match(css, /\.game-status strong/);
});

test("collapses player tables into three concise mobile columns", async () => {
  const [client, css] = await Promise.all([
    readFile(new URL("../app/GamedayApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(client, /className="mobile-player-team"/);
  assert.match(client, /className="mobile-player-meta"/);
  assert.match(client, /compactDraft\(player\.draft/);
  assert.match(client, /label: "Pos \/ No\."/);
  assert.match(client, /label: "Birthplace"/);
  assert.match(client, /<span>#\{player\.number\}<\/span>/);
  assert.match(client, /<span>\{player\.birthState \|\| player\.birthCountry \|\| "-"\}<\/span>/);
  assert.match(css, /min-width:\s*760px/);
  assert.match(css, /@media \(max-width: 620px\)/);
  assert.match(css, /\.col-teamName,[\s\S]*?\.col-state\s*{\s*display:\s*none;/);
  assert.match(css, /\.col-name\s*{\s*width:\s*39%;/);
  assert.match(css, /\.col-draft\s*{\s*width:\s*25%;/);
  assert.match(css, /\.col-school\s*{\s*width:\s*36%;/);
});

test("preloads players from a scheduled daily snapshot without client warming", async () => {
  const [client, route, worker, vite, scheduler, schedulerConfig] = await Promise.all([
    readFile(new URL("../app/GamedayApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/milb/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../vite.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../scheduler/src/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../scheduler/wrangler.jsonc", import.meta.url), "utf8"),
  ]);

  assert.match(client, /getJson<PlayerIndex>\(`\/api\/milb\?view=players&date=\$\{date\}`\)/);
  assert.doesNotMatch(client, /view=warm|view=enrichGame|Warming draft|queued for draft/);
  assert.match(route, /readDailySnapshot\(date, cache\)/);
  assert.match(route, /daily_snapshot_state/);
  assert.match(route, /daily_team_snapshot/);
  assert.match(route, /withExplicitMissingValues/);
  assert.match(route, /hydrate=person\(draft,education\)/);
  assert.doesNotMatch(route, /await enrichPlayers\(uniquePlayers/);
  assert.match(route, /Snapshot validation failed because \$\{unresolvedPlayers\.length\} player records were not verified/);
  assert.match(route, /const PEOPLE_BATCH_SIZE = 200/);
  assert.match(route, /const PEOPLE_FETCH_CONCURRENCY = 2/);
  assert.match(route, /pendingIds = pendingIds\.filter/);
  assert.match(route, /function formatSchool\(value: unknown\)/);
  assert.match(route, /Player normalization failed/);
  assert.doesNotMatch(route, /if \(view === "warm"\)/);
  assert.match(worker, /async scheduled\(/);
  assert.match(vite, /crons:\s*\["0 10,14,18,22 \* \* \*"\]/);
  assert.match(scheduler, /SITES_BYPASS_TOKEN/);
  assert.match(scheduler, /OAI-Sites-Authorization/);
  assert.match(scheduler, /x-gameday-cache-token/);
  assert.match(schedulerConfig, /"crons":\s*\["0 10,14,18,22 \* \* \*"\]/);
});

test("loads prior-day player action with box-score stats and shared filters", async () => {
  const [client, route, css] = await Promise.all([
    readFile(new URL("../app/GamedayApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/milb/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(client, /function previousDate\(value: string\)/);
  assert.match(client, /view=action&date=\$\{actionDate\}/);
  assert.match(client, /Yesterday&?apos;?s Action|Yesterday's Action/);
  assert.match(client, /\{ key: "stats", label: "Stats" \}/);
  assert.match(client, /<PlayerFinder[\s\S]*?showStats/);
  assert.match(client, /<strong>BAT<\/strong>/);
  assert.match(client, /<strong>PITCH<\/strong>/);
  assert.match(route, /if \(view === "action"\)/);
  assert.match(route, /`\/game\/\$\{game\.gamePk\}\/boxscore`/);
  assert.match(route, /normalizeGameStats/);
  assert.match(css, /\.col-stats/);
  assert.match(css, /\.game-stat-lines/);
});
