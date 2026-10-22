import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as AnalyticsService from "./AnalyticsService.ts";

it.effect(
  "accepts analytics events without credentials, identifiers, storage, or an HTTP client",
  () =>
    Effect.gen(function* () {
      const analytics = yield* AnalyticsService.AnalyticsService;
      yield* analytics.record("session.started", { clientType: "desktop" });
      yield* analytics.record("session.completed", { outcome: "succeeded" });
    }).pipe(Effect.provide(AnalyticsService.layer)),
);
