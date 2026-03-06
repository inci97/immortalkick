import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { logger } from "../shared/logger.ts";
import type { RemoteBridgeConfig } from "./config.ts";

type KickTokenResponse = {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
};

export type KickTokenStore = {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
  scope?: string;
  expiresAt: string;
  updatedAt: string;
};

export class KickAuthClient {
  private cache: KickTokenStore | null = null;
  private readonly config: RemoteBridgeConfig;

  constructor(config: RemoteBridgeConfig) {
    this.config = config;
  }

  buildAuthorizeUrl(state: string, codeChallenge: string): string {
    const url = new URL("/oauth/authorize", this.config.kickAuthBaseUrl);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.kickClientId);
    url.searchParams.set("redirect_uri", this.config.kickRedirectUri);
    url.searchParams.set("scope", this.config.kickScopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  async getAccessToken(): Promise<string> {
    const token = await this.loadToken();
    if (!token) {
      throw new Error("Kick OAuth token not found; complete /oauth/start flow first");
    }
    const expiresAtMs = Date.parse(token.expiresAt);
    const nearExpiry = Date.now() + 60_000 >= expiresAtMs;
    if (!nearExpiry) {
      return token.accessToken;
    }
    logger.info("Kick token near expiration, refreshing");
    const refreshed = await this.refreshToken(token.refreshToken);
    await this.persist(refreshed);
    return refreshed.accessToken;
  }

  async exchangeAuthorizationCode(code: string, codeVerifier: string): Promise<KickTokenStore> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      client_id: this.config.kickClientId,
      client_secret: this.config.kickClientSecret,
      redirect_uri: this.config.kickRedirectUri,
      code,
      code_verifier: codeVerifier,
    });
    const response = await fetch(new URL("/oauth/token", this.config.kickAuthBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kick auth code exchange failed (${response.status}): ${text}`);
    }
    const json = (await response.json()) as KickTokenResponse;
    const token = this.fromResponse(json);
    await this.persist(token);
    return token;
  }

  async loadToken(): Promise<KickTokenStore | null> {
    if (this.cache) {
      return this.cache;
    }
    try {
      const raw = await readFile(this.config.kickTokenFile, "utf8");
      const parsed = JSON.parse(raw) as KickTokenStore;
      if (!parsed.accessToken || !parsed.refreshToken || !parsed.expiresAt) {
        return null;
      }
      this.cache = parsed;
      return parsed;
    } catch {
      return null;
    }
  }

  private async refreshToken(refreshToken: string): Promise<KickTokenStore> {
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: this.config.kickClientId,
      client_secret: this.config.kickClientSecret,
    });
    const response = await fetch(new URL("/oauth/token", this.config.kickAuthBaseUrl), {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Kick token refresh failed (${response.status}): ${text}`);
    }
    const json = (await response.json()) as KickTokenResponse;
    return this.fromResponse(json);
  }

  private fromResponse(response: KickTokenResponse): KickTokenStore {
    const now = Date.now();
    const expiresAt = new Date(now + response.expires_in * 1000).toISOString();
    return {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      tokenType: response.token_type,
      scope: response.scope,
      expiresAt,
      updatedAt: new Date(now).toISOString(),
    };
  }

  private async persist(token: KickTokenStore): Promise<void> {
    const directory = path.dirname(this.config.kickTokenFile);
    await mkdir(directory, { recursive: true });
    await writeFile(this.config.kickTokenFile, `${JSON.stringify(token, null, 2)}\n`, "utf8");
    this.cache = token;
    logger.info("Persisted Kick token file", { path: this.config.kickTokenFile });
  }
}

export function createPkcePair(): { codeVerifier: string; codeChallenge: string } {
  const verifier = randomBytes(64).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return {
    codeVerifier: verifier,
    codeChallenge: challenge,
  };
}
