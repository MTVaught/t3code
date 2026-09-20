import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useAtomValue } from "@effect/atom-react";
import type { FileDiffContentsLoader, FileDiffMetadata } from "@pierre/diffs";
import { useParams } from "@tanstack/react-router";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { safeErrorLogAttributes } from "@t3tools/client-runtime/errors";
import type { ReviewWorkingTreeFilter, ScopedThreadRef, TurnId } from "@t3tools/contracts";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsDownUpIcon,
  ChevronsUpDownIcon,
  Columns2Icon,
  FileCode2Icon,
  FlagIcon,
  FolderTreeIcon,
  Globe2Icon,
  MinusIcon,
  PilcrowIcon,
  PlusIcon,
  Rows3Icon,
  SearchIcon,
  TextWrapIcon,
  UnfoldVerticalIcon,
} from "lucide-react";
import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCodeViewFileReveal } from "./diffs/useCodeViewFileReveal";
import { useOpenInPreferredEditor } from "../editorPreferences";
import { type DraftId } from "../composerDraftStore";
import { openDiffFilePrimaryAction } from "../diffFileActions";
import { useCheckpointDiff } from "~/lib/checkpointDiffState";
import { cn } from "~/lib/utils";
import {
  selectThreadDiffPanelSelection,
  selectThreadWorkingTreeFilter,
  useDiffPanelStore,
} from "../diffPanelStore";
import { useLocalStorage } from "../hooks/useLocalStorage";
import { useTheme } from "../hooks/useTheme";
import {
  buildFileDiffContentVersion,
  buildFileDiffIdentityKey,
  getDiffCollapseIconClassName,
  getDiffLineStat,
  getRenderablePatch,
  resolveDiffThemeName,
  resolveFileDiffPath,
} from "../lib/diffRendering";
import { PREFERRED_HIGHLIGHTER } from "../lib/syntaxHighlighting";
import { areAllDiffFilesCollapsed, toggleAllDiffFiles } from "../lib/diffCollapse";
import {
  filterDiffFiles,
  moveActiveDiffFile,
  resolveActiveDiffFile,
} from "../lib/diffFileNavigation";
import { useTurnDiffSummaries } from "../hooks/useTurnDiffSummaries";
import { useWorkspaceMutationRefresh } from "../hooks/useWorkspaceMutationRefresh";
import { useProject, useThread } from "../state/entities";
import { threadEnvironment } from "../state/threads";
import { resolveThreadRouteRef } from "../threadRoutes";
import { useClientSettings, useUpdateClientSettings } from "../hooks/useSettings";
import { formatShortTimestamp } from "../timestampFormat";
import { DiffFilePathCopyButton } from "./DiffFilePathCopyButton";
import { DiffPanelLoadingState, DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DiffStatLabel } from "./chat/DiffStatLabel";
import { PierreEntryIcon } from "./chat/PierreEntryIcon";
import { AnnotatableCodeView, type AnnotatableCodeViewHandle } from "./diffs/AnnotatableCodeView";
import { DiffFileTree } from "./diffs/DiffFileTree";
import { diffFileTreeEntries } from "./diffs/diffFileTree.logic";
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

type DiffThemeType = "light" | "dark";
const AUTOMATIC_BASE_REF = "__automatic_base_ref__";
const DIFF_FILE_TREE_STORAGE_KEY = "t3code.diffFileTreeOpen";

interface CollapsedDiffFilesState {
  readonly scopeKey: string | null;
  readonly fileKeys: ReadonlySet<string>;
}

const EMPTY_COLLAPSED_DIFF_FILE_KEYS: ReadonlySet<string> = new Set();
const EMPTY_PATH_SET: ReadonlySet<string> = new Set();
const WORKING_TREE_FILTERS: ReadonlyArray<{ value: ReviewWorkingTreeFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "unstaged", label: "Unstaged" },
  { value: "staged", label: "Staged" },
];

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
    default:
      return "M";
  }
}

interface DiffPanelProps {
  mode?: DiffPanelMode;
  composerDraftTarget: ScopedThreadRef | DraftId;
  initialGitScope: "branch" | "unstaged";
  workspaceMutationId: string | null;
}

