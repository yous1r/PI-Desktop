import { parseProxyUrl } from "@pi-desktop/shared";
import { socks5Connect } from "@pi-desktop/agent-runtime/proxy-tunnel";
import { ensureSystemProxyRelay } from "./network-proxy";
import { createConnectionTransport } from "./plugin-connection-transport";

/** Resolve the configured Chromium route, including PAC, custom auth and bypasses. */
export const managedConnectionTransport = createConnectionTransport(async (host, port, signal) => {
  signal.throwIfAborted();
  const relay = parseProxyUrl(await ensureSystemProxyRelay());
  signal.throwIfAborted();
  if (!relay.ok) throw new Error("Connection proxy relay is unavailable");
  return socks5Connect(relay.value, host, port);
});
