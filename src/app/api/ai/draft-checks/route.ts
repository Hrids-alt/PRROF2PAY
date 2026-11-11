import { assertSameOrigin, handle, jsonBody, requireActor } from "@/lib/api";
import { draftRequirements } from "@/lib/draft";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    await requireActor();
    const b = await jsonBody(request);
    const lines = Array.isArray(b.lines) ? b.lines.filter((l): l is string => typeof l === "string").map((l) => l.slice(0, 500)) : [];
    return draftRequirements(lines);
  });
}
