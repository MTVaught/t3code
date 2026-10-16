import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { act, type ComponentProps, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vite-plus/test";

const assets = vi.hoisted(() => ({ resources: [] as Array<unknown> }));
vi.mock("../../assets/assetUrls", () => ({
  useAssetUrlRefresh: () => vi.fn(),
  useAssetUrlState: (_environmentId: unknown, resource: unknown) => {
    assets.resources.push(resource);
    return { _tag: "Success", url: "https://signed.test/diagram.png" };
  },
}));
vi.mock("../ui/scroll-area", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("../../hooks/useTheme", () => ({ useTheme: () => ({ resolvedTheme: "dark" }) }));
vi.mock("../../hooks/useSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../hooks/useSettings")>();
  const settings = actual.getClientSettings();
  return {
    ...actual,
    useClientSettings: (select?: (value: typeof settings) => unknown) =>
      select ? select(settings) : settings,
  };
});
vi.mock("../ui/tooltip", async () => {
  const { cloneElement, isValidElement } = await import("react");
  return {
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger({
      render,
      children,
    }: ComponentProps<typeof import("../ui/tooltip").TooltipTrigger>) {
      if (!isValidElement(render)) return <>{children}</>;
      return children === undefined ? render : cloneElement(render, undefined, children);
    },
    TooltipPopup: () => null,
  };
});
vi.mock("../../state/use-atom-query-runner", () => ({ useAtomQueryRunner: () => vi.fn() }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("../../state/session", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../state/session")>()),
  usePreparedConnection: () => ({ _tag: "Loading" }),
}));
vi.mock("../../state/entities", () => ({
  readThreadShell: () => null,
  useProjects: () => [],
  useServerConfigs: () => new Map(),
}));
vi.mock("../../remoteOpen", () => ({
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }),
}));
vi.mock("../../editorPreferences", () => ({
  useOpenInPreferredEditor: () => vi.fn(),
  usePreferredEditor: () => [null, vi.fn()],
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  findProjectOnChangeRequestHost: () => undefined,
  parseChangeRequestUrl: () => null,
  resolvePullRequestPreviewTarget: () => null,
  useOpenChangeRequestLink: () => vi.fn(),
}));

import RenderedAsciiDocSurface from "./RenderedAsciiDocSurface";
import { useRightPanelStore } from "../../rightPanelStore";

const threadRef = {
  environmentId: EnvironmentId.make("remote-environment"),
  threadId: ThreadId.make("worktree-thread"),
};

describe("AsciiDoc project resources", () => {
  it("loads images from the document directory and opens linked source files in the same environment", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    assets.resources = [];
    const openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => {
        renderer = create(
          <RenderedAsciiDocSurface
            cwd="/workspace/feature-worktree"
            relativePath="docs/guide.adoc"
            threadRef={threadRef}
            contents={
              '= Guide\n\nimage::images/diagram.png[Diagram]\n\nxref:other.adoc[Other document]\n\n++++\n<script>alert("unsafe")</script>\n++++'
            }
          />,
        );
      });
      expect(assets.resources).toContainEqual({
        _tag: "media-file",
        threadId: threadRef.threadId,
        path: "/workspace/feature-worktree/docs/images/diagram.png",
      });
      expect(renderer!.root.findAllByType("script")).toHaveLength(0);
      const link = renderer!.root
        .findAllByType("a")
        .find((node) => node.props.href?.endsWith("other.adoc"));
      expect(link).toBeDefined();
      await act(async () => {
        link!.props.onClick({
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
          metaKey: false,
          ctrlKey: false,
          shiftKey: false,
          altKey: false,
        });
      });
      expect(openFile).toHaveBeenCalledWith(threadRef, "docs/other.adoc", undefined);
    } finally {
      if (renderer) await act(async () => renderer!.unmount());
      openFile.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});
