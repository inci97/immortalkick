import { getEnv, getIntEnv, getOptionalEnv } from "../shared/env.ts";

export type LocalProxyConfig = {
  localBindHost: string;
  localBindPort: number;
  remoteBridgeMode: "websocket" | "http_poll";
  remoteBridgeWssUrl: string;
  remoteBridgeHttpBaseUrl: string;
  remoteBridgeToken: string;
  outboundQueueMax: number;
  reconnectMinMs: number;
  reconnectMaxMs: number;
  pollIntervalMs: number;
  helloIntervalMs: number;
  httpRequestTimeoutMs: number;
  enableLocalSocks5Redirect: boolean;
  localSocks5BindHost: string;
  localSocks5BindPort: number;
  socks5RedirectHost: string;
  socks5RedirectPort: number;
  socks5AllowedDestPort: number;
  socks5AllowedDestHosts: string[];
  socks5AllowedDestIps: string[];
};

function parseBool(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function parseCsv(input: string): string[] {
  return input
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

function parseOptionalCsv(input?: string): string[] {
  if (!input) {
    return [];
  }
  return parseCsv(input);
}

function parseMode(value: string): "websocket" | "http_poll" {
  const normalized = value.trim().toLowerCase();
  return normalized === "http_poll" ? "http_poll" : "websocket";
}

export function loadLocalProxyConfig(): LocalProxyConfig {
  return {
    localBindHost: getEnv("LOCAL_BIND_HOST", "127.0.0.1"),
    localBindPort: getIntEnv("LOCAL_BIND_PORT", 6667),
    remoteBridgeMode: parseMode(getEnv("REMOTE_BRIDGE_MODE", "websocket")),
    remoteBridgeWssUrl: getEnv("REMOTE_BRIDGE_WSS_URL"),
    remoteBridgeHttpBaseUrl: getEnv("REMOTE_BRIDGE_HTTP_BASE_URL", "http://127.0.0.1:8787"),
    remoteBridgeToken: getEnv("REMOTE_BRIDGE_TOKEN"),
    outboundQueueMax: getIntEnv("OUTBOUND_QUEUE_MAX", 500),
    reconnectMinMs: getIntEnv("WS_RECONNECT_MIN_MS", 1000),
    reconnectMaxMs: getIntEnv("WS_RECONNECT_MAX_MS", 10000),
    pollIntervalMs: getIntEnv("REMOTE_BRIDGE_POLL_INTERVAL_MS", 700),
    helloIntervalMs: getIntEnv("REMOTE_BRIDGE_HELLO_INTERVAL_MS", 5000),
    httpRequestTimeoutMs: getIntEnv("REMOTE_BRIDGE_HTTP_TIMEOUT_MS", 8000),
    enableLocalSocks5Redirect: parseBool(getEnv("ENABLE_LOCAL_SOCKS5_REDIRECT", "false")),
    localSocks5BindHost: getEnv("LOCAL_SOCKS5_BIND_HOST", "127.0.0.1"),
    localSocks5BindPort: getIntEnv("LOCAL_SOCKS5_BIND_PORT", 1080),
    socks5RedirectHost: getEnv("SOCKS5_REDIRECT_HOST", "127.0.0.1"),
    socks5RedirectPort: getIntEnv("SOCKS5_REDIRECT_PORT", 6667),
    socks5AllowedDestPort: getIntEnv("SOCKS5_ALLOWED_DEST_PORT", 6667),
    socks5AllowedDestHosts: parseOptionalCsv(getOptionalEnv("SOCKS5_ALLOWED_DEST_HOSTS")),
    socks5AllowedDestIps: parseOptionalCsv(getOptionalEnv("SOCKS5_ALLOWED_DEST_IPS")),
  };
}
