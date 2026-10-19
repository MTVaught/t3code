// @effect-diagnostics nodeBuiltinImport:off - Tests exercise the native Node request and TLS socket boundary.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import * as NodeTls from "node:tls";
import { expect, it } from "@effect/vitest";
import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

import { sessionCookieOptions } from "./sessionCookie.ts";

it.each([false, true])("uses the Node socket transport (TLS=%s)", (tls) => {
  const socket = tls ? new NodeTls.TLSSocket(new NodeNet.Socket()) : new NodeNet.Socket();
  try {
    const source = new NodeHttp.IncomingMessage(socket);
    const request = new Proxy(HttpServerRequest.fromWeb(new Request("https://untrusted.test")), {
      get(target, key, receiver) {
        return key === "source" ? source : Reflect.get(target, key, receiver);
      },
    });
    expect(sessionCookieOptions(request, undefined).secure).toBe(tls);
  } finally {
    socket.destroy();
  }
});

it.each([
  { host: "proxy.example.test:80", secure: true },
  { host: "PROXY.EXAMPLE.TEST:8443", secure: true },
  { host: "127.0.0.1", secure: false },
  { host: "other.example.test", secure: false },
  { host: "[invalid", secure: false },
])("selects the configured HTTPS hostname for $host", ({ host, secure }) => {
  const request = HttpServerRequest.fromWeb(
    new Request("http://127.0.0.1", {
      headers: {
        host,
        "x-forwarded-host": "proxy.example.test",
        "x-forwarded-proto": "https",
        forwarded: "proto=https;host=proxy.example.test",
      },
    }),
  );
  expect(sessionCookieOptions(request, new URL("https://proxy.example.test")).secure).toBe(secure);
});
