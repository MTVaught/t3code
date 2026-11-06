import {
  ServerNpmReleaseError,
  ServerNpmReleaseInput,
  type ServerNpmRelease,
} from "@t3tools/contracts";
import { CLI_RELEASES_PAGE_URL, isStableCliReleaseVersion } from "@t3tools/shared/cliRelease";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient } from "effect/http";

const Manifest = Schema.Struct({
  version: Schema.String,
  t3code: Schema.Struct({ databaseMigration: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
});
const decodeManifest = Schema.decodeUnknownEffect(Schema.fromJsonString(Manifest));
const decodeInput = Schema.decodeUnknownEffect(ServerNpmReleaseInput);

// Keep the legacy service and RPC name compatible with upstream clients.
export class NpmRelease extends Context.Service<
  NpmRelease,
  {
    readonly get: (
      input: ServerNpmReleaseInput,
    ) => Effect.Effect<ServerNpmRelease | null, ServerNpmReleaseError>;
  }
>()("t3/cloud/npmRelease") {}

export const make = Effect.fn("NpmRelease.make")(function* () {
  const http = yield* HttpClient.HttpClient;
  const cache = yield* Cache.make({
    capacity: 32,
    timeToLive: Duration.minutes(1),
    lookup: Effect.fn("NpmRelease.lookup")(function* (spec: string) {
      if (spec === "nightly") return null;
      const url =
        spec === "latest"
          ? `${CLI_RELEASES_PAGE_URL}/latest/download/release-metadata.json`
          : `${CLI_RELEASES_PAGE_URL}/download/v${spec}/release-metadata.json`;
      return yield* Effect.gen(function* () {
        const response = yield* http.get(url);
        if (response.status === 404) return null;
        if (response.status < 200 || response.status >= 300) {
          return yield* new ServerNpmReleaseError({
            reason: "GitHub Releases could not complete the lookup.",
          });
        }
        const manifest = yield* decodeManifest(yield* response.text);
        if (
          (spec === "latest" && !isStableCliReleaseVersion(manifest.version)) ||
          (spec !== "latest" && manifest.version !== spec)
        ) {
          return yield* new ServerNpmReleaseError({
            reason: "GitHub Releases returned invalid release metadata.",
          });
        }
        return { version: manifest.version, databaseMigration: manifest.t3code.databaseMigration };
      }).pipe(
        Effect.timeout(Duration.seconds(15)),
        Effect.mapError(
          () =>
            new ServerNpmReleaseError({
              reason: "Could not read valid fork release metadata from GitHub Releases.",
            }),
        ),
      );
    }),
  });
  return NpmRelease.of({
    get: Effect.fn("NpmRelease.get")(function* (input) {
      const { spec } = yield* decodeInput(input).pipe(
        Effect.mapError(
          () => new ServerNpmReleaseError({ reason: "Invalid release version or track." }),
        ),
      );
      return yield* Cache.get(cache, spec);
    }),
  });
});

export const layer = Layer.effect(NpmRelease, make()).pipe(Layer.provide(FetchHttpClient.layer));
