import { assertSameOrigin, handle, jsonBody, requireActor, str } from "@/lib/api";
import { getDeps } from "@/lib/deps";
import { setPayeeEmail } from "@/lib/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return handle(async () => {
    assertSameOrigin(request);
    const actor = await requireActor();
    const body = await jsonBody(request);
    await setPayeeEmail(await getDeps(), actor, str(body.email, 200));
    return { ok: true };
  });
}
