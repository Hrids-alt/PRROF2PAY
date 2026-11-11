/** Starts the background tick in the always-on server (Render). One timer per process; the work itself is safe to run from several. */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.DISABLE_TICK === "true") return;
  if (!process.env.DATABASE_URL || !process.env.PAYPAL_CLIENT_ID) return;
  const { getDeps } = await import("./lib/deps");
  const { tick } = await import("./lib/effects");
  const every = Number(process.env.TICK_SECONDS || 30) * 1000;
  setInterval(async () => {
    try {
      await tick(await getDeps());
    } catch (err) {
      console.error("tick failed", err instanceof Error ? err.message : err);
    }
  }, every).unref();
}
