// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { BobSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import { makeBobTextGeneration } from "./BobTextGeneration.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);
const dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(dirname, "../../scripts/acp-mock-agent.ts");

it.effect("generates thread titles through a disposable Bob ACP session", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "bob-acp-text-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const wrapper = NodePath.join(directory, "bob");
    NodeFS.writeFileSync(
      wrapper,
      [
        "#!/bin/sh",
        `export T3_ACP_PROMPT_RESPONSE_TEXT='{"title":"ACP-native Bob integration"}'`,
        `exec node "${mockAgentPath}"`,
        "",
      ].join("\n"),
      "utf8",
    );
    NodeFS.chmodSync(wrapper, 0o755);

    const service = yield* makeBobTextGeneration(
      decodeBobSettings({ enabled: true, binaryPath: wrapper }),
    );
    const generated = yield* service.generateThreadTitle({
      cwd: process.cwd(),
      message: "Migrate Bob to ACP",
      modelSelection: {
        instanceId: ProviderInstanceId.make("bob"),
        model: "bob-managed",
      },
    });
    expect(generated.title).toBe("ACP-native Bob integration");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
