import { convert } from "@asciidoctor/core";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { FileMarkdownPreview } from "./FileMarkdownPreview";

import { ScrollArea } from "~/components/ui/scroll-area";

export default function RenderedAsciiDocSurface({
  contents,
  cwd,
  relativePath,
  threadRef,
}: {
  contents: string;
  cwd: string;
  relativePath: string;
  threadRef: ScopedThreadRef;
}) {
  const [result, setResult] = useState<{ html: string; error?: never } | { error: string } | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    setResult(null);
    void convert(contents, {
      safe: "secure",
      attributes: {
        showtitle: true,
        relfilesuffix: relativePath.endsWith(".asciidoc") ? ".asciidoc" : ".adoc",
      },
    })
      .then((converted) => {
        if (current) setResult({ html: String(converted) });
      })
      .catch(() => {
        if (current) setResult({ error: "Unable to render this AsciiDoc file." });
      });
    return () => {
      current = false;
    };
  }, [contents, relativePath]);

  if (result === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }

  if ("error" in result) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-destructive">
        {result.error}
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <FileMarkdownPreview
        cwd={cwd}
        relativePath={relativePath}
        threadRef={threadRef}
        text={result.html}
      />
    </ScrollArea>
  );
}
