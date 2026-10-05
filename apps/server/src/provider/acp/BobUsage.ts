import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { AcpSessionRuntime } from "./AcpSessionRuntime.ts";

const BobExtensions = Schema.Struct({
  "bob/extensions": Schema.Struct({ version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)) }),
});
const BobTaskExport = Schema.Struct({
  version: Schema.Literal(1),
  tasks: Schema.Array(
    Schema.Struct({
      task: Schema.Struct({
        id: Schema.String,
        costs: Schema.NullOr(
          Schema.Struct({
            contextTokens: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
            cost: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
          }),
        ),
      }),
    }),
  ),
});

const decodeBobTaskExport = Schema.decodeUnknownOption(BobTaskExport);
const hasBobExtensions = Schema.is(BobExtensions);

export function bobTaskExportToUsage(
  value: unknown,
  sessionId: string,
): ThreadTokenUsageSnapshot | undefined {
  const parsed = decodeBobTaskExport(value);
  if (Option.isNone(parsed)) return undefined;
  const costs = parsed.value.tasks.find(({ task }) => task.id === sessionId)?.task.costs;
  if (!costs) return undefined;
  return {
    usedTokens: costs.contextTokens,
    threadSpend: { amount: costs.cost, unit: "Bobcoins" },
  };
}

export const readBobThreadUsage = Effect.fn("BobUsage.readThreadUsage")(
  function* (runtime: AcpSessionRuntime["Service"]) {
    const started = yield* runtime.start();
    if (!hasBobExtensions(started.initializeResult.agentCapabilities?._meta)) return;
    const exported = yield* runtime.request("_bob/task/export", { sessionId: started.sessionId });
    // Bob strips token breakdowns from its public export. Only context usage
    // and the root task's cumulative spend are authoritative here.
    return bobTaskExportToUsage(exported, started.sessionId);
  },
  Effect.timeout("5 seconds"),
  Effect.catch((cause) =>
    Effect.logWarning("Bob could not refresh thread usage.", { cause }).pipe(Effect.as(undefined)),
  ),
);
