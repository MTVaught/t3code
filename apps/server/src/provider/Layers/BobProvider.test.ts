import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { BobSettings } from "@t3tools/contracts";

import {
  BOB_BUILT_IN_MODELS,
  bobModelsFromSettings,
  buildInitialBobProviderSnapshot,
  checkBobProviderStatus,
  isCompatibleBob2Version,
} from "./BobProvider.ts";
import { writeFakeCli } from "../../testUtils/fakeCli.ts";

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
      assert.equal(snapshot.capabilities?.skills, true);
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

it.layer(NodeServices.layer)("Bob account limits", (it) => {
  it.effect("keeps Bob ready while reporting that its process exposes no account allowance", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bob-version-" });
      const binaryPath = writeFakeCli({ directory, name: "bob", source: 'console.log("2.0.5");' });
      const snapshot = yield* checkBobProviderStatus(
        decodeBobSettings({ enabled: true, binaryPath }),
      );
      assert.equal(snapshot.status, "ready");
      assert.equal(snapshot.installed, true);
      assert.deepEqual(snapshot.usageLimits?.windows, []);
      assert.equal(snapshot.usageLimits?.unavailable?.reason, "unsupported");
      assert.equal(
        snapshot.usageLimits?.unavailable?.message,
        "Bob does not expose account budgets through its process protocol.",
      );
    }).pipe(Effect.scoped),
  );
});
