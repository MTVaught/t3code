import { expect, it } from "@effect/vitest";
import { ServerNpmReleaseError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Result from "effect/Result";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as NpmRelease from "./npmRelease.ts";

const version = "0.1.7-treher.1";
const makeService = (respond: (url: string) => Response) =>
  NpmRelease.make().pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, respond(request.url))),
      ),
    ),
  );

it.effect("reads fork metadata with migration bounds and caches it without npm", () =>
  Effect.gen(function* () {
    const urls: string[] = [];
    const service = yield* makeService((url) => {
      urls.push(url);
      return new Response(JSON.stringify({ version, t3code: { databaseMigration: 42 } }));
    });
    const expected = { version, databaseMigration: 42 };
    expect(yield* service.get({ spec: "latest" })).toEqual(expected);
    expect(yield* service.get({ spec: "latest" })).toEqual(expected);
    expect(urls).toEqual([
      "https://github.com/MTVaught/t3code/releases/latest/download/release-metadata.json",
    ]);
    yield* TestClock.adjust("1 minute");
    expect(yield* service.get({ spec: "latest" })).toEqual(expected);
    expect(urls).toHaveLength(2);
    expect(yield* service.get({ spec: version })).toEqual(expected);
    expect(urls[2]).toBe(
      `https://github.com/MTVaught/t3code/releases/download/v${version}/release-metadata.json`,
    );
  }),
);

it.effect("returns unpublished for missing releases and the unbuilt nightly channel", () =>
  Effect.gen(function* () {
    let calls = 0;
    const service = yield* makeService(() => {
      calls++;
      return new Response("", { status: 404 });
    });
    expect(yield* service.get({ spec: "nightly" })).toBeNull();
    expect(calls).toBe(0);
    expect(yield* service.get({ spec: version })).toBeNull();
    expect(calls).toBe(1);
  }),
);

it.effect.each([
  [200, "not json"],
  [200, JSON.stringify({ version: "9.9.9", t3code: { databaseMigration: 42 } })],
  [200, JSON.stringify({ version })],
  [200, JSON.stringify({ version, t3code: { databaseMigration: -1 } })],
  [403, "sensitive transport information"],
] as const)("rejects invalid or failed release metadata: %s %s", ([status, body]) =>
  Effect.gen(function* () {
    const service = yield* makeService(() => new Response(body, { status }));
    const result = yield* service.get({ spec: version }).pipe(Effect.result);
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(ServerNpmReleaseError);
      expect(result.failure.message).not.toContain("sensitive");
    }
  }),
);

it.effect("does not offer a preview as the latest stable release", () =>
  Effect.gen(function* () {
    const service = yield* makeService(
      () =>
        new Response(
          JSON.stringify({
            version: "0.1.7-preview.20261106.1",
            t3code: { databaseMigration: 42 },
          }),
        ),
    );
    expect(Result.isFailure(yield* service.get({ spec: "latest" }).pipe(Effect.result))).toBe(true);
  }),
);

it.effect("bounds a stalled metadata response", () =>
  Effect.gen(function* () {
    const service = yield* makeService(() => new Response(new ReadableStream()));
    const lookup = yield* service.get({ spec: "latest" }).pipe(Effect.result, Effect.forkChild);
    yield* TestClock.adjust("15 seconds");
    expect(Result.isFailure(yield* Fiber.join(lookup))).toBe(true);
  }),
);

it.effect.each(["--registry=https://example.com", "../other", "other-package@latest", "*", ""])(
  "rejects invalid specs before making a request: %s",
  (spec) =>
    Effect.gen(function* () {
      const service = yield* makeService(() => {
        throw new Error("Invalid input must not make a request");
      });
      expect(Result.isFailure(yield* service.get({ spec }).pipe(Effect.result))).toBe(true);
    }),
);
