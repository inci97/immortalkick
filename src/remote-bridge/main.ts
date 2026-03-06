import { randomUUID, timingSafeEqual } from "node:crypto";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import { URL } from "node:url";
import { logger } from "../shared/logger.ts";
import { readRawBody, sendJson } from "../shared/http.ts";
import { tryUpgradeToWebSocket, type MiniWsConnection } from "../shared/miniwss.ts";
import { loadEnvFile } from "../shared/dotenv-lite.ts";
import {
  parseBridgeMessage,
  stringifyBridgeMessage,
  type GameChatOutMessage,
  type LocalToRemoteMessage,
  type RemoteToLocalMessage,
} from "../shared/protocol.ts";
import { loadRemoteBridgeConfig } from "./config.ts";
import { createPkcePair, KickAuthClient } from "./kick-auth.ts";
import { KickApiClient } from "./kick-api.ts";
import { KickWebhookVerifier } from "./webhook-verifier.ts";
import { extractKickVoteFromWebhook } from "./kick-events.ts";

type ActiveSession = {
  sessionId: string;
  channelName: string;
  nick: string;
  startedAt: string;
  connection?: MiniWsConnection;
  broadcasterUserId?: string;
};

loadEnvFile(".env.remote");
const config = loadRemoteBridgeConfig();
const authClient = new KickAuthClient(config);
const kickApi = new KickApiClient(config, authClient);

let cachedPublicKeyPem = config.kickWebhookPublicKeyPem;
let publicKeyFetchedAt = 0;
const PUBLIC_KEY_TTL_MS = 60 * 60_000;

const verifier = new KickWebhookVerifier(async () => {
  const now = Date.now();
  if (cachedPublicKeyPem && now - publicKeyFetchedAt < PUBLIC_KEY_TTL_MS) {
    return cachedPublicKeyPem;
  }
  const key = await kickApi.fetchWebhookPublicKeyPem();
  cachedPublicKeyPem = key;
  publicKeyFetchedAt = now;
  logger.info("Fetched Kick webhook public key");
  return key;
});

const sessions = new Map<string, ActiveSession>();
const connToSessionIds = new Map<MiniWsConnection, Set<string>>();
const oauthStates = new Map<string, { expiresAt: number; codeVerifier: string }>();
const pendingMessagesBySession = new Map<string, RemoteToLocalMessage[]>();
const MAX_PENDING_MESSAGES_PER_SESSION = 300;

const outgoingQueue: GameChatOutMessage["payload"][] = [];
let processingQueue = false;
const OUTGOING_QUEUE_MAX = 1000;

function constantTimeTokenEqual(expected: string, got: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const gotBytes = Buffer.from(got);
  if (expectedBytes.length !== gotBytes.length) {
    return false;
  }
  return timingSafeEqual(expectedBytes, gotBytes);
}

function handleLocalMessage(connection: MiniWsConnection, rawMessage: string): void {
  const message = parseBridgeMessage(rawMessage);
  if (!message) {
    connection.sendJson({
      type: "error",
      payload: { code: "bad_message", message: "Invalid bridge message format" },
    } satisfies RemoteToLocalMessage);
    return;
  }
  if (!isLocalToRemoteMessage(message)) {
    connection.sendJson({
      type: "error",
      payload: { code: "bad_message_type", message: "Unsupported local message type" },
    } satisfies RemoteToLocalMessage);
    return;
  }
  processLocalBridgeMessage(message, connection);
}

function isLocalToRemoteMessage(message: { type: string }): message is LocalToRemoteMessage {
  return message.type === "session.hello" || message.type === "session.closed" || message.type === "game.chat_out";
}

