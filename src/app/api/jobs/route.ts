import { assertSameOrigin, handle, jsonBody, requireActor, str } from "@/lib/api";
import { CHECK_TYPES, sanitizeConfig, type CheckType, type ContractInput } from "@/lib/contract";
import { getDeps } from "@/lib/deps";
import { AppError } from "@/lib/errors";
import { createJob } from "@/lib/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const actor = await requireActor();
    const b = await jsonBody(request);
    const reqs = Array.isArray(b.requirements) ? b.requirements : [];
    const input: ContractInput = {
      title: str(b.title, 200),
      description: str(b.description, 4000),
      amountCents: Math.round(Number(b.amount) * 100),
      currency: "USD",
      part1Percent: Math.round(Number(b.part1Percent)),
      reviewWindowHours: Math.round(Number(b.reviewWindowHours)),
      acceptanceWindowHours: Math.round(Number(b.acceptanceWindowHours)),
      noReplyRule: b.noReplyRule === "return" ? "return" : "release",
      dueAt: str(b.dueAt, 40) || null,
      requirements: reqs.map((r: Record<string, unknown>) => {
        const type = (CHECK_TYPES as readonly string[]).includes(str(r.checkType, 20)) ? (str(r.checkType, 20) as CheckType) : "needs_human";
        return { text: str(r.text, 600), checkType: type, checkConfig: sanitizeConfig(type, r.checkConfig) };
      }),
    };
    if (!Number.isFinite(input.amountCents)) throw new AppError(422, "Enter the amount as a number");
    const id = await createJob(await getDeps(), actor, input);
    return { id };
  });
}
