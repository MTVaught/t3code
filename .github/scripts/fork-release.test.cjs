const { test } = require("node:test");
const assert = require("node:assert/strict");
const { releaseMetadata } = require("./fork-release.cjs");
const input = {
  repository: "MTVaught/t3code",
  event: "push",
  ref: "v0.1.7-treher.1",
  run: "42",
  date: "20261106",
};

test("only final fork tags can produce stable releases", () => {
  assert.deepEqual(releaseMetadata(input), {
    version: "0.1.7-treher.1",
    tag: "v0.1.7-treher.1",
    channel: "stable",
    prerelease: false,
  });
  for (const ref of [
    "v0.1.7",
    "v0.1.7-treher.1.rc.1",
    "v0.1.7-nightly.20261106.1",
    "v0.1.7-treher.0",
    "v0.1.7-treher.1;exit 0",
  ]) {
    assert.throws(() => releaseMetadata({ ...input, ref }));
  }
});
test("manual builds cannot become stable releases", () => {
  assert.equal(
    releaseMetadata({ ...input, event: "workflow_dispatch" }).version,
    "0.1.7-preview.20261106.42",
  );
  assert.throws(() =>
    releaseMetadata({ ...input, event: "workflow_dispatch", version: "0.1.7-treher.1" }),
  );
});
test("publishing cannot target upstream", () => {
  assert.throws(() => releaseMetadata({ ...input, repository: "pingdotgg/t3code" }));
});
