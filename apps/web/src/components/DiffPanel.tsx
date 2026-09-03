import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import { useParams } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import type { ScopedThreadRef, TurnId } from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  Columns2Icon,
  FileCode2Icon,
  Globe2Icon,
  PilcrowIcon,
  RefreshCwIcon,
  Rows3Icon,
  SearchIcon,
  TextWrapIcon,
  UnfoldVerticalIcon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { cn } from "~/lib/utils";
import { selectThreadDiffPanelSelection, useDiffPanelStore } from "../diffPanelStore";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffRenderKey,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import {
  filterDiffFiles,
  isWideDiffPanelWidth,
  moveActiveDiffFile,
  resolveActiveDiffFile,
} from "../lib/diffFileNavigation";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useProject, useThread } from "../state/entities";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useClientSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { Button } from "./ui/button";
import { ToggleGroup, Toggle } from "./ui/toggle-group";
import { Switch } from "./ui/switch";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "./ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "./ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";
import { useEnvironmentQuery } from "../state/query";
import { useAtomCommand } from "../state/use-atom-command";
import { useAtomQueryRunner } from "../state/use-atom-query-runner";
import { serverEnvironment } from "../state/server";
import { reviewEnvironment } from "../state/review";
import { vcsEnvironment } from "../state/vcs";
import { buildBaseRefChoices, filterBaseRefChoices } from "../lib/baseRefChoices";
import { assetEnvironment } from "../state/assets";
import { previewEnvironment } from "../state/preview";
import { useEnvironmentHttpBaseUrl } from "../state/environments";
import { isBrowserPreviewFile, openFileInPreview } from "../browser/openFileInPreview";
import { isPreviewSupportedInRuntime } from "../previewStateStore";
import { resolvePathLinkTarget } from "../terminal-links";
import { stackedThreadToast, toastManager } from "./ui/toast";
import { createGitDiffFileContentsLoader } from "../lib/diffFileContents";

type DiffRenderMode = "unified" | "split";
type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";

function diffFileName(filePath: string): string {
  return filePath.slice(filePath.lastIndexOf("/") + 1);
}

function diffFileDirectory(filePath: string): string {
  const separatorIndex = filePath.lastIndexOf("/");
  return separatorIndex < 0 ? "." : filePath.slice(0, separatorIndex);
}

function diffFileStatus(type: FileDiffMetadata["type"]): string {
  switch (type) {
    case "new":
      return "A";
    case "deleted":
      return "D";
    case "rename-pure":
    case "rename-changed":
      return "R";
    case "change":
      return "M";
    default:
      return "M";
  }
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  initialGitScope: "branch" | "unstaged";
}

