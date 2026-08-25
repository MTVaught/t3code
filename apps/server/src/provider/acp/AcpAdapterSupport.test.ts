import { describe, expect, it } from "vite-plus/test";
import * as EffectAcpErrors from "effect-acp/errors";
import { ProviderDriverKind } from "@t3tools/contracts";

import { mapAcpToAdapterError, selectAcpPermissionOptionId } from "./AcpAdapterSupport.ts";

describe("AcpAdapterSupport", () => {
  it("selects provider-defined permission ids by ACP option kind", () => {
    const request = {
      sessionId: "session-1",
      toolCall: { toolCallId: "tool-1", title: "Edit", status: "pending" as const },
      options: [
        { optionId: "allow", name: "Allow", kind: "allow_once" as const },
        { optionId: "allow_always", name: "Always", kind: "allow_always" as const },
        { optionId: "reject", name: "Reject", kind: "reject_once" as const },
      ],
    };
    expect(selectAcpPermissionOptionId(request, "accept")).toBe("allow");
    expect(selectAcpPermissionOptionId(request, "acceptForSession")).toBe("allow_always");
    expect(selectAcpPermissionOptionId(request, "decline")).toBe("reject");
  });

  it("maps ACP request errors to provider adapter request errors", () => {
    const error = mapAcpToAdapterError(
      ProviderDriverKind.make("cursor"),
      "thread-1" as never,
      "session/prompt",
      new EffectAcpErrors.AcpRequestError({
        code: -32602,
        errorMessage: "Invalid params",
      }),
    );

    expect(error._tag).toBe("ProviderAdapterRequestError");
    expect(error.message).toContain("Invalid params");
  });
});
