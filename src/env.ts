import type { Person } from "./db/schema";

export interface Env {
  DB: D1Database;
  /** Optional: without R2, pictures are shown from the store's own image link instead of a stored copy. */
  IMAGES?: R2Bucket;
  RL_PUBLIC?: RateLimit;
  RL_CLAIM?: RateLimit;
  RL_WRITE?: RateLimit;

  ENVIRONMENT: string;
  /** Hostname of the main site, e.g. gifts.example.com (no scheme, no port). */
  MAIN_HOST: string;
  /** IANA zone used for event dates, e.g. America/New_York. */
  TIMEZONE: string;
  /** e.g. myteam.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** Access application audience tag. */
  ACCESS_AUD?: string;
  /** Becomes an admin on first login while no admin exists. */
  BOOTSTRAP_ADMIN_EMAIL?: string;
  /** Local development only: acts as the logged-in email. Ignored when ACCESS_AUD is set. */
  DEV_AUTH_EMAIL?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  /** Public base URL for R2 images; falls back to serving through the Worker. */
  IMAGE_BASE_URL?: string;
}

export interface Viewer {
  email: string;
  person: Person;
  isAdmin: boolean;
  /** People whose lists this viewer manages (parents → kids). */
  managedIds: Set<string>;
}

export type Site = { kind: "main" } | { kind: "person"; person: Person };

export type AppEnv = {
  Bindings: Env;
  Variables: {
    site: Site;
    viewer: Viewer;
    /** Set on public pages when a valid login cookie is present. */
    optionalViewer: Viewer | null;
  };
};