function processLocalBridgeMessage(message: LocalToRemoteMessage, connection?: MiniWsConnection): void {
  if (message.type === "session.hello") {
    const existing = sessions.get(message.payload.sessionId);
    const session: ActiveSession = {
      sessionId: message.payload.sessionId,
      channelName: message.payload.channelName.toLowerCase(),
      nick: message.payload.nick.toLowerCase(),
      startedAt: message.payload.startedAt,
      broadcasterUserId: existing?.broadcasterUserId,
      connection: connection ?? existing?.connection,
    };
    sessions.set(session.sessionId, session);
    if (connection) {
      const owned = connToSessionIds.get(connection) ?? new Set<string>();
      owned.add(session.sessionId);
      connToSessionIds.set(connection, owned);
      connection.sendJson({
        type: "session.state",
        payload: {
          sessionId: session.sessionId,
          connected: true,
        },
      } satisfies RemoteToLocalMessage);
    } else {
      enqueuePendingMessage(session.sessionId, {
        type: "session.state",
        payload: {
          sessionId: session.sessionId,
          connected: true,
        },
      });
    }
    logger.info("Registered local session", {
      sessionId: session.sessionId,
      channelName: session.channelName,
      nick: session.nick,
      transport: connection ? "websocket" : "http",
    });
    void ensureSessionKickBinding(session.sessionId);
    return;
  }

  if (message.type === "session.closed") {
    sessions.delete(message.payload.sessionId);
    pendingMessagesBySession.delete(message.payload.sessionId);
    if (connection) {
      const owned = connToSessionIds.get(connection);
      if (owned) {
        owned.delete(message.payload.sessionId);
        if (owned.size === 0) {
          connToSessionIds.delete(connection);
        }
      }
      connection.sendJson({
        type: "session.state",
        payload: {
          sessionId: message.payload.sessionId,
          connected: false,
          reason: "session.closed",
        },
      } satisfies RemoteToLocalMessage);
    } else {
      enqueuePendingMessage(message.payload.sessionId, {
        type: "session.state",
        payload: {
          sessionId: message.payload.sessionId,
          connected: false,
          reason: "session.closed",
        },
      });
    }
    logger.info("Local session closed", { sessionId: message.payload.sessionId });
    return;
  }

  if (message.type === "game.chat_out") {
    if (!config.relayGameChatToKick) {
      logger.debug("Skipping outbound game chat relay (chat-direct voting mode)", {
        sessionId: message.payload.sessionId,
      });
      return;
    }
    enqueueOutgoingKickMessage(message.payload);
    return;
  }
}

function enqueueOutgoingKickMessage(payload: GameChatOutMessage["payload"]): void {
  if (outgoingQueue.length >= OUTGOING_QUEUE_MAX) {
    outgoingQueue.shift();
    logger.warn("Dropped oldest game chat outbound message due to queue pressure", {
      queueSize: outgoingQueue.length,
    });
  }
  outgoingQueue.push(payload);
  void processOutgoingQueue();
}

async function processOutgoingQueue(): Promise<void> {
  if (processingQueue) {
    return;
  }
  processingQueue = true;
  try {
    while (outgoingQueue.length > 0) {
      const item = outgoingQueue.shift();
      if (!item) {
        continue;
      }
      try {
        const session = sessions.get(item.sessionId);
        await kickApi.sendChatMessage(item.message, session?.broadcasterUserId);
        logger.debug("Relayed game chat to Kick", {
          sessionId: item.sessionId,
          channelName: item.channelName,
        });
      } catch (error) {
        logger.error("Failed relaying game chat to Kick", {
          sessionId: item.sessionId,
          error: error instanceof Error ? error.message : String(error),
        });
        const session = sessions.get(item.sessionId);
        session?.connection?.sendJson({
          type: "session.state",
          payload: {
            sessionId: item.sessionId,
            connected: false,
            reason: "kick_chat_send_failed",
          },
        } satisfies RemoteToLocalMessage);
      }
    }
  } finally {
    processingQueue = false;
  }
}

function cleanupConnection(connection: MiniWsConnection): void {
  const sessionIds = connToSessionIds.get(connection);
  if (!sessionIds) {
    return;
  }
  for (const sessionId of sessionIds) {
    sessions.delete(sessionId);
    pendingMessagesBySession.delete(sessionId);
    logger.info("Removed disconnected local session", { sessionId });
  }
  connToSessionIds.delete(connection);
}

function pickActiveSession(): ActiveSession | null {
  const active = [...sessions.values()];
  if (active.length === 0) {
    return null;
  }
  active.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return active[0];
}

