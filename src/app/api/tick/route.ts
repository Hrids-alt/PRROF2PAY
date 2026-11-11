import { handle } from "@/lib/api";
import { getDeps } from "@/lib/deps";
import { AppError } from "@/lib/errors";
import { tick } from "@/lib/effects";

export const runtime = "nodejs";

/** Deadlines, re-authorization, stuck work and reconcile. Called by the in-process timer and by an optional cron ping. */
export async function POST(request: Request) {
  return handle(async () => {
    const secret = process.env.CRON_SECRET;
    if (!secret || request.headers.get("authorization") !== `Bearer ${secret}`) throw new AppError(401, "Not allowed");
    return tick(await getDeps());
  });
}
