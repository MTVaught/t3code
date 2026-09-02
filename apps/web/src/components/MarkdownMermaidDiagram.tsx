import { useEffect, useState, type ReactNode } from "react";
import { fnv1a32 } from "../lib/diffRendering";
import { LRUCache } from "../lib/lruCache";

const MAX_MERMAID_CACHE_ENTRIES = 100;
const MAX_MERMAID_CACHE_MEMORY_BYTES = 10 * 1024 * 1024;

const renderedMermaidCache = new LRUCache<string>(
  MAX_MERMAID_CACHE_ENTRIES,
  MAX_MERMAID_CACHE_MEMORY_BYTES,
);

type MermaidModule = typeof import("mermaid").default;

let mermaidModulePromise: Promise<MermaidModule> | null = null;

/** Mermaid is ~1.5 MB minified, so it only loads once a mermaid fence renders. */
function getMermaid(): Promise<MermaidModule> {
  mermaidModulePromise ??= import("mermaid").then((module) => module.default);
  return mermaidModulePromise;
}

let renderSequence = 0;
let renderQueue: Promise<unknown> = Promise.resolve();

/**
 * Renders mermaid source to an SVG string, or null when the source does not
 * parse (partial code mid-stream, or plain author error). Mermaid holds its
 * theme in module-level config, so renders are serialized to keep an
 * initialize/render pair from interleaving with one for the other theme.
 */
function renderMermaidSvg(code: string, theme: "light" | "dark"): Promise<string | null> {
  const result = renderQueue.then(async () => {
    const mermaid = await getMermaid();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      theme: theme === "dark" ? "dark" : "default",
    });
    const parsed = await mermaid.parse(code, { suppressErrors: true });
    if (parsed === false) {
      return null;
    }
    const { svg } = await mermaid.render(`chat-markdown-mermaid-${++renderSequence}`, code);
    return svg;
  });
  renderQueue = result.catch(() => null);
  return result;
}

function createMermaidCacheKey(code: string, theme: "light" | "dark"): string {
  return `${fnv1a32(code).toString(36)}:${code.length}:${theme}`;
}

/**
 * Renders a ```mermaid fence as a diagram, showing `fallback` (the highlighted
 * code block) until a render succeeds. Invalid source keeps the fallback, so a
 * diagram streaming in stays readable as code and flips once it parses.
 */
export function MarkdownMermaidDiagram({
  code,
  theme,
  fallback,
}: {
  code: string;
  theme: "light" | "dark";
  fallback: ReactNode;
}) {
  const cacheKey = createMermaidCacheKey(code, theme);
  const cachedSvg = renderedMermaidCache.get(cacheKey);
  const [rendered, setRendered] = useState<{ key: string; svg: string } | null>(null);

  useEffect(() => {
    if (renderedMermaidCache.get(cacheKey) != null) {
      return;
    }
    let cancelled = false;
    renderMermaidSvg(code, theme)
      .then((svg) => {
        if (svg == null) return;
        renderedMermaidCache.set(cacheKey, svg, svg.length * 2);
        if (!cancelled) {
          setRendered({ key: cacheKey, svg });
        }
      })
      .catch((cause) => {
        console.warn("[chat-markdown] mermaid render failed, keeping code view", cause);
      });
    return () => {
      cancelled = true;
    };
  }, [cacheKey, code, theme]);

  const svg = cachedSvg ?? (rendered?.key === cacheKey ? rendered.svg : null);
  if (svg == null) {
    return <>{fallback}</>;
  }
  return (
    <div
      className="chat-markdown-mermaid flex justify-center overflow-x-auto px-3 py-2 [&_svg]:h-auto [&_svg]:max-w-full"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
