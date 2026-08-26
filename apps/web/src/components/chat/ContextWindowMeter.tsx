import { Button } from "../ui/button";
import { cn } from "~/lib/utils";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { formatContextWindowCompactionMessage } from "./ContextWindowMeter.logic";
import { Minimize2Icon } from "lucide-react";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  modelDisplayName?: string | null;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
  compactDisabledReason?: string | null | undefined;
}) {
  const { usage, modelDisplayName, onCompact, compactDisabled, compactDisabledReason } = props;
  const hasContextMaximum = usage.maxTokens !== null && usage.maxTokens !== undefined;
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage?.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;
  const usageColor = isOverloaded
    ? "var(--color-error)"
    : "color-mix(in oklab, var(--color-muted-foreground) 72%, transparent)";

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <button
            type="button"
            className={cn(
              "inline-flex h-7 cursor-pointer items-center justify-center border border-transparent text-muted-foreground outline-none transition-colors",
              hasContextMaximum ? "w-7 rounded-full" : "rounded-md px-1.5 text-xs tabular-nums",
              "hover:bg-accent data-[pressed]:bg-accent",
              "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
            )}
            aria-label={
              usage?.maxTokens !== null && usage?.maxTokens !== undefined && usedPercentage
                ? `Context window ${usedPercentage} used`
                : `Context window ${formatContextWindowTokens(usage.usedTokens)} tokens used`
            }
          >
            {!hasContextMaximum ? (
              <span>{formatContextWindowTokens(usage.usedTokens)}</span>
            ) : (
              <span className="relative flex size-5 items-center justify-center">
                <svg
                  viewBox="0 0 24 24"
                  className="-rotate-90 absolute inset-0 size-full transform-gpu"
                  aria-hidden="true"
                >
                  <circle
                    cx="12"
                    cy="12"
                    r={radius}
                    fill="none"
                    stroke="color-mix(in oklab, var(--color-muted-foreground) 24%, transparent)"
                    strokeWidth="3"
                  />
                  <circle
                    cx="12"
                    cy="12"
                    r={radius}
                    fill="none"
                    stroke={usageColor}
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeDasharray={circumference}
                    strokeDashoffset={dashOffset}
                    className="transition-[stroke-dashoffset,stroke] duration-500 ease-out motion-reduce:transition-none"
                  />
                </svg>
              </span>
            )}
          </button>
        }
      />
      <PopoverPopup
        tooltipStyle
        side="top"
        align="end"
        viewportClassName="p-0"
        className="w-64 max-w-none text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-[var(--floating-content-inset)]">
          {usage ? (
            <div className="flex items-center justify-between gap-3">
              <div className="font-medium text-muted-foreground text-xs">Context Window</div>
              {usage.maxTokens !== null && usedPercentage ? (
                <div className="text-secondary-label text-[11px] tabular-nums">
                  <span>{usedPercentage}</span>
                  <span className="mx-1">·</span>
                  <span>
                    {formatContextWindowTokens(usage.usedTokens)}/
                    {formatContextWindowTokens(usage.maxTokens ?? null)}
                  </span>
                </div>
              ) : (
                <div className="text-secondary-label text-[11px] tabular-nums">
                  {formatContextWindowTokens(usage.usedTokens)}
                </div>
              )}
            </div>
          ) : null}
          {hasContextMaximum ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label="Context window usage"
            >
              <div
                className="h-full rounded-full transition-[width,background-color] duration-500 ease-out motion-reduce:transition-none"
                style={{ width: `${normalizedPercentage}%`, backgroundColor: usageColor }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
              <span className="text-secondary-label">Total processed</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage && usage.inputTokens != null ? (
            <UsageRow
              label="Input"
              value={formatUsagePair(usage.inputTokens, usage.lastInputTokens ?? null)}
            />
          ) : null}
          {usage && usage.outputTokens != null ? (
            <UsageRow
              label="Output"
              value={formatUsagePair(usage.outputTokens, usage.lastOutputTokens ?? null)}
            />
          ) : null}
          {usage && usage.cachedInputTokens != null ? (
            <UsageRow
              label="Cache read"
              value={formatUsagePair(usage.cachedInputTokens, usage.lastCachedInputTokens ?? null)}
            />
          ) : null}
          {usage && usage.cacheWriteInputTokens != null ? (
            <UsageRow
              label="Cache write"
              value={formatUsagePair(
                usage.cacheWriteInputTokens,
                usage.lastCacheWriteInputTokens ?? null,
              )}
            />
          ) : null}
          {usage && usage.toolUses != null ? (
            <UsageRow label="Tool calls" value={`${Math.round(usage.toolUses)}`} />
          ) : null}
          {usage && usage.durationMs != null ? (
            <UsageRow label="Last duration" value={formatDuration(usage.durationMs)} />
          ) : null}
          {usage?.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-[11px] font-medium">
              {formatContextWindowCompactionMessage(modelDisplayName, usage.autoCompactThreshold)}
            </div>
          ) : null}
          {onCompact ? (
            <>
              <Button
                size="xs"
                variant="outline"
                className="mt-1 w-full justify-center"
                disabled={compactDisabled}
                onClick={onCompact}
              >
                <Minimize2Icon aria-hidden="true" />
                Compact context
              </Button>
              {compactDisabled && compactDisabledReason ? (
                <div className="text-pretty text-secondary-label text-[11px]">
                  {compactDisabledReason}
                </div>
              ) : null}
            </>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

function UsageRow(props: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 text-[11px] leading-4">
      <span className="text-secondary-label">{props.label}</span>
      <span className="font-medium tabular-nums text-secondary-label">{props.value}</span>
    </div>
  );
}

function formatUsagePair(total: number | null, last: number | null): string {
  const formattedTotal = formatContextWindowTokens(total);
  return last === null ? formattedTotal : `${formattedTotal} (+${formatContextWindowTokens(last)})`;
}

function formatDuration(durationMs: number): string {
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1_000).toFixed(1).replace(/\.0$/, "")}s`;
}
