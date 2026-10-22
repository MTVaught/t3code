import { describe, expect, it } from "vite-plus/test";
import { MessageId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import {
  beginCodexFeedbackSubmission,
  codexFeedbackNotice,
  codexFeedbackMessage,
  parseCodexFeedbackCommand,
  submitCodexFeedback,
  type CodexFeedbackSubmission,
} from "./threadFeedback.ts";

describe("beginCodexFeedbackSubmission", () => {
  it("allows only one upload per thread until the active upload releases its guard", () => {
    const inFlight = new Set<string>();
    const finish = beginCodexFeedbackSubmission(inFlight, "environment:thread");

    expect(finish).not.toBeNull();
    expect(beginCodexFeedbackSubmission(inFlight, "environment:thread")).toBeNull();
    expect(beginCodexFeedbackSubmission(inFlight, "environment:other-thread")).not.toBeNull();

    finish?.();
    expect(beginCodexFeedbackSubmission(inFlight, "environment:thread")).not.toBeNull();
  });
});

describe("parseCodexFeedbackCommand", () => {
  it("accepts feedback without a reason", () => {
    expect(parseCodexFeedbackCommand(" /feedback ")).toEqual({});
  });

  it("preserves a feedback description", () => {
    expect(parseCodexFeedbackCommand("/feedback The agent stopped early.")).toEqual({
      reason: "The agent stopped early.",
    });
  });

  it("accepts mixed-case feedback commands", () => {
    expect(parseCodexFeedbackCommand("/Feedback Retry failed.")).toEqual({
      reason: "Retry failed.",
    });
  });

  it("ignores other slash commands and ordinary messages", () => {
    expect(parseCodexFeedbackCommand("/feedback-status")).toBeNull();
    expect(parseCodexFeedbackCommand("Please send /feedback")).toBeNull();
  });
});

describe("submitCodexFeedback", () => {
  it("rejects locally without uploading logs or clearing the unsent draft", async () => {
    const submission = {
      id: MessageId.make("feedback-message-1"),
      command: "/feedback The agent stopped early.",
      createdAt: "2026-08-23T00:00:00.000Z",
    };
    let draft = submission.command;
    let uploadCalls = 0;
    const states: CodexFeedbackSubmission[] = [];
    const result = await submitCodexFeedback({
      submission,
      clearDraft: () => {
        draft = "";
      },
      onUpdate: (state) => states.push(state),
      upload: () => {
        uploadCalls++;
        return Promise.resolve(AsyncResult.success({ feedbackId: "must-not-upload" }));
      },
    });
    expect(result._tag).toBe("Failure");
    expect(uploadCalls).toBe(0);
    expect(draft).toBe(submission.command);
    expect(states).toEqual([
      { ...submission, status: "failed", errorMessage: "Feedback uploads are disabled in Treher." },
    ]);
    expect(codexFeedbackNotice(states[0]!)?.description).toBe(
      "Feedback uploads are disabled in Treher.",
    );
    expect(codexFeedbackMessage(states[0]!, "assistant").text).toContain(
      "Feedback uploads are disabled in Treher.",
    );
  });
});
