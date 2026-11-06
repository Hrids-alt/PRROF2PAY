import { describe, expect, it } from "vitest";
import { UnsafeUrlError, assertSafeUrl, isPublicIp, safeFetch } from "./ssrf";

const publicLookup = async () => ["93.184.216.34"];

describe("isPublicIp", () => {
  it.each([
    "8.8.8.8",
    "93.184.216.34",
    "2606:4700:4700::1111",
  ])("accepts %s", (ip) => expect(isPublicIp(ip)).toBe(true));

  it.each([
    "127.0.0.1",
    "0.0.0.0",
    "10.0.0.1",
    "172.16.5.4",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "198.18.0.1",
    "::1",
    "::",
    "fe80::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::7f00:1",
    "not-an-ip",
  ])("rejects %s", (ip) => expect(isPublicIp(ip)).toBe(false));
});

describe("assertSafeUrl", () => {
  it("accepts a public https host", async () => {
    const t = await assertSafeUrl("https://example.com/app", { lookup: publicLookup });
    expect(t.addresses).toEqual(["93.184.216.34"]);
  });

  it("accepts an explicit 443 port", async () => {
    await expect(assertSafeUrl("https://example.com:443/", { lookup: publicLookup })).resolves.toBeTruthy();
  });

  it.each([
    "http://example.com/",
    "ftp://example.com/",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "not a url",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
    "https://example.com:22/",
  ])("rejects %s", async (u) => {
    await expect(assertSafeUrl(u, { lookup: publicLookup })).rejects.toThrow(UnsafeUrlError);
  });

  it.each([
    "https://localhost/",
    "https://LOCALHOST./",
    "https://app.localhost/",
    "https://intranet/",
    "https://metadata.google.internal/",
    "https://printer.local/",
    "https://127.0.0.1/",
    "https://0x7f.1/",
    "https://2130706433/",
    "https://017700000001/",
    "https://[::1]/",
    "https://[::ffff:127.0.0.1]/",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/",
    "https://192.168.0.10/",
    "https://172.16.0.1/",
    "https://100.64.0.1/",
  ])("rejects internal target %s", async (u) => {
    await expect(assertSafeUrl(u, { lookup: publicLookup })).rejects.toThrow(UnsafeUrlError);
  });

  it("rejects a public-looking name that resolves to a private address", async () => {
    await expect(
      assertSafeUrl("https://evil.example.com/", { lookup: async () => ["10.0.0.7"] }),
    ).rejects.toThrow(/non-public/);
  });

  it("rejects when any resolved address is private (mixed answer)", async () => {
    await expect(
      assertSafeUrl("https://evil.example.com/", { lookup: async () => ["93.184.216.34", "127.0.0.1"] }),
    ).rejects.toThrow(/non-public/);
  });

  it("rejects an empty or failing DNS answer", async () => {
    await expect(assertSafeUrl("https://a.example.com/", { lookup: async () => [] })).rejects.toThrow(
      UnsafeUrlError,
    );
    await expect(
      assertSafeUrl("https://a.example.com/", {
        lookup: async () => {
          throw new Error("ENOTFOUND");
        },
      }),
    ).rejects.toThrow(/resolved/);
  });
});

function fakeFetch(routes: Record<string, () => Response>): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const key = input.toString();
    const route = routes[key];
    if (!route) throw new Error(`unexpected fetch ${key}`);
    return route();
  }) as typeof fetch;
}

describe("safeFetch", () => {
  it("returns the body and final URL", async () => {
    const r = await safeFetch("https://example.com/", {
      lookup: publicLookup,
      fetchImpl: fakeFetch({ "https://example.com/": () => new Response("hello", { status: 200 }) }),
    });
    expect(r.status).toBe(200);
    expect(new TextDecoder().decode(r.body)).toBe("hello");
    expect(r.finalUrl).toBe("https://example.com/");
  });

  it("follows a safe redirect", async () => {
    const r = await safeFetch("https://example.com/a", {
      lookup: publicLookup,
      fetchImpl: fakeFetch({
        "https://example.com/a": () => new Response(null, { status: 302, headers: { location: "/b" } }),
        "https://example.com/b": () => new Response("ok"),
      }),
    });
    expect(r.finalUrl).toBe("https://example.com/b");
  });

  it("blocks a redirect to the cloud metadata address", async () => {
    await expect(
      safeFetch("https://example.com/a", {
        lookup: publicLookup,
        fetchImpl: fakeFetch({
          "https://example.com/a": () =>
            new Response(null, { status: 302, headers: { location: "https://169.254.169.254/latest/" } }),
        }),
      }),
    ).rejects.toThrow(UnsafeUrlError);
  });

  it("blocks a redirect downgrade to http", async () => {
    await expect(
      safeFetch("https://example.com/a", {
        lookup: publicLookup,
        fetchImpl: fakeFetch({
          "https://example.com/a": () =>
            new Response(null, { status: 301, headers: { location: "http://example.com/b" } }),
        }),
      }),
    ).rejects.toThrow(/https/);
  });

  it("stops redirect loops", async () => {
    await expect(
      safeFetch("https://example.com/a", {
        lookup: publicLookup,
        maxRedirects: 2,
        fetchImpl: fakeFetch({
          "https://example.com/a": () => new Response(null, { status: 302, headers: { location: "/a" } }),
        }),
      }),
    ).rejects.toThrow(/Too many redirects/);
  });

  it("caps the response size", async () => {
    await expect(
      safeFetch("https://example.com/", {
        lookup: publicLookup,
        maxBytes: 10,
        fetchImpl: fakeFetch({ "https://example.com/": () => new Response("x".repeat(100)) }),
      }),
    ).rejects.toThrow(/larger than/);
  });
});
