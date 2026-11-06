const STABLE = /^\d+\.\d+\.\d+-treher\.[1-9]\d*$/;
const PREVIEW = /^\d+\.\d+\.\d+-preview\.\d{8}\.\d+$/;

function releaseMetadata({ repository, event, ref, version, run, date }) {
  if (repository !== "MTVaught/t3code")
    throw new Error("Publishing is restricted to MTVaught/t3code.");
  const stable = event === "push";
  const resolved = stable ? ref.replace(/^v/, "") : version || `0.1.7-preview.${date}.${run}`;
  if (!(stable ? STABLE : PREVIEW).test(resolved)) {
    throw new Error(
      stable
        ? "Stable tags must be v<upstream>-treher.<sequence>."
        : "Preview versions must be <upstream>-preview.<YYYYMMDD>.<run>.",
    );
  }
  return {
    version: resolved,
    tag: `v${resolved}`,
    channel: stable ? "stable" : "preview",
    prerelease: !stable,
  };
}

module.exports = { releaseMetadata };
if (require.main === module) {
  const meta = releaseMetadata({
    repository: process.env.GITHUB_REPOSITORY,
    event: process.env.GITHUB_EVENT_NAME,
    ref: process.env.GITHUB_REF_NAME || "",
    version: process.env.PREVIEW_VERSION,
    run: process.env.GITHUB_RUN_NUMBER,
    date: new Date().toISOString().slice(0, 10).replaceAll("-", ""),
  });
  for (const [key, value] of Object.entries(meta)) console.log(`${key}=${value}`);
}
