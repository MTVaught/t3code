import { assert, it } from "@effect/vitest";
import { resolveBobBinary } from "./BobEnvironment.ts";
import * as Schema from "effect/Schema";

import { BobSettings } from "@t3tools/contracts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

it("resolves the bob binary with a bare fallback", () => {
  assert.equal(
    resolveBobBinary(decodeBobSettings({ binaryPath: "/opt/bob/bin/bob", enabled: true })),
    "/opt/bob/bin/bob",
  );
  assert.equal(resolveBobBinary(decodeBobSettings({ enabled: true })), "bob");
});
