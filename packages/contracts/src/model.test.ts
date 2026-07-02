import { assert, describe, it } from "@effect/vitest";
import {
  DEFAULT_BOB_MODEL,
  DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER,
  DEFAULT_MODEL_BY_PROVIDER,
} from "./model.ts";
import { ProviderDriverKind } from "./providerInstance.ts";
import { DEFAULT_SERVER_SETTINGS } from "./settings.ts";

describe("provider model defaults", () => {
  it("defines chat and text-generation defaults for every built-in provider", () => {
    for (const provider of Object.keys(DEFAULT_SERVER_SETTINGS.providers)) {
      const kind = ProviderDriverKind.make(provider);
      assert.isString(DEFAULT_MODEL_BY_PROVIDER[kind]);
      assert.isString(DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[kind]);
    }
  });

  it("uses Bob's canonical premium tier", () => {
    const bob = ProviderDriverKind.make("bob");
    assert.equal(DEFAULT_MODEL_BY_PROVIDER[bob], DEFAULT_BOB_MODEL);
    assert.equal(DEFAULT_GIT_TEXT_GENERATION_MODEL_BY_PROVIDER[bob], DEFAULT_BOB_MODEL);
  });
});
