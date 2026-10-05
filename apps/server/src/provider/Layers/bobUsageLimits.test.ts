import { describe, expect, it } from "vite-plus/test";
import { fetchBobUsageLimits } from "./bobUsageLimits.ts";

const checkedAt = "2026-10-06T00:00:00.000Z";
const instance = {
  instance_id: "subscription",
  user_id: "member",
  region_domain: "eu-de.bob.ibm.com",
  refresh_at: "2026-11-01T00:00:00Z",
  teams: [{ id: "work", budget_limit: 160 }],
};
function fixtures(
  options: {
    apiKey?: boolean;
    usage?: unknown;
    limit?: number;
    status?: number;
    noAuth?: boolean;
    active?: string;
  } = {},
) {
  const calls: Array<{ url: string; headers: Headers }> = [];
  const secrets = options.noAuth
    ? {}
    : {
        "bob.auth.tokens-https://api.us-east.bob.ibm.com": JSON.stringify({
          token: "test-session-token",
        }),
        "bob.profile.active": options.active ?? "subscription:work",
      };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, headers: new Headers(init?.headers) });
    if (options.status) return new Response("private error body", { status: options.status });
    return Response.json(
      url.endsWith("/profile")
        ? {
            user_id: "user",
            instances: [
              { ...instance, instance_id: "other", teams: [{ id: "other", budget_limit: 50 }] },
              { ...instance, teams: [{ id: "work", budget_limit: options.limit ?? 160 }] },
            ],
          }
        : { usage: options.usage ?? 42.6 },
    );
  };
  return { calls, dependencies: { secrets, fetch } };
}

describe("Bob account allowance", () => {
  it("reads the selected OAuth profile and region-scoped account spend", async () => {
    const { calls, dependencies } = fixtures();
    const limits = await fetchBobUsageLimits({ HOME: "/test" }, checkedAt, dependencies);
    expect(limits.windows).toEqual([
      {
        id: "bob-account",
        kind: "monthly",
        label: "Monthly",
        usedPercent: 26.625,
        amount: { used: 42.6, limit: 160, unit: "Bobcoins" },
        resetsAt: "2026-11-01T00:00:00.000Z",
      },
    ]);
    expect(calls.map((call) => call.url)).toEqual([
      "https://api.us-east.bob.ibm.com/admin/v1/profile",
      "https://api.eu-de.bob.ibm.com/admin/v1/teams/work/users/member",
    ]);
    expect(calls[1]?.headers.get("Authorization")).toBe("Bearer test-session-token");
    expect(calls[1]?.headers.get("x-instance-id")).toBe("subscription");
    expect(calls[1]?.headers.get("x-team-id")).toBe("work");
  });

  it("uses an instance API key and configured gateway without reading browser tokens", async () => {
    const { calls, dependencies } = fixtures({ noAuth: true });
    const limits = await fetchBobUsageLimits(
      { BOB_API_KEY: "test-api-key", BOB_GATEWAY_URL: "https://bob.example/" },
      checkedAt,
      dependencies,
    );
    expect(limits.windows[0]?.amount).toEqual({ used: 42.6, limit: 50, unit: "Bobcoins" });
    expect(calls.every((call) => call.url.startsWith("https://bob.example/admin/v1/"))).toBe(true);
    expect(calls[0]?.headers.get("Authorization")).toBe("apikey test-api-key");
  });

  it("shows authentication is needed without making anonymous account requests", async () => {
    const { calls, dependencies } = fixtures({ noAuth: true });
    const limits = await fetchBobUsageLimits({}, checkedAt, dependencies);
    expect(limits.unavailable?.reason).toBe("probeFailed");
    expect(limits.windows).toEqual([]);
    expect(calls).toEqual([]);
  });

  it("caps over-budget percentages while preserving exact coin spend", async () => {
    const { dependencies } = fixtures({ usage: 180 });
    const limits = await fetchBobUsageLimits({}, checkedAt, dependencies);
    expect(limits.windows[0]?.usedPercent).toBe(100);
    expect(limits.windows[0]?.amount).toEqual({ used: 180, limit: 160, unit: "Bobcoins" });
  });

  it("preserves zero allowance and usage", async () => {
    const { dependencies } = fixtures({ limit: 0, usage: 0 });
    const limits = await fetchBobUsageLimits({}, checkedAt, dependencies);
    expect(limits.windows[0]?.usedPercent).toBe(0);
    expect(limits.windows[0]?.amount).toEqual({ used: 0, limit: 0, unit: "Bobcoins" });
  });

  it("rejects invalid account spend and excludes private response bodies from errors", async () => {
    const badUsage = fixtures({ usage: -1 });
    await expect(fetchBobUsageLimits({}, checkedAt, badUsage.dependencies)).rejects.toThrow();
    const denied = fixtures({ status: 401 });
    await expect(fetchBobUsageLimits({}, checkedAt, denied.dependencies)).rejects.toThrow(
      "Bob account request failed (401).",
    );
  });
});