async function ensureSessionKickBinding(sessionId: string): Promise<void> {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  try {
    const broadcasterUserId =
      config.kickBroadcasterUserId ??
      (await kickApi.resolveBroadcasterUserIdBySlug(session.channelName));
    session.broadcasterUserId = broadcasterUserId;
    await kickApi.ensureEventSubscription(broadcasterUserId);
    logger.info("Bound session to Kick broadcaster", {
      sessionId: session.sessionId,
      channelName: session.channelName,
      broadcasterUserId,
    });
  } catch (error) {
    logger.warn("Failed to bind session to Kick broadcaster", {
      sessionId,
      channelName: session.channelName,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function pickSessionForVote(extracted: ReturnType<typeof extractKickVoteFromWebhook>): ActiveSession | null {
  if (!extracted) {
    return null;
  }
  const all = [...sessions.values()];
  if (all.length === 0) {
    return null;
  }
  if (extracted.broadcasterUserId) {
    const byId = all.find((s) => s.broadcasterUserId === extracted.broadcasterUserId);
    if (byId) {
      return byId;
    }
  }
  if (extracted.broadcasterChannelSlug) {
    const slug = extracted.broadcasterChannelSlug.toLowerCase();
    const bySlug = all.find((s) => s.channelName === slug || s.nick === slug);
    if (bySlug) {
      return bySlug;
    }
  }
  return pickActiveSession();
}

function enqueuePendingMessage(sessionId: string, message: RemoteToLocalMessage): void {
  const queue = pendingMessagesBySession.get(sessionId) ?? [];
  if (queue.length >= MAX_PENDING_MESSAGES_PER_SESSION) {
    queue.shift();
  }
  queue.push(message);
  pendingMessagesBySession.set(sessionId, queue);
}

function drainPendingMessages(sessionId: string, limit: number): RemoteToLocalMessage[] {
  const queue = pendingMessagesBySession.get(sessionId) ?? [];
  if (queue.length === 0) {
    return [];
  }
  const take = Math.max(1, Math.min(limit, queue.length));
  const messages = queue.splice(0, take);
  if (queue.length === 0) {
    pendingMessagesBySession.delete(sessionId);
  } else {
    pendingMessagesBySession.set(sessionId, queue);
  }
  return messages;
}

function deliverToSession(session: ActiveSession, message: RemoteToLocalMessage): void {
  if (session.connection) {
    session.connection.sendText(stringifyBridgeMessage(message));
    return;
  }
  enqueuePendingMessage(session.sessionId, message);
}

async function handleWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    sendJson(res, 413, { error: "body_too_large", detail: String(error) });
    return;
  }

  const result = await verifier.verify(
    {
      messageId:
        (req.headers["kick-event-message-id"] as string | undefined) ??
        (req.headers["x-kick-event-message-id"] as string | undefined),
      timestamp:
        (req.headers["kick-event-message-timestamp"] as string | undefined) ??
        (req.headers["x-kick-event-message-timestamp"] as string | undefined),
      signature:
        (req.headers["kick-event-signature"] as string | undefined) ??
        (req.headers["x-kick-event-signature"] as string | undefined),
    },
    rawBody,
  );
  if (!result.ok) {
    logger.warn("Rejected Kick webhook", { reason: result.reason });
    sendJson(res, 401, { error: "invalid_signature", reason: result.reason });
    return;
  }

  let body: Record<string, unknown>;
  try {
    body = JSON.parse(rawBody.toString("utf8")) as Record<string, unknown>;
  } catch {
    sendJson(res, 400, { error: "invalid_json" });
    return;
  }

  const eventType =
    (req.headers["kick-event-type"] as string | undefined) ??
    (req.headers["x-kick-event-type"] as string | undefined) ??
    (typeof body.event === "string" ? body.event : "");
  const payload =
    ((body.data as Record<string, unknown> | undefined) ?? body);

  const extractedVote = extractKickVoteFromWebhook(
    eventType,
    payload,
    config.kickWebhookEvents,
    config.kickBotUserId,
  );
  if (!extractedVote) {
    sendJson(res, 202, { accepted: true, ignored: true, reason: "not_vote" });
    return;
  }

  const session = pickSessionForVote(extractedVote);
  if (!session) {
    sendJson(res, 202, { accepted: true, ignored: true, reason: "no_active_session" });
    return;
  }

  const outbound: RemoteToLocalMessage = {
    type: "vote.inject",
    payload: {
      sessionId: session.sessionId,
      username: extractedVote.username,
      voteText: extractedVote.voteText,
      ts: new Date().toISOString(),
    },
  };
  deliverToSession(session, outbound);
  logger.debug("Forwarded Kick vote to local session", {
    sessionId: session.sessionId,
    username: extractedVote.username,
    voteText: extractedVote.voteText,
  });
  sendJson(res, 200, { accepted: true, sessionId: session.sessionId, voteText: extractedVote.voteText });
}

function issueOAuthState(): string {
  const { codeChallenge, codeVerifier } = createPkcePair();
  const state = randomUUID();
  oauthStates.set(state, {
    expiresAt: Date.now() + 10 * 60_000,
    codeVerifier,
  });
  return authClient.buildAuthorizeUrl(state, codeChallenge);
}

function consumeOAuthState(state: string): string | null {
  const item = oauthStates.get(state);
  oauthStates.delete(state);
  if (!item) {
    return null;
  }
  if (Date.now() > item.expiresAt) {
    return null;
  }
  return item.codeVerifier;
}

function cleanupOAuthStates(): void {
  const now = Date.now();
  for (const [state, item] of oauthStates.entries()) {
    if (item.expiresAt <= now) {
      oauthStates.delete(state);
    }
  }
}

function extractBearerToken(req: IncomingMessage): string {
  const authorization = req.headers.authorization;
  if (!authorization || typeof authorization !== "string") {
    return "";
  }
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (!scheme || !token || scheme.toLowerCase() !== "bearer") {
    return "";
  }
  return token.trim();
}

function requireLocalApiAuth(req: IncomingMessage, res: ServerResponse): boolean {
  const token = extractBearerToken(req);
  if (!constantTimeTokenEqual(config.localProxySharedToken, token)) {
    sendJson(res, 401, { error: "unauthorized" });
    return false;
  }
  return true;
}

async function handleLocalHttpEvent(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!requireLocalApiAuth(req, res)) {
    return;
  }
  let rawBody: Buffer;
  try {
    rawBody = await readRawBody(req, 128 * 1024);
  } catch (error) {
    sendJson(res, 413, { error: "body_too_large", detail: String(error) });
    return;
  }
  const message = parseBridgeMessage(rawBody.toString("utf8"));
  if (!message || !isLocalToRemoteMessage(message)) {
    sendJson(res, 400, { error: "invalid_message" });
    return;
  }
  processLocalBridgeMessage(message);
  sendJson(res, 200, { ok: true });
}

function handleLocalHttpPoll(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!requireLocalApiAuth(req, res)) {
    return;
  }
  const sessionId = (url.searchParams.get("sessionId") ?? "").trim();
  if (!sessionId) {
    sendJson(res, 400, { error: "missing_session_id" });
    return;
  }
  const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Number.isFinite(rawLimit) ? Math.max(1, Math.min(200, rawLimit)) : 50;
  const messages = drainPendingMessages(sessionId, limit);
  sendJson(res, 200, { ok: true, messages });
}

