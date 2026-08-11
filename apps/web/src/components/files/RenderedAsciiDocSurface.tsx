import { convert } from "@asciidoctor/core";
import DOMPurify from "dompurify";
import { LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";

import { ScrollArea } from "~/components/ui/scroll-area";

export default function RenderedAsciiDocSurface({ contents }: { contents: string }) {
  const [result, setResult] = useState<{ html: string; error?: never } | { error: string } | null>(
    null,
  );

  useEffect(() => {
    let current = true;
    setResult(null);
    void convert(contents, {
      safe: "secure",
      attributes: { showtitle: true },
    })
      .then((converted) => {
        if (current) setResult({ html: DOMPurify.sanitize(String(converted)) });
      })
      .catch(() => {
        if (current) setResult({ error: "Unable to render this AsciiDoc file." });
      });
    return () => {
      current = false;
    };
  }, [contents]);

  if (result === null) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center text-muted-foreground">
        <LoaderCircle className="size-5 animate-spin" />
      </div>
    );
  }

  if (result.error) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center px-6 text-center text-xs text-destructive">
        {result.error}
      </div>
    );
  }

  return (
    <ScrollArea className="min-h-0 flex-1">
      <div
        className="chat-markdown mx-auto w-full max-w-4xl px-6 py-5 text-sm leading-relaxed text-foreground/80"
        // Asciidoctor output is sanitized above before it reaches the DOM.
        dangerouslySetInnerHTML={{ __html: result.html }}
      />
    </ScrollArea>
  );
}
