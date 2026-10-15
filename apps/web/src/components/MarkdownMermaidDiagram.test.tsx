import { act } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { expect, it, vi } from "vite-plus/test";

const mermaid = vi.hoisted(() => ({
  initialize: vi.fn(),
  parse: vi.fn(async (_source: string) => true),
  render: vi.fn(async () => ({ svg: "<svg />" })),
}));
vi.mock("mermaid", () => ({ default: mermaid }));

import { MarkdownMermaidDiagram } from "./MarkdownMermaidDiagram";

it("skips superseded and unmounted diagrams waiting behind an active render", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let resolveActive!: (value: { svg: string }) => void;
  const active = new Promise<{ svg: string }>((resolve) => {
    resolveActive = resolve;
  });
  mermaid.render.mockImplementationOnce(() => active);
  let first: ReactTestRenderer | undefined;
  let second: ReactTestRenderer | undefined;
  let removed: ReactTestRenderer | undefined;
  const diagram = (code: string) => (
    <MarkdownMermaidDiagram code={code} theme="dark" fallback="source" />
  );
  try {
    await act(async () => {
      first = create(diagram("graph TD; Active-->Work;"));
    });
    expect(mermaid.render).toHaveBeenCalledTimes(1);

    await act(async () => {
      second = create(diagram("graph TD; Superseded-->Work;"));
      removed = create(diagram("graph TD; Removed-->Work;"));
    });
    await act(async () => {
      second!.update(diagram("graph TD; Current-->Work;"));
      removed!.unmount();
    });
    await act(async () => {
      resolveActive({ svg: "<svg />" });
      await active;
    });

    expect(mermaid.parse.mock.calls.map(([source]) => source)).toEqual([
      "graph TD; Active-->Work;",
      "graph TD; Current-->Work;",
    ]);
    expect(mermaid.render).toHaveBeenCalledTimes(2);
  } finally {
    resolveActive({ svg: "<svg />" });
    await act(async () => {
      first?.unmount();
      second?.unmount();
      removed?.unmount();
    });
    vi.unstubAllGlobals();
  }
});
