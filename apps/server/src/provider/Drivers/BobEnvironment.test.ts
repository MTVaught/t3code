import { assert, it } from "@effect/vitest";
import { makeBobEnvironment, resolveBobBinary } from "./BobEnvironment.ts";
import * as Schema from "effect/Schema";

import { BobSettings } from "@t3tools/contracts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

it("injects the configured API key over the base environment", () => {
  const settings = decodeBobSettings({ binaryPath: "bob", enabled: true, apiKey: "secret" });
  const env = makeBobEnvironment(settings, {
    PATH: "/usr/bin",
    BOB_API_KEY: "ambient-current",
  });
  assert.equal(env.BOB_API_KEY, "secret");
  assert.equal(env.PATH, "/usr/bin");
});

it("inherits the ambient API key when none is configured", () => {
  const settings = decodeBobSettings({ binaryPath: "bob", enabled: true });
  const env = makeBobEnvironment(settings, {
    PATH: "/usr/bin",
    BOB_API_KEY: "current",
  });
  assert.equal(env.BOB_API_KEY, "current");
  assert.equal(env.PATH, "/usr/bin");
});

it("resolves the bob binary with a bare fallback", () => {
  assert.equal(
    resolveBobBinary(decodeBobSettings({ binaryPath: "/opt/bob/bin/bob", enabled: true })),
    "/opt/bob/bin/bob",
  );
  assert.equal(resolveBobBinary(decodeBobSettings({ enabled: true })), "bob");
});
