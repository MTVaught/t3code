import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentHttpApi } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Etag from "effect/unstable/http/Etag";
import * as HttpPlatform from "effect/unstable/http/HttpPlatform";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpRouter from "effect/unstable/http/HttpRouter";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";
import { authHttpApiLayer, environmentAuthenticatedAuthLayer } from "./http.ts";

const DEV_TOKEN = "reusable-dev-auth-token-that-is-long-enough";
class AuthTestApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}

const makeConfigLayer = (overrides: Partial<ServerConfig.ServerConfig["Service"]> = {}) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        mode: "web",
        devUrl: new URL("http://127.0.0.1:5173"),
        devAuthToken: Redacted.make(DEV_TOKEN),
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-http-test-" })));

const makeRoutesLayer = (
  overrides: Partial<ServerConfig.ServerConfig["Service"]> = {},
  seed?: (
    auth: EnvironmentAuth.EnvironmentAuth["Service"],
  ) => Effect.Effect<unknown, EnvironmentAuth.ServerAuthInternalError>,
) => {
  const configLayer = makeConfigLayer(overrides);
  const environmentAuthLayer = EnvironmentAuth.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(ServerEnvironment.identityLayer),
    Layer.provide(configLayer),
    Layer.tap((context) =>
      seed ? seed(Context.get(context, EnvironmentAuth.EnvironmentAuth)) : Effect.void,
    ),
  );
  const routesLayer = HttpApiBuilder.layer(AuthTestApi).pipe(
    Layer.provide(authHttpApiLayer),
    Layer.provide(environmentAuthenticatedAuthLayer),
    Layer.provideMerge(environmentAuthLayer),
    Layer.provide(configLayer),
    Layer.provideMerge(
      HttpPlatform.layer.pipe(
        Layer.provideMerge(NodeServices.layer),
        Layer.provideMerge(Etag.layerWeak),
      ),
    ),
    Layer.provide(NodeServices.layer),
  );

  return routesLayer;
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

