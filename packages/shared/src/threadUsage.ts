import {
  type OrchestrationThreadActivity,
  type ThreadSpend,
  ThreadTokenUsageSnapshot,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const decodeThreadUsage = Schema.decodeUnknownOption(ThreadTokenUsageSnapshot);

export function latestThreadUsage(activities: ReadonlyArray<OrchestrationThreadActivity>) {
  for (let index = activities.length - 1; index >= 0; index--) {
    const activity = activities[index];
    if (activity?.kind !== "context-window.updated") continue;
    const usage = decodeThreadUsage(activity.payload);
    if (Option.isSome(usage)) return usage.value;
  }
  return null;
}

export function formatThreadSpend(spend: ThreadSpend) {
  return `${spend.amount.toLocaleString("en-US", { maximumFractionDigits: 4 })} ${spend.unit}`;
}