export default function DiffPanel({
  mode = "inline",
  composerDraftTarget,
  initialGitScope: initialGitScopeProp,
  workspaceMutationId,
}: DiffPanelProps) {
  const { resolvedTheme } = useTheme();
  const settings = useClientSettings();
  const [initialGitScope] = useState(initialGitScopeProp);
  const diffLayout = settings.diffLayout;
  const updateClientSettings = useUpdateClientSettings();
  const [wordWrap, setWordWrap] = useState(settings.wordWrap);
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = useState(settings.diffIgnoreWhitespace);
  const [diffExpandUnchanged, setDiffExpandUnchanged] = useState(settings.diffExpandUnchanged);
  const [fileQuery, setFileQuery] = useState("");
  const [activeFilePathByScope, setActiveFilePathByScope] = useState<Record<string, string>>({});
  const [fileTreeOpen, setFileTreeOpen] = useLocalStorage(
    DIFF_FILE_TREE_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const [baseRefQuery, setBaseRefQuery] = useState("");
  const [collapsedDiffFiles, setCollapsedDiffFiles] = useState<CollapsedDiffFilesState>(() => ({
    scopeKey: null,
    fileKeys: EMPTY_COLLAPSED_DIFF_FILE_KEYS,
  }));
  const [codeViewRevision, setCodeViewRevision] = useState(0);
  const [codeView, setCodeView] = useState<AnnotatableCodeViewHandle | null>(null);

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
  const workingTreeFilter = useDiffPanelStore((state) =>
    selectThreadWorkingTreeFilter(state.workingTreeFilterByThreadKey, routeThreadRef),
  );
  const stagePaths = useAtomCommand(vcsEnvironment.stagePaths, { reportFailure: false });
  const flagReviewFile = useAtomCommand(threadEnvironment.flagReviewFile, {
    reportFailure: false,
  });
  const unflagReviewFile = useAtomCommand(threadEnvironment.unflagReviewFile, {
    reportFailure: false,
  });
  const [pendingStagePaths, setPendingStagePaths] = useState<ReadonlySet<string>>(EMPTY_PATH_SET);
  // Files a filtered view drops as soon as they are staged or unstaged, so the reader is not
  // left waiting on the server to regenerate the preview. Each entry holds the server time the
  // index change completed (null while in flight); the file stays hidden until a preview
  // generated after that time lands, so a refresh already in flight cannot bring it back.
  const [hiddenStagedFiles, setHiddenStagedFiles] = useState<{
    readonly scopeKey: string | null;
    readonly entries: ReadonlyMap<string, number | null>;
  }>({ scopeKey: null, entries: new Map() });
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
  const isWorkingTreeScope = selectedTurnId === null && selectedGitScope === "unstaged";
  // Filtered views show different hunks for the same file, so comments and collapse state
  // must not bleed between them.
  const activeWorkingTreeFilter = isWorkingTreeScope ? workingTreeFilter : "all";
  const reviewSectionId = selectedTurn
    ? `turn:${selectedTurn.turnId}`
    : activeWorkingTreeFilter === "all"
      ? selectedGitScope
      : `${selectedGitScope}:${activeWorkingTreeFilter}`;
  const collapseScopeKey = routeThreadRef
    ? `${routeThreadRef.environmentId}:${routeThreadRef.threadId}:${reviewSectionId}`
    : null;
  const codeViewMountKey = `${collapseScopeKey ?? reviewSectionId}:${codeViewRevision}`;
  const fileSelectionScopeKey = collapseScopeKey ?? reviewSectionId;
  const reviewSectionTitle = selectedTurn
    ? `Turn ${selectedCheckpointTurnCount ?? "?"}`
    : selectedGitScope === "unstaged"
      ? "Working tree"
      : "Branch changes";
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
            ...(activeWorkingTreeFilter === "all"
              ? {}
              : { workingTreeFilter: activeWorkingTreeFilter }),
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
            ...(activeWorkingTreeFilter === "all"
              ? {}
              : { workingTreeFilter: activeWorkingTreeFilter }),
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
    if (!canRefreshGitDiff) return;
    const refreshOnFocus = () => refreshBranchDiffPreview();
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [canRefreshGitDiff, refreshBranchDiffPreview]);

  useWorkspaceMutationRefresh({
    enabled: canRefreshGitDiff,
    mutationId: workspaceMutationId,
    refresh: refreshBranchDiffPreview,
    resourceKey: `diff:${activeThreadRefreshKey ?? ""}`,
  });

  const selectedGitSource = branchDiffPreview.data?.sources.find(
    (source) => source.kind === (selectedGitScope === "unstaged" ? "working-tree" : "branch-range"),
  );
  const fileStagingByPath = useMemo(
    () => new Map(selectedGitSource?.fileStaging?.map((entry) => [entry.path, entry] as const)),
    [selectedGitSource],
  );
  const currentLoadDiffFiles = useMemo<FileDiffContentsLoader | undefined>(() => {
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
      ...(selectedGitSource.kind === "working-tree" && activeWorkingTreeFilter !== "all"
        ? { workingTreeFilter: activeWorkingTreeFilter }
        : {}),
      cacheKey: `${activeWorkingTreeFilter}:${selectedGitSource.diffHash}`,
    });
  }, [
    activeThread,
    activeWorkingTreeFilter,
    branchDiffPreview.data,
    getDiffFileContents,
    selectedGitSource,
    selectedTurnId,
  ]);
  const loadDiffFilesRef = useRef(currentLoadDiffFiles);
  loadDiffFilesRef.current = currentLoadDiffFiles;
  const loadDiffFiles = useCallback<FileDiffContentsLoader>(async (fileDiff) => {
    const loader = loadDiffFilesRef.current;
    if (!loader) throw new Error("Diff file contents are unavailable for this selection.");
    return loader(fileDiff);
  }, []);
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
  const previewGeneratedAt = branchDiffPreview.data
    ? DateTime.toEpochMillis(branchDiffPreview.data.generatedAt)
    : null;
  const hiddenFilePaths = useMemo(() => {
    if (hiddenStagedFiles.scopeKey !== fileSelectionScopeKey) return EMPTY_PATH_SET;
    const paths = new Set<string>();
    for (const [path, completedAt] of hiddenStagedFiles.entries) {
      if (completedAt === null || previewGeneratedAt === null || previewGeneratedAt < completedAt) {
        paths.add(path);
      }
    }
    return paths;
  }, [fileSelectionScopeKey, hiddenStagedFiles, previewGeneratedAt]);
  const renderableFiles = useMemo(() => {
    if (!renderablePatch || renderablePatch.kind !== "files") {
      return [];
    }
    return renderablePatch.files
      .filter((fileDiff) => !hiddenFilePaths.has(resolveFileDiffPath(fileDiff)))
      .toSorted((left, right) =>
        resolveFileDiffPath(left).localeCompare(resolveFileDiffPath(right), undefined, {
          numeric: true,
          sensitivity: "base",
        }),
      );
  }, [hiddenFilePaths, renderablePatch]);
  const renderableFileEntries = useMemo(
    () =>
      renderableFiles.map((fileDiff) => ({
        fileDiff,
        fileKey: buildFileDiffIdentityKey(fileDiff),
        fileVersion: buildFileDiffContentVersion(fileDiff),
        filePath: resolveFileDiffPath(fileDiff),
        stat: getDiffLineStat([fileDiff]),
      })),
    [renderableFiles],
  );
  const defaultCollapsedDiffFileKeys = useMemo(
    () =>
      settings.diffFilesCollapsed
        ? new Set(renderableFileEntries.map((file) => file.fileKey))
        : EMPTY_COLLAPSED_DIFF_FILE_KEYS,
    [renderableFileEntries, settings.diffFilesCollapsed],
  );
  const collapsedDiffFileKeys =
    collapsedDiffFiles.scopeKey === collapseScopeKey
      ? collapsedDiffFiles.fileKeys
      : defaultCollapsedDiffFileKeys;
  const codeViewFiles = useMemo(
    () =>
      renderableFileEntries.map(({ fileDiff, fileKey, fileVersion, filePath }) => {
        return {
          fileDiff,
          filePath,
          fileKey,
          fileVersion,
          collapsed: collapsedDiffFileKeys.has(fileKey),
        };
      }),
    [collapsedDiffFileKeys, renderableFileEntries],
  );
  // Prev/next navigation tracks one "active" file per review scope. A reveal
  // request from the timeline or the file tree moves it; J/K step through it.
  const activeFile = resolveActiveDiffFile(
    renderableFileEntries,
    activeFilePathByScope[fileSelectionScopeKey] ?? selectedFilePath,
  );
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
  const diffFileKeys = useMemo(() => codeViewFiles.map((file) => file.fileKey), [codeViewFiles]);
  const allDiffFilesCollapsed = areAllDiffFilesCollapsed(diffFileKeys, collapsedDiffFileKeys);
  const diffLineStat = useMemo(() => getDiffLineStat(renderableFiles), [renderableFiles]);
  const fileTreeEntries = useMemo(() => diffFileTreeEntries(renderableFiles), [renderableFiles]);
  const selectedDiffFileKey = selectedFilePath
    ? (codeViewFiles.find((candidate) => candidate.filePath === selectedFilePath)?.fileKey ?? null)
    : null;

  useEffect(() => {
    if (!selectedDiffFileKey || !codeView?.getInstance()) return;
    codeView.scrollTo({ type: "item", id: selectedDiffFileKey, align: "start" });
  }, [codeView, codeViewMountKey, selectedDiffFileKey, selectedFileRevealRequestId]);

  useEffect(() => {
    if (!selectedFilePath) return;
    setActiveFilePathByScope((current) =>
      current[fileSelectionScopeKey] === selectedFilePath
        ? current
        : { ...current, [fileSelectionScopeKey]: selectedFilePath },
    );
  }, [fileSelectionScopeKey, selectedFilePath, selectedFileRevealRequestId]);

  const treeRevealScope = useMemo(
    () => ({ collapseScopeKey, diffSelection }),
    [collapseScopeKey, diffSelection],
  );
  const requestTreeReveal = useCodeViewFileReveal(codeView, treeRevealScope);
  const revealDiffFile = useCallback(
    (filePath: string) => {
      const file = codeViewFiles.find((candidate) => candidate.filePath === filePath);
      if (!file) return;
      if (file.collapsed) {
        setCollapsedDiffFiles((current) => {
          const next = new Set(
            current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys,
          );
          next.delete(file.fileKey);
          return { scopeKey: collapseScopeKey, fileKeys: next };
        });
      }
      requestTreeReveal(file.fileKey);
    },
    [codeViewFiles, collapseScopeKey, defaultCollapsedDiffFileKeys, requestTreeReveal],
  );
  const selectActiveFile = useCallback(
    (filePath: string) => {
      setActiveFilePathByScope((current) => ({
        ...current,
        [fileSelectionScopeKey]: filePath,
      }));
      revealDiffFile(filePath);
    },
    [fileSelectionScopeKey, revealDiffFile],
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
          workspaceRoot: activeCwd,
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
  const toggleDiffFileCollapsed = useCallback(
    (fileKey: string) => {
      setCollapsedDiffFiles((current) => {
        const next = new Set(
          current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys,
        );
        if (next.has(fileKey)) {
          next.delete(fileKey);
        } else {
          next.add(fileKey);
        }
        return { scopeKey: collapseScopeKey, fileKeys: next };
      });
    },
    [collapseScopeKey, defaultCollapsedDiffFileKeys],
  );

  const toggleDiffFileCollapse = useCallback(() => {
    setCodeViewRevision((current) => current + 1);
    setCollapsedDiffFiles((current) => {
      const currentKeys =
        current.scopeKey === collapseScopeKey ? current.fileKeys : defaultCollapsedDiffFileKeys;

      return {
        scopeKey: collapseScopeKey,
        fileKeys: toggleAllDiffFiles(diffFileKeys, currentKeys),
      };
    });
  }, [collapseScopeKey, defaultCollapsedDiffFileKeys, diffFileKeys]);

  const previewCwd = branchDiffPreview.data?.cwd ?? activeCwd;
  const setPathsStaged = useCallback(
    (paths: ReadonlyArray<string>, staged: boolean) => {
      if (!activeThread || !previewCwd || paths.length === 0) return;
      const environmentId = activeThread.environmentId;
      setPendingStagePaths((current) => new Set([...current, ...paths]));
      const leavesFilteredView =
        (workingTreeFilter === "unstaged" && staged) || (workingTreeFilter === "staged" && !staged);
      const scopeKey = fileSelectionScopeKey;
      const updateHiddenFiles = (update: (entries: Map<string, number | null>) => void) =>
        setHiddenStagedFiles((current) => {
          const entries = new Map(current.scopeKey === scopeKey ? current.entries : []);
          update(entries);
          return { scopeKey, entries };
        });
      if (leavesFilteredView) {
        updateHiddenFiles((entries) => {
          for (const path of paths) entries.set(path, null);
        });
      }
      void (async () => {
        const result = await stagePaths({
          environmentId,
          input: { cwd: previewCwd, paths, staged },
        });
        setPendingStagePaths((current) => {
          const next = new Set(current);
          for (const path of paths) next.delete(path);
          return next;
        });
        if (leavesFilteredView) {
          updateHiddenFiles((entries) => {
            for (const path of paths) {
              if (result._tag === "Success") {
                entries.set(path, DateTime.toEpochMillis(result.value.completedAt));
              } else {
                entries.delete(path);
              }
            }
          });
        }
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: staged ? "Unable to stage files" : "Unable to unstage files",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
        refreshBranchDiffPreview();
      })();
    },
    [
      activeThread,
      fileSelectionScopeKey,
      previewCwd,
      refreshBranchDiffPreview,
      stagePaths,
      workingTreeFilter,
    ],
  );
  // Files the reviewer flagged as still needing follow-up. The flag lives on the thread, so
  // it survives reloads and shows on every device; it blocks staging until cleared.
  const followUpPaths = useMemo(
    () => new Set(activeThread?.reviewFollowUpPaths ?? []),
    [activeThread?.reviewFollowUpPaths],
  );
  const toggleFollowUp = useCallback(
    (filePath: string) => {
      if (!activeThread) return;
      const flagged = followUpPaths.has(filePath);
      const request = {
        environmentId: activeThread.environmentId,
        input: { threadId: activeThread.id, paths: [filePath] },
      };
      void (async () => {
        const result = await (flagged ? unflagReviewFile(request) : flagReviewFile(request));
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: flagged ? "Unable to clear follow-up flag" : "Unable to flag for follow-up",
              description: error instanceof Error ? error.message : "An error occurred.",
            }),
          );
        }
      })();
    },
    [activeThread, flagReviewFile, followUpPaths, unflagReviewFile],
  );
  // A file can be staged while it has edits outside the index and unstaged while it has
  // entries in it, so a partially staged file offers both in every view. The filtered views
  // imply one direction even before the index state has arrived.
  const stagingActionsFor = useCallback(
    (filePath: string): ReadonlyArray<"stage" | "unstage"> => {
      const staging = fileStagingByPath.get(filePath);
      const canStage =
        workingTreeFilter === "unstaged" || staging === undefined || staging.unstaged;
      const canUnstage = workingTreeFilter === "staged" || staging?.staged === true;
      return [...(canStage ? ["stage" as const] : []), ...(canUnstage ? ["unstage" as const] : [])];
    },
    [fileStagingByPath, workingTreeFilter],
  );
  const bulkStagingAction = useMemo(() => {
    if (!isWorkingTreeScope || renderableFileEntries.length === 0) return null;
    if (workingTreeFilter === "staged") {
      return { staged: false, paths: renderableFileEntries.map((entry) => entry.filePath) };
    }
    const paths = renderableFileEntries
      .filter(
        (entry) =>
          !followUpPaths.has(entry.filePath) &&
          fileStagingByPath.get(entry.filePath)?.unstaged !== false,
      )
      .map((entry) => entry.filePath);
    return paths.length > 0 ? { staged: true, paths } : null;
  }, [
    fileStagingByPath,
    followUpPaths,
    isWorkingTreeScope,
    renderableFileEntries,
    workingTreeFilter,
  ]);

  const selectTurn = (turnId: TurnId) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectTurn(routeThreadRef, turnId);
  };
  const selectWorkingTreeFilter = (filter: ReviewWorkingTreeFilter) => {
    if (!routeThreadRef) return;
    useDiffPanelStore.getState().selectWorkingTreeFilter(routeThreadRef, filter);
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
        {isWorkingTreeScope && (
          <div className="flex min-w-0 shrink-0 items-center gap-1">
            <ToggleGroup
              aria-label="Working tree filter"
              variant="segmented"
              value={[workingTreeFilter]}
              onValueChange={(value) => {
                const next = WORKING_TREE_FILTERS.find((filter) => filter.value === value[0]);
                if (next) selectWorkingTreeFilter(next.value);
              }}
            >
              {WORKING_TREE_FILTERS.map((filter) => (
                <Toggle
                  key={filter.value}
                  aria-label={`Show ${filter.label.toLocaleLowerCase()} changes`}
                  className="px-1.5 text-[11px]"
                  value={filter.value}
                >
                  {filter.label}
                </Toggle>
              ))}
            </ToggleGroup>
            {bulkStagingAction && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                className="text-[11px] text-muted-foreground hover:text-foreground"
                disabled={bulkStagingAction.paths.some((path) => pendingStagePaths.has(path))}
                onClick={() => setPathsStaged(bulkStagingAction.paths, bulkStagingAction.staged)}
              >
                {bulkStagingAction.staged ? "Stage all" : "Unstage all"}
              </Button>
            )}
          </div>
        )}
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
                className="w-72 min-w-0 max-w-[calc(100vw-1rem)] overflow-hidden"
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
        {codeViewFiles.length > 0 && (
          <DiffStatLabel
            additions={diffLineStat.additions}
            deletions={diffLineStat.deletions}
            className="mr-1 text-[11px]"
            layout="inline"
          />
        )}
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
              <RefreshIcon className="size-3.5" refreshing={branchDiffPreview.isPending} />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {branchDiffPreview.isPending ? "Refreshing diff…" : "Refresh diff"}
            </TooltipPopup>
          </Tooltip>
        )}
        {codeViewFiles.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="icon-sm"
                  variant="ghost"
                  aria-label={allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
                  onClick={toggleDiffFileCollapse}
                />
              }
            >
              {allDiffFilesCollapsed ? (
                <ChevronsUpDownIcon className="size-3.5" />
              ) : (
                <ChevronsDownUpIcon className="size-3.5" />
              )}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {allDiffFilesCollapsed ? "Expand all files" : "Collapse all files"}
            </TooltipPopup>
          </Tooltip>
        )}
        <ToggleGroup
          aria-label="Diff layout"
          className="shrink-0"
          variant="segmented"
          value={[diffLayout]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "stacked" || next === "split") {
              updateClientSettings({ diffLayout: next });
            }
          }}
        >
          <Toggle aria-label="Stacked diff view" value="stacked">
            <Rows3Icon className="size-3.5" />
          </Toggle>
          <Toggle aria-label="Split diff view" value="split">
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
        {codeViewFiles.length > 0 && (
          <Tooltip>
            <TooltipTrigger
              render={
                <Toggle
                  aria-label={fileTreeOpen ? "Hide file tree" : "Show file tree"}
                  variant="ghost"
                  size="sm"
                  pressed={fileTreeOpen}
                  onPressedChange={(pressed) => setFileTreeOpen(Boolean(pressed))}
                />
              }
            >
              <FolderTreeIcon className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">
              {fileTreeOpen ? "Hide file tree" : "Show file tree"}
            </TooltipPopup>
          </Tooltip>
        )}
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
      {isWorkingTreeScope ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Toggle
                aria-label={
                  followUpPaths.has(activeFile.filePath)
                    ? `Clear follow-up flag on ${activeFile.filePath}`
                    : `Flag ${activeFile.filePath} for follow-up`
                }
                variant="ghost"
                size="sm"
                pressed={followUpPaths.has(activeFile.filePath)}
                onPressedChange={() => toggleFollowUp(activeFile.filePath)}
              />
            }
          >
            <FlagIcon className="size-3.5" />
          </TooltipTrigger>
          <TooltipPopup side="top">
            {followUpPaths.has(activeFile.filePath)
              ? "Clear follow-up flag"
              : "Flag for follow-up (blocks staging)"}
          </TooltipPopup>
        </Tooltip>
      ) : null}
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
            className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background outline-none"
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
              const key = event.key.toLocaleLowerCase();
              if (key === "j") {
                event.preventDefault();
                moveActiveFile(-1);
              } else if (key === "k") {
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
                      ? activeWorkingTreeFilter === "staged"
                        ? "No staged changes."
                        : activeWorkingTreeFilter === "unstaged"
                          ? "No unstaged changes."
                          : "No net changes in this selection."
                      : "No patch available for this selection."}
                  </p>
                </div>
              )
            ) : renderablePatch.kind === "files" ? (
              <div className="flex min-h-0 flex-1 overflow-hidden">
                <div className="flex min-h-0 min-w-0 flex-1 flex-col">
                  {fileNavigationRow}
                  <div
                    className="min-h-0 min-w-0 flex-1"
                    onClickCapture={(event) => {
                      const composedPath = event.nativeEvent.composedPath?.() ?? [];
                      for (const node of composedPath) {
                        if (!(node instanceof HTMLElement)) continue;
                        // Header controls keep their own actions. In particular, the chevron must
                        // not also trigger the row handler or the two toggles cancel each other.
                        if (
                          node instanceof HTMLButtonElement ||
                          node instanceof HTMLAnchorElement
                        ) {
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
                        return;
                      }
                      const header = composedPath.find(
                        (node): node is HTMLElement =>
                          node instanceof HTMLElement && node.hasAttribute("data-diffs-header"),
                      );
                      const headerFilePath = header
                        ?.querySelector("[data-title]")
                        ?.textContent?.trim();
                      if (!headerFilePath) return;
                      const file = codeViewFiles.find(
                        (candidate) => candidate.filePath === headerFilePath,
                      );
                      if (file) toggleDiffFileCollapsed(file.fileKey);
                    }}
                  >
                    <AnnotatableCodeView
                      key={collapseScopeKey ?? reviewSectionId}
                      viewerRef={setCodeView}
                      codeViewKey={codeViewMountKey}
                      className="h-full min-h-0 overflow-auto"
                      files={codeViewFiles}
                      sectionId={reviewSectionId}
                      sectionTitle={reviewSectionTitle}
                      composerDraftTarget={composerDraftTarget}
                      renderHeaderFilenameSuffix={(fileDiff) => {
                        const filePath = resolveFileDiffPath(fileDiff);
                        const canPreview =
                          fileDiff.type !== "deleted" &&
                          routeThreadRef !== null &&
                          activeCwd !== undefined &&
                          environmentHttpBaseUrl !== null &&
                          isPreviewSupportedInRuntime() &&
                          isBrowserPreviewFile(filePath);
                        const staging = isWorkingTreeScope
                          ? fileStagingByPath.get(filePath)
                          : undefined;
                        const stagingActions = isWorkingTreeScope
                          ? stagingActionsFor(filePath)
                          : [];
                        const stagingBadge = staging?.staged
                          ? staging.unstaged
                            ? "Partially staged"
                            : "Staged"
                          : null;
                        const flaggedForFollowUp =
                          isWorkingTreeScope && followUpPaths.has(filePath);
                        return (
                          <span className="inline-flex items-center gap-0.5">
                            {flaggedForFollowUp ? (
                              <span className="me-1 rounded-sm bg-warning/15 px-1.5 py-0.5 text-[10px] font-sans font-medium text-warning">
                                Follow-up
                              </span>
                            ) : null}
                            {stagingBadge ? (
                              <span className="me-1 rounded-sm bg-foreground/[0.08] px-1.5 py-0.5 text-[10px] font-sans font-medium text-muted-foreground">
                                {stagingBadge}
                              </span>
                            ) : null}
                            {isWorkingTreeScope ? (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <button
                                      type="button"
                                      className={cn(
                                        "inline-flex size-6 items-center justify-center rounded-sm transition-colors hover:bg-foreground/10 focus-visible:outline-hidden",
                                        flaggedForFollowUp
                                          ? "text-warning hover:text-warning"
                                          : "text-muted-foreground hover:text-foreground",
                                      )}
                                      aria-pressed={flaggedForFollowUp}
                                      aria-label={
                                        flaggedForFollowUp
                                          ? `Clear follow-up flag on ${filePath}`
                                          : `Flag ${filePath} for follow-up`
                                      }
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        toggleFollowUp(filePath);
                                      }}
                                    >
                                      <FlagIcon className="size-3.5" />
                                    </button>
                                  }
                                />
                                <TooltipPopup>
                                  {flaggedForFollowUp
                                    ? "Clear follow-up flag"
                                    : "Flag for follow-up (blocks staging)"}
                                </TooltipPopup>
                              </Tooltip>
                            ) : null}
                            {stagingActions.map((stagingAction) => (
                              <Tooltip key={stagingAction}>
                                <TooltipTrigger
                                  render={
                                    <button
                                      type="button"
                                      className="inline-flex size-6 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-hidden disabled:pointer-events-none disabled:opacity-50"
                                      aria-label={
                                        stagingAction === "stage"
                                          ? `Stage ${filePath}`
                                          : `Unstage ${filePath}`
                                      }
                                      disabled={
                                        pendingStagePaths.has(filePath) ||
                                        (stagingAction === "stage" && flaggedForFollowUp)
                                      }
                                      onClick={(event) => {
                                        event.stopPropagation();
                                        setPathsStaged([filePath], stagingAction === "stage");
                                      }}
                                    >
                                      {stagingAction === "stage" ? (
                                        <PlusIcon className="size-3.5" />
                                      ) : (
                                        <MinusIcon className="size-3.5" />
                                      )}
                                    </button>
                                  }
                                />
                                <TooltipPopup>
                                  {stagingAction === "stage"
                                    ? flaggedForFollowUp
                                      ? "Clear the follow-up flag to stage"
                                      : "Stage file"
                                    : "Unstage file"}
                                </TooltipPopup>
                              </Tooltip>
                            ))}
                            <DiffFilePathCopyButton filePath={filePath} />
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
                          </span>
                        );
                      }}
                      renderHeaderPrefix={(fileDiff, fileKey, collapsed) => {
                        const filePath = resolveFileDiffPath(fileDiff);
                        return (
                          <Tooltip>
                            <TooltipTrigger
                              render={
                                <Button
                                  size="icon-micro"
                                  variant="ghost"
                                  className={cn(
                                    "-ms-0.5 [--control-icon-color:currentColor] bg-transparent hover:bg-foreground/10",
                                    getDiffCollapseIconClassName(fileDiff),
                                  )}
                                  aria-label={
                                    collapsed ? `Expand ${filePath}` : `Collapse ${filePath}`
                                  }
                                  aria-expanded={!collapsed}
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    toggleDiffFileCollapsed(fileKey);
                                  }}
                                />
                              }
                            >
                              {collapsed ? (
                                <ChevronRightIcon className="size-4" />
                              ) : (
                                <ChevronDownIcon className="size-4" />
                              )}
                            </TooltipTrigger>
                            <TooltipPopup side="top">
                              {collapsed ? "Expand diff" : "Collapse diff"}
                            </TooltipPopup>
                          </Tooltip>
                        );
                      }}
                      options={{
                        diffStyle: diffLayout === "split" ? "split" : "unified",
                        expandUnchanged: diffExpandUnchanged,
                        lineDiffType: "none",
                        overflow: wordWrap ? "wrap" : "scroll",
                        theme: resolveDiffThemeName(resolvedTheme),
                        preferredHighlighter: PREFERRED_HIGHLIGHTER,
                        themeType: resolvedTheme as DiffThemeType,
                        stickyHeaders: true,
                        ...(currentLoadDiffFiles ? { loadDiffFiles } : {}),
                      }}
                    />
                  </div>
                </div>
                {fileTreeOpen ? (
                  <aside className="flex w-[min(16rem,40%)] min-w-40 shrink-0 border-l border-border/60">
                    <DiffFileTree
                      ariaLabel={`${reviewSectionTitle} files`}
                      entries={fileTreeEntries}
                      selectedPath={selectedFilePath}
                      revealRequestId={selectedFileRevealRequestId}
                      onSelectFile={selectActiveFile}
                    />
                  </aside>
                ) : null}
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