it.effect.each([
  { origin: "http://127.0.0.1", secure: false },
  { origin: "http://192.0.2.1", secure: false },
  { origin: "http://127.0.0.1", secure: false, forwarded: "https" },
  { origin: "https://direct.example.test", secure: true },
  {
    origin: "http://proxy.example.test",
    secure: true,
    httpsOrigin: new URL("https://proxy.example.test"),
  },
  {
    origin: "http://machine.tailnet.ts.net",
    secure: true,
    httpsOrigin: new URL("https://machine.tailnet.ts.net"),
    forwarded: "http",
  },
  { origin: "http://127.0.0.1", secure: false, httpsOrigin: new URL("https://proxy.example.test") },
])(
  "sets session and clearing cookies for $origin (Secure=$secure)",
  ({ origin, secure, forwarded, httpsOrigin }) =>
    Effect.gen(function* () {
      const routesLayer = makeRoutesLayer(httpsOrigin ? { httpsOrigin } : {});
      const post = (path: string, body: unknown, headers?: Readonly<Record<string, string>>) =>
        new Request(new URL(path, origin), {
          method: "POST",
          headers: {
            host: new URL(origin).host,
            "content-type": "application/json",
            ...(forwarded ? { "x-forwarded-proto": forwarded } : {}),
            ...headers,
          },
          body: encodeJson(body),
        });
      const crypto = yield* Crypto.Crypto;
      const unusedSecretStore = ServerSecretStore.ServerSecretStore.of({
        get: () => Effect.succeedNone,
        set: () => Effect.void,
        create: () => Effect.void,
        getOrCreateRandom: () => Effect.die("Not used by these routes."),
        remove: () => Effect.void,
      });
      const requestContext = Context.make(Crypto.Crypto, crypto).pipe(
        Context.add(ServerSecretStore.ServerSecretStore, unusedSecretStore),
      );
      return yield* Effect.acquireUseRelease(
        Effect.sync(
          () =>
            [
              HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
              HttpRouter.toWebHandler(routesLayer, { disableLogger: true }),
            ] as const,
        ),
        ([environmentA, environmentB]) =>
          Effect.tryPromise(async () => {
            const devResponse = await environmentA.handler(
              post("/api/auth/browser-session", { credential: DEV_TOKEN }),
              requestContext,
            );
            expect(devResponse.status).toBe(200);
            const devCookies = devResponse.headers.getSetCookie();
            const devCookie = devCookies.find((cookie) => cookie.startsWith("t3_dev_session_"));
            expect(devCookie).toContain("HttpOnly");
            for (const cookie of devCookies) {
              expect(cookie.includes("; Secure")).toBe(secure);
              expect(cookie).toContain("SameSite=Lax");
              expect(cookie).toContain("Path=/");
            }
            expect(devCookie).toContain(`=${DEV_TOKEN};`);
            expect(devCookies).toContainEqual(
              expect.stringMatching(/^t3_session_[^=]*=;.*Max-Age=0/),
            );
            const devCookieHeader = devCookie?.split(";", 1)[0] ?? "";
            const environmentBSession = await environmentB.handler(
              new Request("http://127.0.0.1/api/auth/session", {
                headers: { cookie: devCookieHeader },
              }),
              requestContext,
            );
            expect(environmentBSession.status).toBe(200);
            expect(await environmentBSession.json()).toMatchObject({ authenticated: true });

            const pairingResponse = await environmentA.handler(
              post(
                "/api/auth/pairing-token",
                { scopes: ["orchestration:read"] },
                { cookie: devCookieHeader },
              ),
              requestContext,
            );
            expect(pairingResponse.status).toBe(200);
            const pairing = (await pairingResponse.json()) as { credential: string };
            const restrictedResponse = await environmentA.handler(
              post("/api/auth/browser-session", { credential: pairing.credential }),
              requestContext,
            );
            expect(restrictedResponse.status).toBe(200);
            const restrictedCookies = restrictedResponse.headers.getSetCookie();
            expect(restrictedCookies).toHaveLength(1);
            expect(restrictedCookies[0]).toMatch(/^t3_session_/);
            expect(restrictedCookies[0]).not.toContain("t3_dev_session_");
            expect(restrictedCookies[0]?.includes("; Secure")).toBe(secure);
          }),
        ([environmentA, environmentB]) =>
          Effect.promise(() => Promise.all([environmentA.dispose(), environmentB.dispose()])),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect.each([
  { origin: "http://remote.example.test", secure: false },
  { origin: "http://127.0.0.1", secure: false, mode: "desktop" as const },
  { origin: "https://remote.example.test", secure: true },
  {
    origin: "http://remote.example.test",
    secure: true,
    httpsOrigin: new URL("https://remote.example.test"),
  },
])(
  "issues and migrates session cookies for $origin (Secure=$secure)",
  ({ origin, secure, httpsOrigin, mode }) =>
    Effect.gen(function* () {
      let credential = "";
      const routes = makeRoutesLayer(
        {
          host: "0.0.0.0",
          devUrl: undefined,
          ...(httpsOrigin ? { httpsOrigin } : {}),
          mode: mode ?? "web",
        },
        (auth) =>
          auth.issuePairingCredential().pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                credential = result.credential;
              }),
            ),
          ),
      );
      const crypto = yield* Crypto.Crypto;
      const context = Context.make(Crypto.Crypto, crypto).pipe(
        Context.add(
          ServerSecretStore.ServerSecretStore,
          ServerSecretStore.ServerSecretStore.of({
            get: () => Effect.succeedNone,
            set: () => Effect.void,
            create: () => Effect.void,
            getOrCreateRandom: () => Effect.die("Not used by these routes."),
            remove: () => Effect.void,
          }),
        ),
      );
      yield* Effect.acquireUseRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        (app) =>
          Effect.tryPromise(async () => {
            // The first request builds the isolated auth service and its pairing credential.
            await app.handler(new Request(`${origin}/api/auth/session`), context);
            const issued = await app.handler(
              new Request(`${origin}/api/auth/browser-session`, {
                method: "POST",
                headers: { host: new URL(origin).host, "content-type": "application/json" },
                body: encodeJson({ credential }),
              }),
              context,
            );
            expect(issued.status).toBe(200);
            const cookie = issued.headers.getSetCookie()[0];
            expect(cookie).toBeDefined();
            expect(cookie?.includes("; Secure")).toBe(secure);
            if (mode === "desktop") return;
            const legacy =
              cookie?.split(";", 1)[0]?.replace(/^t3_session_[^=]+=/, "t3_session=") ?? "";
            const migrated = await app.handler(
              new Request(`${origin}/api/auth/session`, {
                headers: {
                  host: new URL(origin).host,
                  cookie: legacy,
                  "x-forwarded-proto": "http",
                },
              }),
              context,
            );
            expect(migrated.status).toBe(200);
            expect(await migrated.json()).toMatchObject({ authenticated: true });
            expect(migrated.headers.getSetCookie()).toEqual([cookie]);
          }),
        (app) => Effect.promise(() => app.dispose()),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
