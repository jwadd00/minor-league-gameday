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

test("keeps game cards aligned to the modern horizontal spec", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");

  assert.match(css, /\.game-list\s*{[^}]*grid-template-columns:\s*1fr;/s);
  assert.match(
    css,
    /\.game\s*{[^}]*grid-template-columns:\s*minmax\(112px,\s*0\.72fr\)\s*minmax\(320px,\s*2\.1fr\)\s*minmax\(210px,\s*1fr\)\s*132px;/s,
  );
  assert.match(css, /\.game::after\s*{[^}]*grid-column:\s*4;/s);
  assert.match(css, /\.game-teams\s*{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*46px\s*minmax\(0,\s*1fr\);/s);
  assert.match(css, /\.game-teams \.team-name\s*{[^}]*flex-direction:\s*column;/s);
  assert.match(css, /\.game-teams \.versus\s*{[^}]*justify-self:\s*center;/s);
  assert.match(css, /\.game > span:not\(\.level\)\s*{[^}]*grid-column:\s*3;/s);
  assert.match(css, /\.game small\s*{[^}]*grid-column:\s*1;/s);
});

test("collapses player tables into three concise mobile columns", async () => {
  const [client, css] = await Promise.all([
    readFile(new URL("../app/GamedayApp.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);

  assert.match(client, /className="mobile-player-team"/);
  assert.match(client, /className="mobile-player-meta"/);
  assert.match(client, /compactDraft\(player\.draft/);
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
