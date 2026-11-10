/**
 * Scripted browser checks, run from our side. Every request the page makes goes through the
 * SSRF guard, so a page cannot be used to reach private addresses. Needs the optional
 * `playwright` package and a browser; without them checks become "needs human".
 */
import { assertSafeUrl } from "./ssrf";

export type BrowserStep =
  | { action: "goto"; path: string }
  | { action: "click"; selector: string }
  | { action: "fill"; selector: string; value: string }
  | { action: "expectText"; text: string }
  | { action: "expectUrl"; contains: string };

export interface BrowserResult {
  ok: boolean;
  failedStep: number | null;
  reason: string | null;
  log: string[];
}

export interface BrowserRunner {
  run(startUrl: string, steps: BrowserStep[]): Promise<BrowserResult>;
}

/** The small part of Playwright's API that we use, so the logic can be tested without a browser. */
export interface PageLike {
  goto(url: string): Promise<unknown>;
  click(selector: string): Promise<unknown>;
  fill(selector: string, value: string): Promise<unknown>;
  textContent(selector: string): Promise<string | null>;
  url(): string;
  setDefaultTimeout(ms: number): void;
  route(pattern: string, handler: (route: RouteLike) => Promise<void> | void): Promise<unknown>;
}
export interface RouteLike {
  request(): { url(): string };
  continue(): Promise<unknown>;
  abort(): Promise<unknown>;
}
export interface BrowserLike {
  newPage(): Promise<PageLike>;
  close(): Promise<void>;
}
export type Launcher = () => Promise<BrowserLike>;

export const MAX_STEPS = 12;
const STEP_TIMEOUT_MS = 10_000;

export function parseSteps(raw: unknown): BrowserStep[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_STEPS) return null;
  const out: BrowserStep[] = [];
  for (const s of raw) {
    if (typeof s !== "object" || s === null) return null;
    const r = s as Record<string, unknown>;
    switch (r.action) {
      case "goto":
        if (typeof r.path !== "string" || !r.path.startsWith("/")) return null;
        out.push({ action: "goto", path: r.path });
        break;
      case "click":
        if (typeof r.selector !== "string" || !r.selector) return null;
        out.push({ action: "click", selector: r.selector });
        break;
      case "fill":
        if (typeof r.selector !== "string" || typeof r.value !== "string") return null;
        out.push({ action: "fill", selector: r.selector, value: r.value });
        break;
      case "expectText":
        if (typeof r.text !== "string" || !r.text) return null;
        out.push({ action: "expectText", text: r.text });
        break;
      case "expectUrl":
        if (typeof r.contains !== "string" || !r.contains) return null;
        out.push({ action: "expectUrl", contains: r.contains });
        break;
      default:
        return null;
    }
  }
  return out;
}

export function createBrowserRunner(launch: Launcher, assertUrl: typeof assertSafeUrl = assertSafeUrl): BrowserRunner {
  return {
    async run(startUrl, steps) {
      const log: string[] = [];
      let browser: BrowserLike | null = null;
      try {
        const start = (await assertUrl(startUrl)).url;
        browser = await launch();
        const page = await browser.newPage();
        page.setDefaultTimeout(STEP_TIMEOUT_MS);
        await page.route("**/*", async (route) => {
          try {
            await assertUrl(route.request().url());
            await route.continue();
          } catch {
            await route.abort();
          }
        });

        for (const [i, step] of steps.entries()) {
          try {
            if (step.action === "goto") {
              await page.goto(new URL(step.path, start).toString());
              log.push(`goto ${step.path}: ok`);
            } else if (step.action === "click") {
              await page.click(step.selector);
              log.push(`click ${step.selector}: ok`);
            } else if (step.action === "fill") {
              await page.fill(step.selector, step.value);
              log.push(`fill ${step.selector}: ok`);
            } else if (step.action === "expectText") {
              const text = (await page.textContent("body")) ?? "";
              if (!text.includes(step.text)) throw new Error(`text "${step.text}" not found`);
              log.push(`expectText "${step.text}": found`);
            } else {
              if (!page.url().includes(step.contains)) throw new Error(`url does not contain "${step.contains}" (is ${page.url()})`);
              log.push(`expectUrl "${step.contains}": ok`);
            }
          } catch (err) {
            const reason = err instanceof Error ? err.message : "step failed";
            log.push(`step ${i + 1} ${step.action}: ${reason}`);
            return { ok: false, failedStep: i + 1, reason, log };
          }
        }
        return { ok: true, failedStep: null, reason: null, log };
      } catch (err) {
        return { ok: false, failedStep: null, reason: err instanceof Error ? err.message : "browser failed", log };
      } finally {
        await browser?.close().catch(() => undefined);
      }
    },
  };
}

/** Uses Playwright if it is installed. Returns null when it is not, so checks fall back to "needs human". */
export async function playwrightRunnerIfAvailable(): Promise<BrowserRunner | null> {
  try {
    const load = new Function("m", "return import(m)") as (m: string) => Promise<{ chromium: { launch(o: object): Promise<BrowserLike> } }>;
    const { chromium } = await load("playwright");
    return createBrowserRunner(() => chromium.launch({ args: ["--no-sandbox"] }));
  } catch {
    return null;
  }
}
