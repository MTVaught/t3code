import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { latestThreadUsage, formatThreadSpend } from "@t3tools/shared/threadUsage";
import * as Option from "effect/Option";
import { useMemo } from "react";
import { Alert, Pressable } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useEnvironmentThread } from "../../state/threads";

export function ThreadUsageSummary(props: { environmentId: EnvironmentId; threadId: ThreadId }) {
  const state = useEnvironmentThread(props.environmentId, props.threadId);
  const usage = useMemo(
    () => latestThreadUsage(Option.getOrNull(state.data)?.activities ?? []),
    [state.data],
  );
  if (!usage?.threadSpend) return null;
  const context = `${usage.usedTokens.toLocaleString("en-US")} context tokens`;
  const spend = formatThreadSpend(usage.threadSpend);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${context}, thread spend ${spend}`}
      onPress={() =>
        Alert.alert(
          "Thread usage",
          `${context}\n${usage.maxTokens ? `${usage.maxTokens.toLocaleString("en-US")} token capacity` : "Context capacity unavailable"}\nThread spend: ${spend}`,
        )
      }
      className="max-w-32 shrink px-1 active:opacity-60"
    >
      <Text numberOfLines={1} className="text-2xs tabular-nums text-foreground-muted">
        {usage.usedTokens.toLocaleString("en-US")} tokens
      </Text>
      <Text numberOfLines={1} className="text-2xs tabular-nums text-foreground-muted">
        {spend}
      </Text>
    </Pressable>
  );
}
