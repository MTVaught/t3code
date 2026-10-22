import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { beforeEach, vi } from "vite-plus/test";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import * as DesktopLegacyLocalStorage from "./DesktopLegacyLocalStorage.ts";
import { ChromiumLocalStorageReadError, readChromiumLocalStorage } from "./chromiumLocalStorage.ts";
import { mergeLegacyLocalStorage } from "../legacyLocalStorageMerge.ts";

vi.mock("electron", () => ({}));
vi.mock("./chromiumLocalStorage.ts", { spy: true });

const legacyItems = new Map([
  ["t3code:theme", "dark"],
  [
    "t3code:prompt-stash:v2",
    JSON.stringify({ version: 2, state: { entries: [{ id: "legacy", prompt: "saved prompt" }] } }),
  ],
  [
    "t3code:composer-drafts:v1",
    JSON.stringify({
      version: 9,
      state: {
        draftsByThreadKey: {
          shared: { prompt: "old shared draft" },
          legacy: { prompt: "old unsent draft" },
        },
        draftThreadsByThreadKey: {},
        logicalProjectDraftThreadKeyByLogicalProjectKey: {},
      },
    }),
  ],
]);

beforeEach(() => {
  vi.mocked(readChromiumLocalStorage).mockReset();
  vi.mocked(readChromiumLocalStorage).mockReturnValue(Effect.succeed(legacyItems));
});

const makeHarness = (isDevelopment = false) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const appDataDirectory = yield* fs.makeTempDirectoryScoped({
      prefix: "treher-storage-import-",
    });
    const userDataPath = path.join(appDataDirectory, "t3code-treher-v2");
    yield* fs.makeDirectory(userDataPath);
    const marker = path.join(userDataPath, "treher-v1-local-storage-imported");
    const makeService = Effect.service(DesktopLegacyLocalStorage.DesktopLegacyLocalStorage).pipe(
      Effect.provide(DesktopLegacyLocalStorage.layer),
      Effect.provideService(DesktopEnvironment.DesktopEnvironment, {
        appDataDirectory,
        isDevelopment,
      } as unknown as DesktopEnvironment.DesktopEnvironment["Service"]),
    );
    const seed = (profile: string) =>
      Effect.gen(function* () {
        const directory = path.join(appDataDirectory, profile, "Local Storage", "leveldb");
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(directory, "CURRENT"), "original V1 storage");
        return directory;
      });
    return { fs, path, appDataDirectory, userDataPath, marker, seed, makeService };
  });

it.layer(NodeServices.layer)("Treher V1 local storage migration", (it) => {
  it.effect(
    "imports Treher drafts and preferences despite an old marker, while keeping V2 edits",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const directory = yield* h.seed("t3code-treher");
        yield* h.seed("t3code");
        yield* h.seed("T3 Code (Alpha)");
        yield* h.fs.writeFileString(h.path.join(h.userDataPath, "v1-local-storage-imported"), "");
        const service = yield* h.makeService;
        yield* service.load(h.userDataPath);
        expect(readChromiumLocalStorage).toHaveBeenCalledExactlyOnceWith(
          directory,
          "treher-t3code://app",
        );
        expect(yield* h.fs.exists(h.marker)).toBe(false);
        const items = yield* service.take;
        expect(Option.isSome(items)).toBe(true);
        if (Option.isNone(items)) return;
        expect(yield* service.take).toEqual(Option.none());
        const values = new Map([
          ["t3code:theme", "light"],
          [
            "t3code:composer-drafts:v1",
            JSON.stringify({
              version: 9,
              state: {
                draftsByThreadKey: { shared: { prompt: "new V2 draft" } },
                draftThreadsByThreadKey: {},
                logicalProjectDraftThreadKeyByLogicalProjectKey: {},
              },
            }),
          ],
        ]);
        expect(
          mergeLegacyLocalStorage(
            {
              getItem: (key) => values.get(key) ?? null,
              setItem: (key, value) => {
                values.set(key, value);
              },
            },
            items.value,
          ),
        ).toBe(true);
        expect(values.get("t3code:theme")).toBe("light");
        expect(values.get("t3code:prompt-stash:v2")).toBe(
          legacyItems.get("t3code:prompt-stash:v2"),
        );
        expect(JSON.parse(values.get("t3code:composer-drafts:v1")!)).toMatchObject({
          state: {
            draftsByThreadKey: {
              shared: { prompt: "new V2 draft" },
              legacy: { prompt: "old unsent draft" },
            },
          },
        });
        yield* service.complete;
        expect(yield* h.fs.exists(h.marker)).toBe(true);
        expect(yield* h.fs.readFileString(h.path.join(directory, "CURRENT"))).toBe(
          "original V1 storage",
        );
        const next = yield* h.makeService;
        yield* next.load(h.userDataPath);
        expect(yield* next.take).toEqual(Option.none());
        expect(readChromiumLocalStorage).toHaveBeenCalledTimes(1);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "ignores upstream profiles and retries if the Treher profile later becomes available",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        yield* h.seed("t3code");
        yield* h.seed("T3 Code (Alpha)");
        const service = yield* h.makeService;
        yield* service.load(h.userDataPath);
        yield* service.complete;
        expect(yield* service.take).toEqual(Option.none());
        expect(yield* h.fs.exists(h.marker)).toBe(false);
        expect(readChromiumLocalStorage).not.toHaveBeenCalled();
        yield* h.seed("t3code-treher");
        yield* service.load(h.userDataPath);
        expect(Option.isSome(yield* service.take)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect("retries a failed read without writing a completion marker", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const directory = yield* h.seed("t3code-treher");
      vi.mocked(readChromiumLocalStorage).mockReturnValueOnce(
        Effect.fail(
          new ChromiumLocalStorageReadError({ directory, cause: "temporarily unreadable" }),
        ),
      );
      const service = yield* h.makeService;
      yield* service.load(h.userDataPath);
      yield* service.complete;
      expect(yield* h.fs.exists(h.marker)).toBe(false);
      expect(yield* service.take).toEqual(Option.none());
      yield* service.load(h.userDataPath);
      expect(Option.isSome(yield* service.take)).toBe(true);
      expect(yield* h.fs.exists(h.marker)).toBe(false);
      yield* service.complete;
      expect(yield* h.fs.exists(h.marker)).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("leaves development profiles alone", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(true);
      yield* h.seed("t3code-treher");
      const service = yield* h.makeService;
      yield* service.load(h.userDataPath);
      expect(yield* service.take).toEqual(Option.none());
      expect(yield* h.fs.exists(h.marker)).toBe(false);
      expect(readChromiumLocalStorage).not.toHaveBeenCalled();
    }).pipe(Effect.scoped),
  );
});
