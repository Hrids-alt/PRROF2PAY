import type { Pool } from "pg";
import type { BrowserRunner } from "./browser";
import { playwrightRunnerIfAvailable } from "./browser";
import { getPool } from "./db";
import { makeGithubClient, type GithubClient } from "./github";
import { judgeFromEnv, type Judge } from "./judge";
import { paypalFromEnv, type PaypalClient } from "./paypal";
import { assertSafeUrl, safeFetch, type SafeFetchResult } from "./ssrf";

export interface Deps {
  pool: Pool;
  paypal: PaypalClient;
  judge: Judge;
  github: GithubClient;
  fetcher: (url: string) => Promise<SafeFetchResult>;
  browser: BrowserRunner | null;
  /** Rejects URLs that are not HTTPS or not public. Throws UnsafeUrlError. */
  checkUrl: (url: string) => Promise<unknown>;
  /** Public base URL of this app, used for PayPal return links. */
  appUrl: string;
}

let cached: Deps | undefined;

export async function getDeps(): Promise<Deps> {
  if (cached) return cached;
  const appUrl = (process.env.APP_URL || "http://localhost:3000").replace(/\/$/, "");
  cached = {
    pool: getPool(),
    paypal: paypalFromEnv(),
    judge: judgeFromEnv(),
    github: makeGithubClient({ token: process.env.GITHUB_TOKEN }),
    fetcher: (url) => safeFetch(url, { headers: { "User-Agent": "proof2pay-verifier" } }),
    checkUrl: (url) => assertSafeUrl(url),
    browser: process.env.ENABLE_BROWSER_CHECKS === "true" ? await playwrightRunnerIfAvailable() : null,
    appUrl,
  };
  return cached;
}