export { DiffWorkerPoolProvider } from "./DiffWorkerPoolProvider";

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  initialGitScope: initialGitScopeProp,
}: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [initialGitScope] = useState(initialGitScopeProp);
  const [isWideDiffPanel, setIsWideDiffPanel] = useState(false);
  const [diffRenderModeByWidth, setDiffRenderModeByWidth] = useState<
    Record<"compact" | "wide", DiffRenderMode>
  >({ compact: "unified", wide: "split" });
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [diffExpandUnchanged, setDiffExpandUnchanged] = useState(settings.diffExpandUnchanged);
  const [baseRefQuery, setBaseRefQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [activeFilePathByScope, setActiveFilePathByScope] = useState<Record<string, string>>({});
  const [handledFileRevealKey, setHandledFileRevealKey] = useState<string | null>(null);
  const diffPanelViewportRef = useRef<HTMLDivElement>(null);
  const codeViewRef = useRef<AnnotatableCodeViewHandle>(null);
  const lastCompletedTurnRefreshRef = useRef<{
    readonly threadKey: string | null;
    readonly turnId: TurnId | null;
  } | null>(null);

  const routeThreadRef = useParams({
    strict: false,
    select: (params) => resolveThreadRouteRef(params),
  });
  const activeThreadId = routeThreadRef?.threadId ?? null;
  const activeThread = useThread(routeThreadRef);
  const activeProjectId = activeThread?.projectId ?? null;
  const activeProject = useProject(
    activeThread && activeProjectId
      ? {
          environmentId: activeThread.environmentId,
          projectId: activeProjectId,
        }
      : null,
  );
  const activeCwd = activeThread?.worktreePath ?? activeProject?.workspaceRoot;
  const activeRepositoryRoot = activeThread?.worktreePath
    ? undefined
    : activeProject?.repositoryIdentity?.rootPath;
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(activeThread?.environmentId ?? null),
  );
  const openInPreferredEditor = useOpenInPreferredEditor(
    activeThread?.environmentId ?? null,
    serverConfig?.availableEditors ?? [],
  );
  const getDiffFileContents = useAtomCommand(reviewEnvironment.diffFileContents);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(activeThread?.environmentId ?? null);
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
  });
  const openPreview = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const gitStatusQuery = useEnvironmentQuery(
    activeThread !== null && activeThread !== undefined && activeCwd != null
      ? vcsEnvironment.status({
          environmentId: activeThread.environmentId,
          input: { cwd: activeCwd },
        })
      : null,
  );
  const diffSelection = useDiffPanelStore((state) =>
    selectThreadDiffPanelSelection(
      state.byThreadKey,
      routeThreadRef,
      initialGitScope === "unstaged",
    ),
  );
  const isGitRepo = gitStatusQuery.data?.isRepo ?? true;
  const { turnDiffSummaries, inferredCheckpointTurnCountByTurnId } =
    useTurnDiffSummaries(activeThread);
  const orderedTurnDiffSummaries = useMemo(
    () =>
      [...turnDiffSummaries].toSorted((left, right) => {
        const leftTurnCount =
          left.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[left.turnId] ?? 0;
        const rightTurnCount =
          right.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[right.turnId] ?? 0;
        if (leftTurnCount !== rightTurnCount) {
          return rightTurnCount - leftTurnCount;
        }
        return right.completedAt.localeCompare(left.completedAt);
      }),
    [inferredCheckpointTurnCountByTurnId, turnDiffSummaries],
  );

  useEffect(() => {
    if (!routeThreadRef || diffSelection.kind !== "turn") return;
    useDiffPanelStore.getState().reconcileTurnSelection(
      routeThreadRef,
      orderedTurnDiffSummaries.map((summary) => summary.turnId),
    );
  }, [diffSelection, orderedTurnDiffSummaries, routeThreadRef]);

  const selectedTurnId = diffSelection.kind === "turn" ? diffSelection.turnId : null;
  const selectedGitScope = diffSelection.kind === "unstaged" ? "unstaged" : "branch";
  const selectedBaseRef = diffSelection.kind === "branch" ? diffSelection.baseRef : null;
  const selectedFilePath = diffSelection.kind === "turn" ? diffSelection.filePath : null;
  const selectedFileRevealRequestId =
    diffSelection.kind === "turn" ? diffSelection.revealRequestId : 0;
  const selectedTurn =
    selectedTurnId === null
      ? undefined
      : (orderedTurnDiffSummaries.find((summary) => summary.turnId === selectedTurnId) ??
        orderedTurnDiffSummaries[0]);
  const selectedCheckpointTurnCount =
    selectedTurn &&
    (selectedTurn.checkpointTurnCount ?? inferredCheckpointTurnCountByTurnId[selectedTurn.turnId]);
  const latestTurn = orderedTurnDiffSummaries[0];
  const selectedScopeLabel =
    selectedTurnId === null
      ? selectedGitScope === "unstaged"
        ? "Working tree"
        : "Branch changes"
      : selectedTurn?.turnId === latestTurn?.turnId
        ? "Latest turn"
        : `Turn ${selectedCheckpointTurnCount ?? "?"}`;
  const reviewSectionId = selectedTurn ? `turn:${selectedTurn.turnId}` : selectedGitScope;
  const fileSelectionScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : reviewSectionId;
  const reviewSectionTitle = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
    : selectedGitScope === "unstaged"
      ? "Working tree"
      : "Branch changes";
  const widthClass = isWideDiffPanel ? "wide" : "compact";
  const diffRenderMode = diffRenderModeByWidth[widthClass];
  const selectedCheckpointRange = useMemo(
    () =>
      typeof selectedCheckpointTurnCount === "number"
        ? {
            fromTurnCount: Math.max(0, selectedCheckpointTurnCount - 1),
            toTurnCount: selectedCheckpointTurnCount,
          }
        : null,
    [selectedCheckpointTurnCount],
  );
  const activeCheckpointDiff = useCheckpointDiff(
    {
      environmentId: activeThread?.environmentId ?? null,
      threadId: activeThreadId,
      fromTurnCount: selectedCheckpointRange?.fromTurnCount ?? null,
      toTurnCount: selectedCheckpointRange?.toTurnCount ?? null,
      ignoreWhitespace: diffIgnoreWhitespace,
      cacheScope: selectedTurn ? `turn:${selectedTurn.turnId}` : null,
    },
    { enabled: isGitRepo && selectedTurn !== undefined },
  );
  const primaryBranchDiffPreview = useEnvironmentQuery(
    selectedTurnId === null && activeThread && activeCwd
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: activeCwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const shouldRetryBranchDiffAtEnvironmentCwd =
    selectedTurnId === null &&
    primaryBranchDiffPreview.error?.includes("configured workspace root") === true &&
    serverConfig?.cwd !== undefined &&
    serverConfig.cwd !== activeCwd;
  const fallbackBranchDiffPreview = useEnvironmentQuery(
    shouldRetryBranchDiffAtEnvironmentCwd && activeThread && serverConfig
      ? reviewEnvironment.diffPreview({
          environmentId: activeThread.environmentId,
          input: {
            cwd: serverConfig.cwd,
            ...(selectedBaseRef ? { baseRef: selectedBaseRef } : {}),
            ignoreWhitespace: diffIgnoreWhitespace,
          },
        })
      : null,
  );
  const branchDiffPreview = shouldRetryBranchDiffAtEnvironmentCwd
    ? fallbackBranchDiffPreview
    : primaryBranchDiffPreview;
  const refreshBranchDiffPreview = branchDiffPreview.refresh;
  const canRefreshGitDiff =
    isGitRepo && selectedTurnId === null && activeThread != null && activeCwd != null;
  const activeThreadRefreshKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}`
    : null;

  useEffect(() => {
    const viewport = diffPanelViewportRef.current;
    if (!viewport) return;

    const updateWidthClass = (width: number) => {
      const nextIsWide = isWideDiffPanelWidth(width);
      setIsWideDiffPanel((current) => (current === nextIsWide ? current : nextIsWide));
    };
    updateWidthClass(viewport.getBoundingClientRect().width);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(([entry]) => {
      if (entry) updateWidthClass(entry.contentRect.width);
    });
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [activeThreadId]);

  useEffect(() => {
    if (!canRefreshGitDiff) return;
    const refreshOnFocus = () => refreshBranchDiffPreview();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [canRefreshGitDiff, refreshBranchDiffPreview]);

  useEffect(() => {
    const current = {
      threadKey: activeThreadRefreshKey,
      turnId: latestTurn?.turnId ?? null,
    };
    const previous = lastCompletedTurnRefreshRef.current;
    if (!canRefreshGitDiff) {
      return;
    }
    if (previous === null || previous.threadKey !== current.threadKey) {
      lastCompletedTurnRefreshRef.current = current;
      return;
    }
    if (previous.turnId === current.turnId) return;
    refreshBranchDiffPreview();
    lastCompletedTurnRefreshRef.current = current;
  }, [activeThreadRefreshKey, canRefreshGitDiff, latestTurn?.turnId, refreshBranchDiffPreview]);

  const selectedGitSource = branchDiffPreview.data?.sources.find(
    (source) => source.kind === (selectedGitScope === "unstaged" ? "working-tree" : "branch-range"),
  );
  const loadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
    const preview = branchDiffPreview.data;
    if (selectedTurnId !== null || !activeThread || !preview || !selectedGitSource) {
      return undefined;
    }

    return createGitDiffFileContentsLoader(getDiffFileContents, {
      environmentId: activeThread.environmentId,
      cwd: preview.cwd,
      sourceKind: selectedGitSource.kind,
      baseRef: selectedGitSource.baseRef,
      headRef: selectedGitSource.headRef,
      cacheKey: selectedGitSource.diffHash,
    });
  }, [
    activeThread,
    branchDiffPreview.data,
    getDiffFileContents,
    selectedGitSource,
    selectedTurnId,
  ]);
  const localBranchRefs = useEnvironmentQuery(
    selectedTurnId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "local",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const remoteBranchRefs = useEnvironmentQuery(
    selectedTurnId === null &&
      selectedGitScope === "branch" &&
      activeThread &&
      branchDiffPreview.data?.cwd
      ? vcsEnvironment.listRefs({
          environmentId: activeThread.environmentId,
          input: {
            cwd: branchDiffPreview.data.cwd,
            includeMatchingRemoteRefs: true,
            refKind: "remote",
            ...(baseRefQuery.trim().length > 0 ? { query: baseRefQuery.trim() } : {}),
            limit: 100,
          },
        })
      : null,
  );
  const baseRefChoices = buildBaseRefChoices(
    localBranchRefs.data?.refs.filter((ref) => ref.name !== selectedGitSource?.headRef) ?? [],
    remoteBranchRefs.data?.refs ?? [],
  );
  const matchingBaseRefChoices = filterBaseRefChoices(baseRefChoices, baseRefQuery);
  const valueForBaseRefChoice = (choice: (typeof baseRefChoices)[number]) =>
    selectedBaseRef && selectedBaseRef === choice.remote?.name
      ? selectedBaseRef
      : (choice.local?.name ?? choice.remote?.name ?? choice.id);
  const baseRefItems = [AUTOMATIC_BASE_REF, ...baseRefChoices.map(valueForBaseRefChoice)];
  const filteredBaseRefItems = [
    ...(baseRefQuery.trim().length === 0 ? [AUTOMATIC_BASE_REF] : []),
    ...matchingBaseRefChoices.map(valueForBaseRefChoice),
  ];
  const gitDiff = selectedGitSource?.diff;

  const selectedPatch = selectedTurn ? activeCheckpointDiff.data?.diff : gitDiff;
  const isSelectedPatchTruncated = !selectedTurn && selectedGitSource?.truncated === true;
  const isLoadingSelectedPatch = selectedTurn
    ? activeCheckpointDiff.isPending
    : branchDiffPreview.isPending;
  const selectedPatchError = selectedTurn ? activeCheckpointDiff.error : branchDiffPreview.error;
  const hasResolvedPatch = typeof selectedPatch === "string";
  const hasNoNetChanges = hasResolvedPatch && selectedPatch.trim().length === 0;
  const renderablePatch = useMemo(
    () =>
      getRenderablePatch(selectedPatch, `diff-panel:${resolvedTheme}`, {
        compactPartialHunkOffsets: selectedTurnId === null,
      }),
    [resolvedTheme, selectedPatch, selectedTurnId],
  );
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files.toSorted((left, right) =>
      resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
        numeric: true,
        sensitivity: "base",
      }),
    );
  }, [renderablePatch]);
  const renderableFileEntries = useMemo(
    () =>
      renderableFiles.map((fileDiff) => ({
        fileDiff,
        fileKey: buildFileDiffRenderKey(fileDiff),
        filePath: resolveFileDiffPath(fileDiff),
        stat: getDiffLineStat([fileDiff]),
      })),
    [renderableFiles],
  );
  const fileRevealKey = selectedFilePath
    ? `${fileSelectionScopeKey}:${selectedFileRevealRequestId}:${selectedFilePath}`
    : null;
  const requestedFilePath =
    fileRevealKey !== null && fileRevealKey !== handledFileRevealKey ? selectedFilePath : null;
  const preferredFilePath =
    requestedFilePath ?? activeFilePathByScope[fileSelectionScopeKey] ?? null;
  const activeFile = resolveActiveDiffFile(renderableFileEntries, preferredFilePath);
  const activeFileIndex = activeFile
    ? renderableFileEntries.findIndex((entry) => entry.filePath === activeFile.filePath)
    : -1;
  const filteredFileEntries = useMemo(
    () => filterDiffFiles(renderableFileEntries, fileQuery),
    [fileQuery, renderableFileEntries],
  );
  const filePathItems = useMemo(
    () => renderableFileEntries.map((entry) => entry.filePath),
    [renderableFileEntries],
  );
  const filteredFilePathItems = useMemo(
    () => filteredFileEntries.map((entry) => entry.filePath),
    [filteredFileEntries],
  );
  const codeViewFiles = useMemo(
    () =>
      activeFile
        ? [
            {
              fileDiff: activeFile.fileDiff,
              filePath: activeFile.filePath,
              fileKey: activeFile.fileKey,
              collapsed: false,
            },
          ]
        : [],
    [activeFile],
  );
  const codeViewMountKey = fileSelectionScopeKey;

  useEffect(() => {
    if (!activeFile) return;
    setActiveFilePathByScope((current) =>
      current[fileSelectionScopeKey] === activeFile.filePath
        ? current
        : { ...current, [fileSelectionScopeKey]: activeFile.filePath },
    );
    if (fileRevealKey !== null && fileRevealKey !== handledFileRevealKey) {
      setHandledFileRevealKey(fileRevealKey);
    }
  }, [activeFile, fileRevealKey, fileSelectionScopeKey, handledFileRevealKey]);

  useEffect(() => {
    if (!activeFile) return;
    codeViewRef.current?.scrollTo({ type: "item", id: activeFile.fileKey, align: "start" });
  }, [activeFile]);

  const selectActiveFile = useCallback(
    (filePath: string) => {
      setActiveFilePathByScope((current) => ({
        ...current,
        [fileSelectionScopeKey]: filePath,
      }));
    },
    [fileSelectionScopeKey],
  );
  const moveActiveFile = useCallback(
    (direction: -1 | 1) => {
      const nextFile = moveActiveDiffFile(renderableFileEntries, activeFile?.filePath, direction);
      if (nextFile) selectActiveFile(nextFile.filePath);
    },
    [activeFile?.filePath, renderableFileEntries, selectActiveFile],
  );

  const openDiffFile = useCallback(
    (filePath: string) => {
      openDiffFilePrimaryAction({
        threadRef: routeThreadRef,
        filePath,
        activeCwd,
        repositoryRoot: activeRepositoryRoot,
        openInEditor: (targetPath) => {
          void (async () => {
            const result = await openInPreferredEditor(targetPath);
            if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
              console.warn("Failed to open diff file in editor.", {
                operation: "open-diff-file",
                ...(routeThreadRef
                  ? {
                      environmentId: routeThreadRef.environmentId,
                      threadId: routeThreadRef.threadId,
                    }
                  : {}),
                ...safeErrorLogAttributes(squashAtomCommandFailure(result)),
              });
            }
          })();
        },
      });
    },
    [activeCwd, activeRepositoryRoot, openInPreferredEditor, routeThreadRef],
  );
  const previewDiffFile = useCallback(
    (filePath: string) => {
      if (!routeThreadRef || !activeCwd || !environmentHttpBaseUrl) return;
      void (async () => {
        const result = await openFileInPreview({
          threadRef: routeThreadRef,
          filePath: resolvePathLinkTarget(filePath, activeCwd),
          httpBaseUrl: environmentHttpBaseUrl,
          createAssetUrl,
          openPreview,
        });
        if (result._tag === "Success" || isAtomCommandInterrupted(result)) return;
        const error = squashAtomCommandFailure(result);
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Unable to open file in preview",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
      })();
    },
    [activeCwd, createAssetUrl, environmentHttpBaseUrl, openPreview, routeThreadRef],
  );
  const selectTurn = (turnId: TurnId) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectTurn(routeThreadRef, turnId);
  };
  const selectGitScope = (scope: "branch" | "unstaged") => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectGitScope(routeThreadRef, scope);
  };
  const selectBranchBaseRef = (baseRef: string | null) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectBranchBaseRef(routeThreadRef, baseRef);
  };

  const headerRow = (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3 [-webkit-app-region:no-drag]">
        <DropdownMenu>
          <DropdownMenuTrigger
            className="inline-flex h-6 max-w-full items-center gap-1 rounded-md bg-accent px-2 text-xs font-medium text-accent-foreground outline-none transition-colors hover:bg-accent/80 focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={`Diff scope: ${selectedScopeLabel}`}
          >
            <span className="truncate">{selectedScopeLabel}</span>
            <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-60">
            <DropdownMenuItem
              className={
                selectedTurnId === null && selectedGitScope === "unstaged"
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => selectGitScope("unstaged")}
            >
              <span>Working tree</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedTurnId === null && selectedGitScope === "branch"
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => selectGitScope("branch")}
            >
              <span>Branch changes</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className={
                selectedTurnId !== null && selectedTurn?.turnId === latestTurn?.turnId
                  ? "bg-foreground/[0.08]"
                  : undefined
              }
              onClick={() => {
                if (latestTurn) selectTurn(latestTurn.turnId);
              }}
            >
              <span>Latest turn</span>
            </DropdownMenuItem>
            <DropdownMenuSub>
              <DropdownMenuSubTrigger>Turn</DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-64">
                {orderedTurnDiffSummaries.map((summary) => {
                  const turnCount =
                    summary.checkpointTurnCount ??
                    inferredCheckpointTurnCountByTurnId[summary.turnId] ??
                    "?";
                  return (
                    <DropdownMenuItem
                      key={summary.turnId}
                      className={
                        summary.turnId === selectedTurn?.turnId ? "bg-foreground/[0.08]" : undefined
                      }
                      onClick={() => selectTurn(summary.turnId)}
                    >
                      <span>Turn {turnCount}</span>
                      <span className="ml-auto text-xs tabular-nums text-muted-foreground">
                        {formatShortTimestamp(summary.completedAt, settings.timestampFormat)}
                      </span>
                    </DropdownMenuItem>
                  );
                })}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          </DropdownMenuContent>
        </DropdownMenu>
        {selectedTurnId === null && selectedGitScope === "branch" && selectedGitSource?.baseRef && (
          <div
            className="flex min-w-0 max-w-full items-center gap-2 overflow-hidden text-xs text-muted-foreground"
            aria-label={`Comparing ${selectedGitSource.headRef ?? "HEAD"} against ${selectedGitSource.baseRef}`}
          >
            <Tooltip>
              <TooltipTrigger render={<span className="flex min-w-0 items-center gap-2" />}>
                <span className="min-w-0 max-w-48 truncate">
                  {selectedGitSource.headRef ?? "HEAD"}
                </span>
                <ArrowRightIcon className="size-3.5 shrink-0 opacity-70" />
              </TooltipTrigger>
              <TooltipPopup side="top">
                {`${selectedGitSource.headRef ?? "HEAD"} → ${selectedGitSource.baseRef}`}
              </TooltipPopup>
            </Tooltip>
            <Combobox
              items={baseRefItems}
              filteredItems={filteredBaseRefItems}
              value={selectedBaseRef ?? AUTOMATIC_BASE_REF}
              onOpenChange={(open) => {
                if (!open) setBaseRefQuery("");
              }}
              onValueChange={(value) => {
                if (!value) return;
                selectBranchBaseRef(value === AUTOMATIC_BASE_REF ? null : value);
              }}
            >
              <ComboboxTrigger
                className="inline-flex min-w-0 max-w-48 items-center gap-1 overflow-hidden rounded-md px-1.5 py-1 outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={`Change comparison target. Currently ${selectedGitSource.baseRef}`}
              >
                <span className="min-w-0 truncate">{selectedGitSource.baseRef}</span>
                <ChevronDownIcon className="size-3.5 shrink-0 opacity-70" />
              </ComboboxTrigger>
              <ComboboxPopup
                align="start"
                className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden [&>[data-slot=combobox-popup]]:min-w-0 [&>[data-slot=combobox-popup]]:overflow-hidden"
              >
                <div className="min-w-0 shrink-0 px-3 pt-2.5">
                  <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
                    <SearchIcon
                      aria-hidden="true"
                      className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
                    />
                    <ComboboxInput
                      className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
                      inputClassName="rounded-none bg-transparent text-sm"
                      placeholder="Search refs..."
                      showTrigger={false}
                      size="sm"
                      unstyled
                      value={baseRefQuery}
                      onChange={(event) => setBaseRefQuery(event.target.value)}
                    />
                  </div>
                </div>
                <div className="grid shrink-0 grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 border-b border-border/70 ps-3 pe-6.5 pt-2 pb-1.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wide">
                  <span aria-hidden="true" />
                  <div className="grid min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center">
                    <span>Branch</span>
                    <span className="text-right">Remote</span>
                  </div>
                </div>
                <ComboboxEmpty>No matching refs.</ComboboxEmpty>
                <ComboboxList className="max-h-64 min-w-0 overflow-x-hidden">
                  <ComboboxItem
                    className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                    contentClassName="w-full min-w-0 overflow-hidden"
                    value={AUTOMATIC_BASE_REF}
                  >
                    <span className="block min-w-0 truncate">Automatic</span>
                  </ComboboxItem>
                  {baseRefChoices.map((choice) => {
                    const item = valueForBaseRefChoice(choice);
                    const hasBoth = choice.local !== null && choice.remote !== null;
                    const useRemote = choice.remote?.name === item;
                    return (
                      <ComboboxItem
                        key={choice.id}
                        className="h-8 w-full min-w-0 grid-cols-[1rem_minmax(0,1fr)] py-0"
                        contentClassName="w-full min-w-0 overflow-hidden"
                        value={item}
                      >
                        <div className="grid w-full min-w-0 grid-cols-[minmax(0,1fr)_2rem] items-center overflow-hidden">
                          <span className="block min-w-0 truncate pe-2">{choice.label}</span>
                          {hasBoth ? (
                            <div
                              className="flex justify-end"
                              onClick={(event) => event.stopPropagation()}
                              onPointerDown={(event) => event.stopPropagation()}
                            >
                              <Switch
                                aria-label={`Use remote version of ${choice.label}`}
                                checked={useRemote}
                                className="[--thumb-size:--spacing(3)]"
                                onCheckedChange={(checked) => {
                                  const nextRef = checked
                                    ? choice.remote?.name
                                    : choice.local?.name;
                                  if (nextRef) selectBranchBaseRef(nextRef);
                                }}
                              />
                            </div>
                          ) : choice.remote ? (
                            <Tooltip>
                              <TooltipTrigger
                                render={
                                  <span className="flex justify-end text-muted-foreground">
                                    <CheckIcon
                                      role="img"
                                      aria-label="Remote only"
                                      className="size-3"
                                    />
                                  </span>
                                }
                              />
                              <TooltipPopup side="top">Remote only</TooltipPopup>
                            </Tooltip>
                          ) : null}
                        </div>
                      </ComboboxItem>
                    );
                  })}
                </ComboboxList>
              </ComboboxPopup>
            </Combobox>
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1 [-webkit-app-region:no-drag]">
        {canRefreshGitDiff && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={branchDiffPreview.isPending ? "Refreshing diff" : "Refresh diff"}
                  onClick={refreshBranchDiffPreview}
                />
              }
            >
              <RefreshCwIcon
                className={cn("size-3.5", branchDiffPreview.isPending && "animate-spin")}
              />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {branchDiffPreview.isPending ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        <ToggleGroup
          className="shrink-0 gap-1"
          size="sm"
          value={[diffRenderMode]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "unified" || next === "split") {
              setDiffRenderModeByWidth((current) => ({ ...current, [widthClass]: next }));
            }
          }}
        >
          <Toggle aria-label="Unified diff view" value="unified" variant="ghost">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split" variant="ghost">
            <Columns2Icon className="size-3.5" />
          </Toggle>
        </ToggleGroup>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={wordWrap ? "Disable diff line wrapping" : "Enable diff line wrapping"}
                variant="ghost"
                size="sm"
                pressed={wordWrap}
                onPressedChange={(pressed) => {
                  setWordWrap(Boolean(pressed));
                }}
              />
            }
          >
            <TextWrapIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {wordWrap ? "Disable line wrapping" : "Enable line wrapping"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"
                }
                variant="ghost"
                size="sm"
                pressed={diffIgnoreWhitespace}
                onPressedChange={(pressed) => {
                  setDiffIgnoreWhitespace(Boolean(pressed));
                }}
              />
            }
          >
            <PilcrowIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffIgnoreWhitespace ? "Show whitespace changes" : "Hide whitespace changes"}
          </TooltipPopup>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={diffExpandUnchanged ? "Collapse unchanged lines" : "Show full files"}
                variant="ghost"
                size="sm"
                pressed={diffExpandUnchanged}
                onPressedChange={(pressed) => {
                  setDiffExpandUnchanged(Boolean(pressed));
                }}
              />
            }
          >
            <UnfoldVerticalIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {diffExpandUnchanged ? "Collapse unchanged lines" : "Show full files"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </>
  );

  const fileNavigationRow = activeFile ? (
    <div className="flex h-10 shrink-0 items-center gap-1 border-b border-border/70 px-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Previous changed file"
              onClick={() => moveActiveFile(-1)}
            />
          }
        >
          <ChevronLeftIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="top">Previous changed file (J)</TooltipPopup>
      </Tooltip>
      <Combobox
        items={filePathItems}
        filteredItems={filteredFilePathItems}
        value={activeFile.filePath}
        onOpenChange={(open) => {
          if (!open) setFileQuery("");
        }}
        onValueChange={(filePath) => {
          if (filePath) selectActiveFile(filePath);
        }}
      >
        <ComboboxTrigger
          className="flex h-7 min-w-0 flex-1 items-center justify-center gap-1 rounded-md px-2 font-mono text-[11px] text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={`Select changed file. Currently ${activeFile.filePath}`}
        >
          <span className="truncate">{activeFile.filePath}</span>
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        </ComboboxTrigger>
        <ComboboxPopup
          align="start"
          className="w-96 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden [&>[data-slot=combobox-popup]]:min-w-0 [&>[data-slot=combobox-popup]]:overflow-hidden"
        >
          <div className="shrink-0 border-b border-border/70 px-3 pt-2.5 pb-2">
            <div className="mb-2 font-medium text-xs">Changed files</div>
            <ComboboxInput
              inputClassName="h-7 bg-background/50 text-xs"
              placeholder="Filter changed files..."
              showTrigger={false}
              size="sm"
              value={fileQuery}
              onChange={(event) => setFileQuery(event.target.value)}
              startAddon={<SearchIcon className="size-3.5" />}
            />
          </div>
          <ComboboxEmpty>No matching changed files.</ComboboxEmpty>
          <ComboboxList className="max-h-80 overflow-x-hidden">
            {renderableFileEntries.map((entry) => (
              <ComboboxItem
                key={entry.fileKey}
                className="min-h-11 py-1.5"
                contentClassName="grid min-w-0 grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2"
                value={entry.filePath}
              >
                <PierreEntryIcon
                  pathValue={entry.filePath}
                  kind="file"
                  theme={resolvedTheme}
                  className="size-3.5"
                />
                <span className="min-w-0">
                  <span className="block truncate font-mono text-xs text-foreground">
                    {diffFileName(entry.filePath)}
                  </span>
                  <span className="block truncate font-mono text-[10px] text-muted-foreground">
                    {diffFileDirectory(entry.filePath)}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {diffFileStatus(entry.fileDiff.type)}
                  </span>
                  <DiffStatLabel
                    additions={entry.stat.additions}
                    deletions={entry.stat.deletions}
                    className="text-[10px]"
                    layout="inline"
                  />
                </span>
              </ComboboxItem>
            ))}
          </ComboboxList>
          <div className="border-t border-border/70 px-3 py-2 text-[10px] text-muted-foreground">
            ↑↓ Navigate · Enter Open · Esc Close
          </div>
        </ComboboxPopup>
      </Combobox>
      <span className="shrink-0 px-1 text-[10px] tabular-nums text-muted-foreground">
        {activeFileIndex + 1} of {renderableFileEntries.length}
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-sm"
              variant="ghost"
              aria-label="Next changed file"
              onClick={() => moveActiveFile(1)}
            />
          }
        >
          <ChevronRightIcon className="size-4" />
        </TooltipTrigger>
        <TooltipPopup side="top">Next changed file (K)</TooltipPopup>
      </Tooltip>
      <DiffStatLabel
        additions={activeFile.stat.additions}
        deletions={activeFile.stat.deletions}
        className="hidden text-[10px] min-[560px]:inline-flex"
        layout="inline"
      />
    </div>
  ) : null;

  return (
    <DiffPanelShell mode={mode} header={headerRow}>
      {!activeThread ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Select a thread to inspect turn diffs.
        </div>
      ) : !isGitRepo ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          Turn diffs are unavailable because this project is not a git repository.
        </div>
      ) : selectedTurnId !== null && orderedTurnDiffSummaries.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-5 text-center text-xs text-muted-foreground/70">
          No completed turns yet.
        </div>
      ) : (
        <>
          <div
            ref={diffPanelViewportRef}
            className="diff-panel-viewport flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden outline-none"
            tabIndex={0}
            aria-label="Changed file diff. Press J for the previous file or K for the next file."
            onKeyDown={(event) => {
              if (event.metaKey || event.ctrlKey || event.altKey) return;
              const target = event.target;
              if (
                target instanceof HTMLElement &&
                target.closest("input, textarea, select, button, [contenteditable='true']")
              ) {
                return;
              }
              if (event.key.toLocaleLowerCase() === "j") {
                event.preventDefault();
                moveActiveFile(-1);
              } else if (event.key.toLocaleLowerCase() === "k") {
                event.preventDefault();
                moveActiveFile(1);
              }
            }}
          >
            {isSelectedPatchTruncated && (
              <p className="shrink-0 border-b border-border/70 bg-muted/40 px-3 py-1.5 text-[11px] text-muted-foreground">
                This diff was truncated because it exceeded the preview limit. The changes shown are
                incomplete.
              </p>
            )}
            {selectedPatchError && !renderablePatch && (
              <div className="px-3">
                <p className="mb-2 text-[11px] text-error/80">{selectedPatchError}</p>
              </div>
            )}
            {renderablePatch?.kind === "files" ? fileNavigationRow : null}
            {!renderablePatch ? (
              isLoadingSelectedPatch ? (
                <DiffPanelLoadingState
                  label={
                    selectedTurn
                      ? "Loading checkpoint diff..."
                      : selectedGitScope === "unstaged"
                        ? "Loading working tree diff..."
                        : "Loading branch diff..."
                  }
                />
              ) : (
                <div className="flex h-full items-center justify-center px-3 py-2 text-xs text-muted-foreground/70">
                  <p>
                    {hasNoNetChanges
                      ? "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              <div
                className="min-h-0 flex-1"
                onClickCapture={(event) => {
                  const composedPath = event.nativeEvent.composedPath?.() ?? [];
                  for (const node of composedPath) {
                    if (!(node instanceof HTMLElement)) continue;
                    // Header controls keep their own actions. In particular, the chevron must
                    // not also trigger the row handler or the two toggles cancel each other.
                    if (node instanceof HTMLButtonElement || node instanceof HTMLAnchorElement) {
                      return;
                    }
                  }
                  const title = composedPath.find(
                    (node): node is HTMLElement =>
                      node instanceof HTMLElement && node.hasAttribute("data-title"),
                  );
                  const filePath = title?.textContent?.trim();
                  // The filename remains the explicit "open in editor" affordance.
                  if (filePath) {
                    openDiffFile(filePath);
                  }
                }}
              >
                <AnnotatableCodeView
                  key={codeViewMountKey}
                  viewerRef={codeViewRef}
                  codeViewKey={codeViewMountKey}
                  className="h-full min-h-0 overflow-auto"
                  files={codeViewFiles}
                  sectionId={reviewSectionId}
                  sectionTitle={reviewSectionTitle}
                  composerDraftTarget={composerDraftTarget}
                  renderHeaderPrefix={(fileDiff) => {
                    const filePath = resolveFileDiffPath(fileDiff);
                    return (
                      <PierreEntryIcon
                        pathValue={filePath}
                        kind="file"
                        theme={resolvedTheme}
                        className="ms-0.5 size-3.5"
                      />
                    );
                  }}
                  renderHeaderFilenameSuffix={(fileDiff) => {
                    const filePath = resolveFileDiffPath(fileDiff);
                    const canPreview =
                      fileDiff.type !== "deleted" &&
                      routeThreadRef !== null &&
                      activeCwd !== undefined &&
                      environmentHttpBaseUrl !== null &&
                      isPreviewSupportedInRuntime() &&
                      isBrowserPreviewFile(filePath);
                    return (
                      <div className="ms-1 inline-flex items-center gap-0.5">
                        <Tooltip>
                          <TooltipTrigger
                            render={
                              <button
                                type="button"
                                className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden"
                                aria-label={`Open ${filePath}`}
                                onClick={(event) => {
                                  event.stopPropagation();
                                  openDiffFile(filePath);
                                }}
                              >
                                <FileCode2Icon className="size-3.5" />
                              </button>
                            }
                          />
                          <TooltipPopup>Open file</TooltipPopup>
                        </Tooltip>
                        {canPreview ? (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <button
                                  type="button"
                                  className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden"
                                  aria-label={`Preview ${filePath}`}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    previewDiffFile(filePath);
                                  }}
                                >
                                  <Globe2Icon className="size-3.5" />
                                </button>
                              }
                            />
                            <TooltipPopup>Open file in preview</TooltipPopup>
                          </Tooltip>
                        ) : null}
                      </div>
                    );
                  }}
                  options={{
                    diffStyle: diffRenderMode,
                    expandUnchanged: diffExpandUnchanged,
                    lineDiffType: "none",
                    overflow: wordWrap ? "wrap" : "scroll",
                    theme: resolveDiffThemeName(resolvedTheme),
                    themeType: resolvedTheme as DiffThemeType,
                    stickyHeaders: true,
                    ...(loadDiffFiles ? { loadDiffFiles } : {}),
                  }}
                />
              </div>
            ) : (
              <div className="min-h-0 flex-1 overflow-auto p-2">
                <div className="space-y-2">
                  <p className="text-[11px] text-muted-foreground/75">{renderablePatch.reason}</p>
                  <pre
                    className={cn(
                      "max-h-[72vh] rounded-md border border-border/70 bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground/90",
                      wordWrap
                        ? "overflow-auto whitespace-pre-wrap wrap-break-word"
                        : "overflow-auto",
                    )}
                  >
                    {renderablePatch.text}
                  </pre>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </DiffPanelShell>
  );
}
