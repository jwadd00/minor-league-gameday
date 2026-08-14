type SchedulerEnv = Env & {
  SITES_BYPASS_TOKEN: string;
  CACHE_WARM_TOKEN: string;
};

export default {
  async scheduled(
    _controller: ScheduledController,
    env: SchedulerEnv,
    ctx: ExecutionContext,
  ): Promise<void> {
    ctx.waitUntil(refreshDailySnapshot(env));
  },
};

async function refreshDailySnapshot(env: SchedulerEnv) {
  const date = easternDate(new Date());
  const response = await fetch(
    `${env.TARGET_URL}/api/milb?view=materialize&date=${date}`,
    {
      method: "POST",
      headers: {
        "OAI-Sites-Authorization": `Bearer ${env.SITES_BYPASS_TOKEN}`,
        "x-gameday-cache-token": env.CACHE_WARM_TOKEN,
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Snapshot refresh failed with status ${response.status}.`);
  }

  console.log(JSON.stringify({ event: "snapshot_refreshed", date }));
}

function easternDate(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(
    parts.map((part) => [part.type, part.value]),
  );

  return `${value.year}-${value.month}-${value.day}`;
}
