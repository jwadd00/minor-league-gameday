/// <reference types="@cloudflare/workers-types" />

interface Env {
  DB: D1Database;
  CACHE_WARM_TOKEN?: string;
  TARGET_URL: string;
}

declare module "cloudflare:workers" {
  export const env: {
    DB: D1Database;
    CACHE_WARM_TOKEN?: string;
    TARGET_URL: string;
  };
}