async function routeRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (req.method === "POST" && url.pathname === "/api/local/event") {
    await handleLocalHttpEvent(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/local/poll") {
    handleLocalHttpPoll(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/health") {
    const pendingMessages = [...pendingMessagesBySession.values()].reduce((acc, q) => acc + q.length, 0);
    sendJson(res, 200, {
      ok: true,
      activeSessions: sessions.size,
      queuedMessages: outgoingQueue.length,
      pendingMessages,
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/oauth/start") {
    const redirect = issueOAuthState();
    res.statusCode = 302;
    res.setHeader("location", redirect);
    res.end();
    return;
  }

  if (req.method === "GET" && url.pathname === "/oauth/callback") {
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    const codeVerifier = state ? consumeOAuthState(state) : null;
    if (!code || !state || !codeVerifier) {
      sendJson(res, 400, {
        error: "invalid_oauth_state",
        detail: "Missing or invalid OAuth code/state",
      });
      return;
    }
    try {
      const token = await authClient.exchangeAuthorizationCode(code, codeVerifier);
      sendJson(res, 200, {
        ok: true,
        expiresAt: token.expiresAt,
        scope: token.scope,
      });
    } catch (error) {
      sendJson(res, 500, {
        error: "oauth_exchange_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === "/kick/bootstrap") {
    try {
      if (config.kickBroadcasterUserId) {
        await kickApi.ensureEventSubscription(config.kickBroadcasterUserId);
      } else {
        const session = pickActiveSession();
        if (!session?.broadcasterUserId) {
          sendJson(res, 409, {
            error: "missing_broadcaster_binding",
            detail: "Start game session first or set KICK_BROADCASTER_USER_ID",
          });
          return;
        }
        await kickApi.ensureEventSubscription(session.broadcasterUserId);
      }
      sendJson(res, 200, { ok: true });
    } catch (error) {
      sendJson(res, 500, {
        error: "subscription_failed",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (req.method === "POST" && url.pathname === config.kickWebhookPath) {
    await handleWebhook(req, res);
    return;
  }

  sendJson(res, 404, { error: "not_found" });
}

function handleUpgrade(req: IncomingMessage, socket: import("node:net").Socket, head: Buffer): void {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  if (url.pathname !== "/ws/local") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  const token = url.searchParams.get("token") ?? "";
  if (!constantTimeTokenEqual(config.localProxySharedToken, token)) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }

  let connectionRef: MiniWsConnection | null = null;
  const connection = tryUpgradeToWebSocket(req, socket, head, {
    onMessage: (rawMessage) => {
      if (!connectionRef) {
        return;
      }
      handleLocalMessage(connectionRef, rawMessage);
    },
    onClose: () => {
      if (!connectionRef) {
        return;
      }
      cleanupConnection(connectionRef);
    },
    onError: (error) => {
      logger.warn("Local websocket connection error", { error: error.message });
      if (!connectionRef) {
        return;
      }
      cleanupConnection(connectionRef);
    },
  });
  if (!connection) {
    return;
  }
  connectionRef = connection;
  logger.info("Accepted authenticated local proxy websocket connection");
}

async function bootstrapAtStartup(): Promise<void> {
  try {
    const token = await authClient.loadToken();
    if (!token) {
      logger.warn("Kick token is missing; complete OAuth with /oauth/start before chat relay");
      return;
    }
    if (config.kickBroadcasterUserId) {
      await kickApi.ensureEventSubscription(config.kickBroadcasterUserId);
    }
  } catch (error) {
    logger.warn("Kick bootstrap failed; service will continue and can be retried via /kick/bootstrap", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function main(): Promise<void> {
  const server = http.createServer((req, res) => {
    void routeRequest(req, res).catch((error) => {
      logger.error("Unhandled HTTP route error", {
        error: error instanceof Error ? error.message : String(error),
      });
      sendJson(res, 500, { error: "internal_error" });
    });
  });
  server.on("upgrade", handleUpgrade);
  server.on("error", (error) => {
    logger.error("Remote bridge server error", {
      error: error.message,
      host: config.remoteBindHost,
      port: config.remoteBindPort,
    });
  });
  server.listen(config.remoteBindPort, config.remoteBindHost, () => {
    logger.info("Remote Kick bridge listening", {
      host: config.remoteBindHost,
      port: config.remoteBindPort,
      webhookPath: config.kickWebhookPath,
    });
  });

  setInterval(cleanupOAuthStates, 60_000).unref();
  await bootstrapAtStartup();
}

export async function handleIncomingRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await routeRequest(req, res);
  } catch (error) {
    logger.error("Unhandled HTTP route error", {
      error: error instanceof Error ? error.message : String(error),
    });
    sendJson(res, 500, { error: "internal_error" });
  }
}

if (!process.env.VERCEL) {
  void main();
}
