import { assert, it } from "@effect/vitest";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { BobSettings } from "@t3tools/contracts";

import {
  BOB_BUILT_IN_MODELS,
  bobModelsFromSettings,
  buildInitialBobProviderSnapshot,
  isCompatibleBob2Version,
} from "./BobProvider.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

describe("BobProvider", () => {
  it("publishes one provider-managed routing model", () => {
    assert.deepEqual(bobModelsFromSettings(), BOB_BUILT_IN_MODELS);
    assert.deepInclude(BOB_BUILT_IN_MODELS[0], {
      slug: "bob-managed",
      name: "Bob managed",
      isCustom: false,
    });
  });

  it.effect("publishes ACP-native metadata capabilities", () =>
    Effect.gen(function* () {
      const settings = decodeBobSettings({ enabled: true });
      const snapshot = yield* buildInitialBobProviderSnapshot(settings);

      assert.equal(snapshot.capabilities?.commands, true);
      assert.equal(snapshot.capabilities?.skills, false);
      assert.equal(snapshot.capabilities?.providerModes, true);
      assert.equal(snapshot.capabilities?.approvals, true);
      assert.equal(snapshot.capabilities?.tokenUsage, false);
    }),
  );

  it("requires the ACP-capable Bob 2.0.1 release or newer", () => {
    assert.isFalse(isCompatibleBob2Version("2.0.0"));
    assert.isTrue(isCompatibleBob2Version("2.0.1"));
    assert.isTrue(isCompatibleBob2Version("2.4.1"));
    assert.isFalse(isCompatibleBob2Version("1.9.9"));
    assert.isFalse(isCompatibleBob2Version("not-a-version"));
    assert.isFalse(isCompatibleBob2Version(null));
  });
});
