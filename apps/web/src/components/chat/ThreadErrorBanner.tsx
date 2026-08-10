import { memo } from "react";
import { Alert, AlertAction, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { CircleAlertIcon, XIcon } from "lucide-react";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const ThreadErrorBanner = memo(function ThreadErrorBanner({
  error,
  onDismiss,
  recoveryAction,
}: {
  error: string | null;
  onDismiss?: () => void;
  recoveryAction?: {
    readonly label: string;
    readonly onClick: () => void;
    readonly pending?: boolean;
  };
}) {
  if (!error) return null;
  return (
    <div className="mx-auto w-fit max-w-[min(48rem,calc(100%-2rem))] pt-3">
      <Alert variant="error" controlAlignment="first-line">
        <CircleAlertIcon />
        <AlertDescription>
          <Tooltip>
            <TooltipTrigger render={<div className="line-clamp-3" />}>{error}</TooltipTrigger>
            <TooltipPopup side="top" className="max-w-96 whitespace-pre-wrap">
              {error}
            </TooltipPopup>
          </Tooltip>
        </AlertDescription>
        {(recoveryAction || onDismiss) && (
          <AlertAction>
            <div className="flex items-center gap-1">
              {recoveryAction ? (
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={recoveryAction.pending}
                  onClick={recoveryAction.onClick}
                >
                  {recoveryAction.pending ? "Resetting…" : recoveryAction.label}
                </Button>
              ) : null}
              {onDismiss ? (
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Dismiss error"
                  onClick={onDismiss}
                >
                  <XIcon className="text-destructive" />
                </Button>
              ) : null}
            </div>
          </AlertAction>
        )}
      </Alert>
    </div>
  );
});
