import { currentActor } from "@/lib/auth";
import { getDeps } from "@/lib/deps";
import { toAppError } from "@/lib/errors";
import { completeFunding } from "@/lib/service";

export const runtime = "nodejs";

const to = (request: Request, path: string) => Response.redirect(new URL(path, process.env.APP_URL || request.url), 303);

/** PayPal sends the client back here after they approve. We turn the approved order into the hold. */
export async function GET(request: Request) {
  const url = new URL(request.url);
  const milestoneId = url.searchParams.get("m") ?? "";
  const orderId = url.searchParams.get("token") ?? "";
  const actor = await currentActor();
  if (!actor) return to(request, "/login");
  try {
    await completeFunding(await getDeps(), actor, milestoneId, orderId);
    return to(request, `/m/${encodeURIComponent(milestoneId)}?notice=${encodeURIComponent("Funds reserved. PayPal now holds the authorization.")}`);
  } catch (err) {
    const app = toAppError(err);
    if (!app) console.error("funding return failed", err);
    return to(request, `/m/${encodeURIComponent(milestoneId)}?error=${encodeURIComponent(app?.message ?? "We could not confirm the reservation. Nothing was charged.")}`);
  }
}
