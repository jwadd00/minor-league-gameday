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

  assert.match(css, /--gold:\s*#dfc078/);
  assert.match(css, /--blue:\s*#4de8ff/);
  assert.match(css, /repeating-linear-gradient/);
  assert.match(css, /\.game::after/);
  assert.match(css, /content:\s*"View roster"/);
  assert.match(css, /\.game-teams::before/);
  assert.match(page, /<GamedayApp \/>/);
  assert.match(layout, /title:\s*"Minor League Gameday Scout"/);
  assert.doesNotMatch(layout, /codex-preview|_sites-preview|Starter Project/);

  await assert.rejects(access(new URL("app/_sites-preview", templateRoot)));
});
