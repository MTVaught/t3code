import * as NodeTls from "node:tls";
import type * as HttpServerRequest from "effect/unstable/http/HttpServerRequest";

/** Forwarded headers do not establish transport security. Proxy deployments
 * declare their HTTPS origin and preserve Host. Match the hostname because
 * cookies are shared across ports, including an HTTP port on the same host.
 */
export function sessionCookieOptions(
  request: HttpServerRequest.HttpServerRequest,
  httpsOrigin: URL | undefined,
) {
  const source = request.source;
  const directHttps =
    source instanceof Request
      ? new URL(source.url).protocol === "https:"
      : "socket" in source && source.socket instanceof NodeTls.TLSSocket && source.socket.encrypted;
  let configuredHttps = false;
  if (httpsOrigin && request.headers.host) {
    try {
      const host = new URL(`http://${request.headers.host}`);
      configuredHttps = host.hostname === httpsOrigin.hostname;
    } catch {
      // An invalid Host cannot select the configured HTTPS origin.
    }
  }
  return {
    httpOnly: true,
    path: "/",
    sameSite: "lax" as const,
    secure: directHttps || configuredHttps,
  };
}
