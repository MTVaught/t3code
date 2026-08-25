import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  providerMode: string | null;
  providerModes: ReadonlyArray<{ readonly slug: string; readonly name: string }>;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
  onProviderModeChange: (mode: string | null) => void;
}) {
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
            aria-label="More composer controls"
          />
        }
      >
        <EllipsisIcon aria-hidden="true" className="size-4" />
      </MenuTrigger>
      <MenuPopup align="start">
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        {props.providerModes.length > 0 ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">
              Provider mode
            </div>
            <MenuRadioGroup
              value={props.providerMode ?? "agent"}
              onValueChange={(value) => props.onProviderModeChange(value)}
            >
              {props.providerModes.map((mode) => (
                <MenuRadioItem key={mode.slug} value={mode.slug}>
                  {mode.name}
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          {(
            [
              ["approval-required", "Supervised"],
              ["auto-accept-edits", "Auto-accept edits"],
              ["auto", "Auto"],
              ["full-access", "Full access"],
            ] as const
          ).map(([mode, label]) => (
            <MenuRadioItem key={mode} value={mode}>
              {label}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
