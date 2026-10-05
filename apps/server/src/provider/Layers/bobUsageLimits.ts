import * as NodeOS from "node:os";
import type { ServerProviderUsageLimits } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";

const NonNegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const OptionalString = Schema.optional(Schema.String);
const decodeSettings = Schema.decodeUnknownSync(Schema.Struct({ gatewayUrl: OptionalString }));
const decodeSecrets = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown));
const decodeToken = Schema.decodeUnknownSync(Schema.Struct({ token: Schema.NonEmptyString }));
const decodeProfile = Schema.decodeUnknownSync(
  Schema.Struct({
    instances: Schema.Array(
      Schema.Struct({
        instance_id: Schema.String,
        user_id: Schema.String,
        region_domain: OptionalString,
        refresh_at: OptionalString,
        teams: Schema.Array(
          Schema.Struct({
            id: Schema.String,
            budget_limit: Schema.optional(Schema.NullOr(NonNegative)),
          }),
        ),
      }),
    ),
  }),
);
const decodeBudget = Schema.decodeUnknownSync(Schema.Struct({ usage: NonNegative }));

export interface BobUsageDependencies {
  readonly settings?: unknown;
  readonly secrets?: unknown;
  readonly fetch?: typeof globalThis.fetch;
}

/** Bob 2.0.5's admin API and credential storage; credentials remain on the server. */
export async function fetchBobUsageLimits(
  environment: NodeJS.ProcessEnv,
  checkedAt: string,
  dependencies: BobUsageDependencies = {},
): Promise<ServerProviderUsageLimits> {
  const request = dependencies.fetch ?? globalThis.fetch;
  const settings = decodeSettings(dependencies.settings ?? {});
  const gateway = (
    environment.BOB_GATEWAY_URL ||
    settings.gatewayUrl ||
    "https://api.us-east.bob.ibm.com"
  ).replace(/\/+$/, "");
  const headers = new Headers({ "User-Agent": "T3Code/BobUsage" });
  let activeProfile: string | undefined;
  if (environment.BOB_API_KEY) {
    headers.set("Authorization", `apikey ${environment.BOB_API_KEY}`);
  } else {
    const secrets = decodeSecrets(dependencies.secrets ?? {});
    const stored = secrets[`bob.auth.tokens-${gateway}`];
    if (typeof stored !== "string") {
      return {
        checkedAt,
        windows: [],
        unavailable: {
          reason: "probeFailed",
          message: "Sign in to Bob on this environment to read its account budget.",
        },
      };
    }
    const token = decodeToken(JSON.parse(stored));
    // Bob owns token refresh and writes renewed credentials back to this file.
    // The probe reads them afresh without rotating Bob's refresh token.
    headers.set("Authorization", `Bearer ${token.token}`);
    const selected = secrets["bob.profile.active"];
    if (typeof selected === "string") activeProfile = selected;
  }
  const get = async (base: string, path: string) => {
    const response = await request(`${base}/admin/v1${path}`, {
      headers,
      signal: AbortSignal.timeout(5000),
      redirect: "error",
    });
    // Never include response bodies or credential-bearing requests in errors.
    if (!response.ok) throw new Error(`Bob account request failed (${response.status}).`);
    return response.json();
  };
  const profile = decodeProfile(await get(gateway, "/profile"));
  const accounts = profile.instances.flatMap((instance) =>
    instance.teams.map((team) => ({ instance, team })),
  );
  const selected =
    accounts.find(({ instance, team }) => `${instance.instance_id}:${team.id}` === activeProfile) ??
    accounts[0];
  const limit = selected?.team.budget_limit;
  if (!selected || limit == null) {
    return {
      checkedAt,
      windows: [],
      unavailable: {
        reason: "unsupported",
        message: "Bob did not report an account allowance for this profile.",
      },
    };
  }
  const { instance, team } = selected;
  headers.set("x-instance-id", instance.instance_id);
  headers.set("x-team-id", team.id);
  // OAuth budgets are region-scoped in Bob; API-key admin requests use the configured gateway.
  const budgetGateway = new URL(gateway);
  if (!environment.BOB_API_KEY && instance.region_domain) {
    budgetGateway.hostname = instance.region_domain.startsWith("api.")
      ? instance.region_domain
      : `api.${instance.region_domain}`;
  }
  const budget = decodeBudget(
    await get(
      budgetGateway.toString().replace(/\/$/, ""),
      `/teams/${encodeURIComponent(team.id)}/users/${encodeURIComponent(instance.user_id)}`,
    ),
  );
  const resetsAt = instance.refresh_at
    ? Option.getOrUndefined(Option.map(DateTime.make(instance.refresh_at), DateTime.formatIso))
    : undefined;
  return {
    checkedAt,
    windows: [
      {
        id: "bob-account",
        kind: resetsAt ? "monthly" : "other",
        label: resetsAt ? "Monthly" : "Allowance",
        usedPercent:
          limit > 0 ? Math.min(100, (budget.usage / limit) * 100) : budget.usage > 0 ? 100 : 0,
        amount: { used: budget.usage, limit, unit: "Bobcoins" },
        ...(resetsAt ? { resetsAt } : {}),
      },
    ],
  };
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
export const readBobUsageLimits = Effect.fn("BobUsageLimits.read")(function* (
  environment: NodeJS.ProcessEnv,
  checkedAt: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(
    environment.HOME ?? environment.USERPROFILE ?? NodeOS.homedir(),
    ".bob",
    "settings",
  );
  const read = Effect.fn(function* (name: string) {
    const file = path.join(directory, name);
    if (!(yield* fs.exists(file))) return {};
    return yield* fs.readFileString(file).pipe(Effect.flatMap(decodeJson));
  });
  const settings = yield* read("settings.json");
  const secrets = environment.BOB_API_KEY ? {} : yield* read("auth-secrets.json");
  return yield* Effect.tryPromise(() =>
    fetchBobUsageLimits(environment, checkedAt, { settings, secrets }),
  );
});
