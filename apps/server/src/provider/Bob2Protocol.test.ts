import { assert, describe, it } from "vite-plus/test";

import fixture from "./testFixtures/bob2Protocol.json" with { type: "json" };
import {
  BOB2_PROTOCOL_LIMITS,
  Bob2StreamDecoder,
  boundedStderrTail,
  canonicalBobId,
  classifyBob2StartupFailure,
  decodeBob2Line,
  reconcileBob2LastMessage,
} from "./Bob2Protocol.ts";

type FixtureCase = {
  readonly stdout: ReadonlyArray<Record<string, unknown>>;
  readonly stderr?: string;
};

const cases = fixture.cases as Record<string, FixtureCase>;

function decodeFixture(name: string) {
  const decoder = new Bob2StreamDecoder();
  const stream = cases[name]?.stdout.map((event) => JSON.stringify(event)).join("\n") ?? "";
  const split = Math.floor(stream.length / 2);
  return [
    ...decoder.push(stream.slice(0, split)),
    ...decoder.push(stream.slice(split)),
    ...decoder.finish(),
  ];
}

describe("Bob2Protocol fixtures", () => {
  it("records the Bob build used for captured shapes", () => {
    assert.deepEqual(fixture.capturedWith, { version: "2.0.0", commit: "7a5dcab1" });
  });

  it("decodes assistant deltas, ignores no fields needed for terminal usage, and validates task ids", () => {
    const events = decodeFixture("success");
    assert.deepEqual(events[0], {
      type: "message",
      role: "user",
      content: "Reply with exactly OK.",
      isReasoning: false,
    });
    assert.deepEqual(events[1], {
      type: "message",
      role: "assistant",
      content: "OK",
      isReasoning: false,
    });
    const result = events[2];
    assert.equal(result?.type, "result");
    if (result?.type === "result") {
      assert.equal(result.status, "success");
      assert.equal(result.taskId, "11111111111111111111111111111111");
      assert.equal(result.durationMs, 2045);
      assert.equal(result.toolCalls, 0);
      assert.equal(result.usage.bobcoins, 0.005924);
    }
  });

  it("deduplicates repeated errors while retaining success-after-error for precedence handling", () => {
    const events = decodeFixture("toolAndLimit");
    assert.equal(events.filter((event) => event.type === "error").length, 1);
    assert.equal(events.at(-1)?.type, "result");
    assert.include(
      events.map((event) => event.type),
      "tool_use",
    );
    assert.include(
      events.map((event) => event.type),
      "tool_result",
    );
  });

  it("preserves reasoning, orphan results, subagent wrappers, and regressed zero cost", () => {
    assert.deepInclude(decodeFixture("reasoning")[0], {
      type: "message",
      isReasoning: true,
    });
    assert.equal(decodeFixture("orphanResult")[0]?.type, "tool_result");
    assert.deepInclude(decodeFixture("subagent")[1], {
      type: "tool_result",
      output: "<task_result>Inspection complete.</task_result>",
    });
    const regressedResult = decodeFixture("costLimitRegression")[1];
    assert.equal(
      regressedResult?.type === "result" ? regressedResult.usage.bobcoins : undefined,
      0,
    );
    assert.equal(decodeFixture("cancellation").at(-1)?.type, "result");
  });
});

describe("Bob2Protocol bounds and forward compatibility", () => {
  it("uses bounded stable canonical ids instead of raw Bob ids", () => {
    const rawId = "x".repeat(BOB2_PROTOCOL_LIMITS.opaqueIdCharacters);
    const first = canonicalBobId("item", rawId);
    assert.equal(first, canonicalBobId("item", rawId));
    assert.notEqual(first, canonicalBobId("task", rawId));
    assert.isBelow(first.length, 64);
  });

  it("bounds oversized lines and resumes on the next line", () => {
    const decoder = new Bob2StreamDecoder();
    const events = decoder.push(
      `${"x".repeat(BOB2_PROTOCOL_LIMITS.lineCharacters + 1)}\n${JSON.stringify({ type: "future_event" })}\n`,
    );
    assert.deepEqual(
      events.map((event) => event.type),
      ["malformed", "unknown"],
    );
    assert.equal(events[0]?.type === "malformed" ? events[0].reason : undefined, "line-too-long");
    assert.isAtMost(
      events[0]?.type === "malformed" ? events[0].sample.length : Infinity,
      BOB2_PROTOCOL_LIMITS.malformedSampleCharacters,
    );
  });

  it("bounds tool output and reports malformed known events", () => {
    const output = "z".repeat(BOB2_PROTOCOL_LIMITS.toolOutputCharacters + 100);
    const event = decodeBob2Line(
      JSON.stringify({ type: "tool_result", tool_id: "id", status: "success", output }),
    );
    assert.equal(
      event.type === "tool_result" ? event.output?.length : 0,
      BOB2_PROTOCOL_LIMITS.toolOutputCharacters,
    );
    assert.equal(decodeBob2Line('{"type":"message"}').type, "malformed");
    assert.equal(decodeBob2Line("not json").type, "malformed");
  });

  it("accepts optional future public token fields", () => {
    const event = decodeBob2Line(
      JSON.stringify({
        type: "result",
        status: "success",
        stats: {
          task_id: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          input: 10,
          output: 4,
          cacheRead: 3,
          cacheWrite: 2,
          contextTokens: 8,
        },
      }),
    );
    assert.equal(event.type, "result");
    if (event.type === "result") {
      assert.deepEqual(event.usage, {
        bobcoins: undefined,
        inputTokens: 10,
        outputTokens: 4,
        cacheReadTokens: 3,
        cacheWriteTokens: 2,
        contextTokens: 8,
      });
    }
  });
});

describe("Bob2Protocol terminal helpers", () => {
  it("classifies bounded plain-stderr startup failures", () => {
    const missing = cases.missingResume?.stderr ?? "";
    assert.equal(classifyBob2StartupFailure(missing).kind, "missing-task");
    assert.equal(classifyBob2StartupFailure("API key is invalid").kind, "authentication");
    assert.equal(classifyBob2StartupFailure("License acceptance required").kind, "license");
    assert.equal(classifyBob2StartupFailure("Unknown mode 'wat'").kind, "invalid-mode");
    assert.equal(
      classifyBob2StartupFailure("error: invalid argument --wat").kind,
      "invalid-arguments",
    );
    assert.equal(
      boundedStderrTail("x".repeat(BOB2_PROTOCOL_LIMITS.stderrCharacters + 10)).length,
      BOB2_PROTOCOL_LIMITS.stderrCharacters,
    );
  });

  it("reconciles only a provable missing suffix", () => {
    assert.equal(reconcileBob2LastMessage("Hel", "Hello"), "lo");
    assert.equal(reconcileBob2LastMessage("Hello", "Hello"), undefined);
    assert.equal(reconcileBob2LastMessage("Hello", "Hel"), undefined);
    assert.equal(reconcileBob2LastMessage("Hello", "Different"), undefined);
    assert.equal(reconcileBob2LastMessage("", "Fallback"), "Fallback");
  });
});
