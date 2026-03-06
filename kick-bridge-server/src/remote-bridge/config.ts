import path from "node:path";
import { getEnv, getIntEnv, getOptionalEnv } from "../shared/env.ts";

function parseCsv(input: string): string[] {
  return input
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parseBool(input: string): boolean {
  const v = input.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export type RemoteBridgeConfig = {
  remoteBindHost: string;
  remoteBindPort: number;
  webhookPublicUrl: string;
  localProxySharedToken: string;
  kickClientId: string;
  kickClientSecret: string;
  kickRedirectUri: string;
  kickBroadcasterUserId?: string;
  kickBotUserId?: string;
  kickChatMessageType: "user" | "bot";
  kickScopes: string[];
  kickApiBaseUrl: string;
  kickAuthBaseUrl: string;
  kickTokenFile: string;
  kickWebhookEvents: string[];
  kickWebhookPublicKeyPem?: string;
  kickChatSendPath: string;
  kickEventsSubscribePath: string;
  kickPublicKeyPath: string;
  kickWebhookPath: string;
  relayGameChatToKick: boolean;
};

export function loadRemoteBridgeConfig(): RemoteBridgeConfig {
  return {
    remoteBindHost: getEnv("REMOTE_BIND_HOST", "0.0.0.0"),
    remoteBindPort: getIntEnv("REMOTE_BIND_PORT", 8787),
    webhookPublicUrl: getEnv("WEBHOOK_PUBLIC_URL"),
    localProxySharedToken: getEnv("LOCAL_PROXY_SHARED_TOKEN"),
    kickClientId: getEnv("KICK_CLIENT_ID"),
    kickClientSecret: getEnv("KICK_CLIENT_SECRET"),
    kickRedirectUri: getEnv("KICK_REDIRECT_URI"),
    kickBroadcasterUserId: getOptionalEnv("KICK_BROADCASTER_USER_ID"),
    kickBotUserId: getOptionalEnv("KICK_BOT_USER_ID"),
    kickChatMessageType: (getEnv("KICK_CHAT_MESSAGE_TYPE", "user").toLowerCase() === "bot" ? "bot" : "user"),
    kickScopes: parseCsv(getEnv("KICK_SCOPES", "chat:write,user:read,events:subscribe")),
    kickApiBaseUrl: getEnv("KICK_API_BASE_URL", "https://api.kick.com"),
    kickAuthBaseUrl: getEnv("KICK_AUTH_BASE_URL", "https://id.kick.com"),
    kickTokenFile: path.resolve(getEnv("KICK_TOKEN_FILE", "./data/kick-token.json")),
    kickWebhookEvents: parseCsv(getEnv("KICK_WEBHOOK_EVENTS", "chat.message.sent")),
    kickWebhookPublicKeyPem: getOptionalEnv("KICK_WEBHOOK_PUBLIC_KEY_PEM"),
    kickChatSendPath: getEnv("KICK_CHAT_SEND_PATH", "/public/v1/chat"),
    kickEventsSubscribePath: getEnv("KICK_EVENTS_SUBSCRIBE_PATH", "/public/v1/events/subscriptions"),
    kickPublicKeyPath: getEnv("KICK_PUBLIC_KEY_PATH", "/public/v1/public-key"),
    kickWebhookPath: getEnv("KICK_WEBHOOK_PATH", "/webhooks/kick"),
    relayGameChatToKick: parseBool(getEnv("RELAY_GAME_CHAT_TO_KICK", "false")),
  };
}
