import { EventId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { isThreadDetailEvent } from "./ws.ts";

const base = {
  eventId: EventId.make("event-1"),
  sequence: 1,
  occurredAt: "2026-01-01T00:00:00.000Z",
  aggregateKind: "thread" as const,
  aggregateId: ThreadId.make("thread-1"),
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
};

describe("isThreadDetailEvent", () => {
  it("forwards review flag changes, which only the detail carries", () => {
    expect(
      isThreadDetailEvent({
        ...base,
        type: "thread.review-file-flagged",
        payload: {
          threadId: ThreadId.make("thread-1"),
          paths: ["src/app.ts"],
          updatedAt: base.occurredAt,
        },
      }),
    ).toBe(true);
    expect(
      isThreadDetailEvent({
        ...base,
        type: "thread.review-file-unflagged",
        payload: {
          threadId: ThreadId.make("thread-1"),
          paths: ["src/app.ts"],
          updatedAt: base.occurredAt,
        },
      }),
    ).toBe(true);
  });

  it("keeps shell-only changes off the detail stream", () => {
    expect(
      isThreadDetailEvent({
        ...base,
        type: "thread.unpinned",
        payload: { threadId: ThreadId.make("thread-1"), updatedAt: base.occurredAt },
      }),
    ).toBe(false);
  });
});
