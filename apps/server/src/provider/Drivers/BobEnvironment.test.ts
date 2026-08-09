import { assert, it } from "@effect/vitest";
import { makeBobEnvironment, resolveBobBinary } from "./BobEnvironment.ts";
import * as Schema from "effect/Schema";

import { BobSettings } from "@t3tools/contracts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

it("passes the caller environment through without managing Bob authentication", () => {
  const base = {
    PATH: "/usr/bin",
    BOB_API_KEY: "current",
    BOBSHELL_API_KEY: "ambient",
  };
  const env = makeBobEnvironment(base);
  assert.strictEqual(env, base);
  assert.equal(env.BOB_API_KEY, "current");
  assert.equal(env.BOBSHELL_API_KEY, "ambient");
  assert.equal(env.PATH, "/usr/bin");
});

it("resolves the bob binary with a bare fallback", () => {
  assert.equal(
    resolveBobBinary(decodeBobSettings({ binaryPath: "/opt/bob/bin/bob", enabled: true })),
    "/opt/bob/bin/bob",
  );
  assert.equal(resolveBobBinary(decodeBobSettings({ enabled: true })), "bob");
});
