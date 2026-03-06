import { logger } from "../shared/logger.ts";
import type { RemoteBridgeConfig } from "./config.ts";
import { KickAuthClient } from "./kick-auth.ts";

type KickChatResponse = {
  data?: unknown;
  message?: string;
};

export class KickApiClient {
  private readonly config: RemoteBridgeConfig;
  private readonly authClient: KickAuthClient;

  constructor(config: RemoteBridgeConfig, authClient: KickAuthClient) {
    this.config = config;
    this.authClient = authClient;
  }

  async sendChatMessage(message: string, broadcasterUserIdOverride?: string): Promise<void> {
    const trimmed = message.trim();
    if (!trimmed) {
      return;
    }
    const broadcasterUserId = broadcasterUserIdOverride ?? this.config.kickBroadcasterUserId;
    if (!broadcasterUserId) {
      throw new Error("Missing broadcaster user id for Kick chat send");
    }
    const token = await this.authClient.getAccessToken();
    const url = new URL(this.config.kickChatSendPath, this.config.kickApiBaseUrl);
    const broadcasterIdNumber = Number.parseInt(broadcasterUserId, 10);
    const broadcaster_user_id = Number.isFinite(broadcasterIdNumber)
      ? broadcasterIdNumber
      : broadcasterUserId;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        broadcaster_user_id,
        type: this.config.kickChatMessageType,
        content: trimmed,
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kick chat send failed (${response.status}): ${text}`);
    }
    const parsed = (await response.json().catch(() => null)) as KickChatResponse | null;
    logger.debug("Sent message to Kick chat", {
      status: response.status,
      response: parsed?.message ?? "ok",
    });
  }

  async ensureEventSubscription(broadcasterUserIdOverride?: string): Promise<void> {
    const broadcasterUserId = broadcasterUserIdOverride ?? this.config.kickBroadcasterUserId;
    if (!broadcasterUserId) {
      throw new Error("Missing broadcaster user id for Kick events subscription");
    }
    const token = await this.authClient.getAccessToken();
    const url = new URL(this.config.kickEventsSubscribePath, this.config.kickApiBaseUrl);
    const broadcasterIdNumber = Number.parseInt(broadcasterUserId, 10);
    const broadcaster_user_id = Number.isFinite(broadcasterIdNumber)
      ? broadcasterIdNumber
      : broadcasterUserId;
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        broadcaster_user_id,
        method: "webhook",
        events: this.config.kickWebhookEvents.map((name) => ({
          name,
          version: 1,
        })),
      }),
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kick events subscription failed (${response.status}): ${text}`);
    }
    logger.info("Kick events subscription ensured", {
      events: this.config.kickWebhookEvents,
      webhookPath: this.config.kickWebhookPath,
    });
  }

  async fetchWebhookPublicKeyPem(): Promise<string> {
    const url = new URL(this.config.kickPublicKeyPath, this.config.kickApiBaseUrl);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "content-type": "application/json",
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kick public key fetch failed (${response.status}): ${text}`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const key = json.public_key ?? json.publicKey ?? json.key;
    if (typeof key !== "string" || !key.includes("BEGIN PUBLIC KEY")) {
      throw new Error("Kick public key response did not contain a valid PEM key");
    }
    return key;
  }

  async resolveBroadcasterUserIdBySlug(slug: string): Promise<string> {
    const normalized = slug.trim().toLowerCase();
    if (!normalized) {
      throw new Error("Cannot resolve broadcaster id for empty channel slug");
    }
    const token = await this.authClient.getAccessToken();
    const url = new URL("/public/v1/channels", this.config.kickApiBaseUrl);
    url.searchParams.set("slug", normalized);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kick channel lookup failed (${response.status}): ${text}`);
    }
    const json = (await response.json()) as Record<string, unknown>;
    const data = (json.data as Array<Record<string, unknown>> | undefined) ?? [];
    if (data.length === 0) {
      throw new Error(`No Kick channel found for slug '${normalized}'`);
    }
    const item = data[0];
    const id =
      item.broadcaster_user_id ??
      item.user_id ??
      item.id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
    if (typeof id === "number" && Number.isFinite(id)) {
      return String(id);
    }
    throw new Error(`Kick channel lookup response missing broadcaster user id for slug '${normalized}'`);
  }
}
