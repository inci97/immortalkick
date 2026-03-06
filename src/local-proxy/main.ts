import { randomUUID } from "node:crypto";
import net, { type Socket } from "node:net";
import { loadLocalProxyConfig } from "./config.ts";
import { logger } from "../shared/logger.ts";
import { loadEnvFile } from "../shared/dotenv-lite.ts";
import {
  buildInjectedVoteLine,
  buildJoinAck,
  buildPingPong,
  buildWelcome001,
  parseIrcLine,
  parsePrivmsgTargetAndMessage,
} from "../shared/irc.ts";
import {
  parseBridgeMessage,
  stringifyBridgeMessage,
  type LocalToRemoteMessage,
  type RemoteToLocalMessage,
} from "../shared/protocol.ts";
import { normalizeVoteToken } from "../shared/votes.ts";
import { Socks5RedirectServer } from "./socks5.ts";

type SessionInfo = {
  sessionId: string;
  channelName: string;
  nick: string;
  startedAt: string;
};

class RemoteBridgeClient {
  private ws: WebSocket | null = null;
  private readonly queue: LocalToRemoteMessage[] = [];
  private reconnectDelayMs: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private session: SessionInfo | null = null;
  private stopped = false;
  private flushingHttp = false;
  private pollingHttp = false;
  private lastHelloAt = 0;
  private readonly config: ReturnType<typeof loadLocalProxyConfig>;
  private readonly onRemoteMessage: (message: RemoteToLocalMessage) => void;

  constructor(
    config: ReturnType<typeof loadLocalProxyConfig>,
    onRemoteMessage: (message: RemoteToLocalMessage) => void,
  ) {
    this.config = config;
    this.onRemoteMessage = onRemoteMessage;
    this.reconnectDelayMs = config.reconnectMinMs;
  }

  start(): void {
    this.stopped = false;
    if (this.config.remoteBridgeMode === "http_poll") {
      this.startHttpPollLoop();
      this.flushQueue();
      return;
    }
    this.connect();
  }

  stop(): void {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  setSession(session: SessionInfo | null): void {
    this.session = session;
    if (!session) {
      this.lastHelloAt = 0;
    }
    if (session) {
      this.enqueue({
        type: "session.hello",
        payload: {
          sessionId: session.sessionId,
          channelName: session.channelName,
          nick: session.nick,
          startedAt: session.startedAt,
        },
      });
      return;
    }
  }

  send(message: LocalToRemoteMessage): void {
    this.enqueue(message);
  }

  private enqueue(message: LocalToRemoteMessage): void {
    if (this.queue.length >= this.config.outboundQueueMax) {
      this.queue.shift();
      logger.warn("Dropped oldest outbound message due to backpressure", {
        queueSize: this.queue.length,
      });
    }
    this.queue.push(message);
    this.flushQueue();
  }

  private connect(): void {
    if (this.stopped || this.ws) {
      return;
    }
    const url = new URL(this.config.remoteBridgeWssUrl);
    url.searchParams.set("token", this.config.remoteBridgeToken);
    logger.info("Connecting to remote bridge", { remoteBridgeWssUrl: this.config.remoteBridgeWssUrl });
    const ws = new WebSocket(url);
    this.ws = ws;

    ws.addEventListener("open", () => {
      logger.info("Remote bridge websocket connected");
      this.reconnectDelayMs = this.config.reconnectMinMs;
      this.flushQueue();
      if (this.session) {
        this.enqueue({
          type: "session.hello",
          payload: {
            sessionId: this.session.sessionId,
            channelName: this.session.channelName,
            nick: this.session.nick,
            startedAt: this.session.startedAt,
          },
        });
      }
    });

    ws.addEventListener("message", (event) => {
      if (typeof event.data !== "string") {
        return;
      }
      const parsed = parseBridgeMessage(event.data);
      if (!parsed) {
        logger.warn("Received invalid websocket payload from remote bridge");
        return;
      }
      if (parsed.type === "vote.inject" || parsed.type === "session.state" || parsed.type === "error") {
        this.onRemoteMessage(parsed);
      }
    });

    ws.addEventListener("error", (event) => {
      logger.warn("Remote bridge websocket error", {
        error: String((event as Event).type ?? "unknown"),
      });
    });

    ws.addEventListener("close", (event) => {
      logger.warn("Remote bridge websocket closed", {
        code: event.code,
        reason: event.reason || "no-reason",
      });
      this.ws = null;
      if (!this.stopped) {
        this.scheduleReconnect();
      }
    });
  }

  private flushQueue(): void {
    if (this.config.remoteBridgeMode === "http_poll") {
      void this.flushHttpQueue();
      return;
    }
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }
    while (this.queue.length > 0) {
      const message = this.queue.shift();
      if (!message) {
        continue;
      }
      this.ws.send(stringifyBridgeMessage(message));
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.stopped) {
      return;
    }
    const waitMs = this.reconnectDelayMs;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, waitMs);
    this.reconnectDelayMs = Math.min(this.config.reconnectMaxMs, this.reconnectDelayMs * 2);
    logger.info("Scheduled reconnect to remote bridge", { waitMs });
  }

  private startHttpPollLoop(): void {
    if (this.pollTimer) {
      return;
    }
    const tick = () => {
      if (this.stopped) {
        return;
      }
      if (this.session) {
        this.maybeSendHttpSessionHello();
        void this.pollHttpMessages();
      }
      void this.flushHttpQueue();
    };
    tick();
    this.pollTimer = setInterval(tick, this.config.pollIntervalMs);
  }

  private async flushHttpQueue(): Promise<void> {
    if (this.flushingHttp || this.stopped) {
      return;
    }
    this.flushingHttp = true;
    try {
      while (this.queue.length > 0) {
        const next = this.queue[0];
        const ok = await this.postHttpEvent(next);
        if (!ok) {
          break;
        }
        this.queue.shift();
      }
    } finally {
      this.flushingHttp = false;
    }
  }

  private async postHttpEvent(message: LocalToRemoteMessage): Promise<boolean> {
    const response = await this.httpRequest("/api/local/event", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.config.remoteBridgeToken}`,
      },
      body: JSON.stringify(message),
    });
    if (!response) {
      return false;
    }
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      logger.warn("HTTP event post to remote bridge failed", {
        status: response.status,
        detail,
      });
      return false;
    }
    if (message.type === "session.hello") {
      this.lastHelloAt = Date.now();
    }
    return true;
  }

  private async pollHttpMessages(): Promise<void> {
    if (this.pollingHttp || !this.session || this.stopped) {
      return;
    }
    this.pollingHttp = true;
    try {
      const query = new URLSearchParams({
        sessionId: this.session.sessionId,
      });
      const response = await this.httpRequest(`/api/local/poll?${query.toString()}`, {
        method: "GET",
        headers: {
          authorization: `Bearer ${this.config.remoteBridgeToken}`,
        },
      });
      if (!response) {
        return;
      }
      if (!response.ok) {
        const detail = await response.text().catch(() => "");
        logger.warn("HTTP poll from remote bridge failed", {
          status: response.status,
          detail,
        });
        return;
      }
      const body = (await response.json().catch(() => null)) as
        | { messages?: unknown[] }
        | null;
      const messages = Array.isArray(body?.messages) ? body.messages : [];
      for (const item of messages) {
        const parsed = parseBridgeMessage(JSON.stringify(item));
        if (!parsed) {
          continue;
        }
        if (parsed.type === "vote.inject" || parsed.type === "session.state" || parsed.type === "error") {
          this.onRemoteMessage(parsed);
        }
      }
    } finally {
      this.pollingHttp = false;
    }
  }

  private async httpRequest(path: string, init: RequestInit): Promise<Response | null> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.config.httpRequestTimeoutMs);
      const url = new URL(path, this.config.remoteBridgeHttpBaseUrl);
      const response = await fetch(url, {
        ...init,
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response;
    } catch (error) {
      logger.warn("HTTP request to remote bridge failed", {
        path,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private maybeSendHttpSessionHello(): void {
    if (!this.session) {
      return;
    }
    const now = Date.now();
    if (now - this.lastHelloAt < this.config.helloIntervalMs) {
      return;
    }
    this.enqueue({
      type: "session.hello",
      payload: {
        sessionId: this.session.sessionId,
        channelName: this.session.channelName,
        nick: this.session.nick,
        startedAt: this.session.startedAt,
      },
    });
  }
}

class LocalIrcProxy {
  private server: net.Server;
  private activeSocket: Socket | null = null;
  private activeSession: SessionInfo | null = null;
  private lineBuffer = "";
  private readonly config: ReturnType<typeof loadLocalProxyConfig>;
  private readonly remoteBridgeClient: RemoteBridgeClient;

  constructor(config: ReturnType<typeof loadLocalProxyConfig>, remoteBridgeClient: RemoteBridgeClient) {
    this.config = config;
    this.remoteBridgeClient = remoteBridgeClient;
    this.server = net.createServer((socket) => this.handleConnection(socket));
  }

  start(): void {
    this.server.listen(this.config.localBindPort, this.config.localBindHost, () => {
      logger.info("Local IRC compatibility proxy listening", {
        host: this.config.localBindHost,
        port: this.config.localBindPort,
      });
    });
    this.server.on("error", (error) => {
      logger.error("Local IRC proxy server error", { error: error.message });
    });
  }

  stop(): void {
    this.server.close();
  }

  injectVote(sessionId: string, username: string, voteText: string): void {
    if (!this.activeSocket || !this.activeSession) {
      logger.warn("No active game connection to inject vote");
      return;
    }
    if (this.activeSession.sessionId !== sessionId) {
      logger.debug("Ignoring vote for inactive session", {
        expected: this.activeSession.sessionId,
        got: sessionId,
      });
      return;
    }
    const normalized = normalizeVoteToken(voteText);
    if (!normalized) {
      logger.debug("Ignoring invalid vote token from remote bridge", { voteText });
      return;
    }
    const line = buildInjectedVoteLine(username, this.activeSession.channelName, normalized);
    this.activeSocket.write(line);
    logger.debug("Injected synthetic IRC vote line", {
      sessionId,
      username,
      voteText: normalized,
    });
  }

  private handleConnection(socket: Socket): void {
    if (this.activeSocket) {
      socket.write(":tmi.twitch.tv NOTICE * :Only one game session is supported\r\n");
      socket.end();
      logger.warn("Rejected additional game connection");
      return;
    }
    this.activeSocket = socket;
    this.lineBuffer = "";
    const sessionId = randomUUID();
    const startedAt = new Date().toISOString();
    logger.info("Game connected to local IRC proxy", { sessionId });

    socket.on("data", (chunk) => this.handleSocketData(sessionId, startedAt, chunk));
    socket.on("error", (error) => {
      logger.warn("Game socket error", { sessionId, error: error.message });
    });
    socket.on("close", () => {
      logger.info("Game disconnected from local IRC proxy", { sessionId });
      if (this.activeSession?.sessionId === sessionId) {
        this.remoteBridgeClient.send({
          type: "session.closed",
          payload: {
            sessionId,
            ts: new Date().toISOString(),
          },
        });
      }
      this.activeSession = null;
      this.activeSocket = null;
      this.lineBuffer = "";
      this.remoteBridgeClient.setSession(null);
    });
  }

  private handleSocketData(sessionId: string, startedAt: string, chunk: Buffer): void {
    this.lineBuffer += chunk.toString("utf8");
    while (true) {
      const nextNewline = this.lineBuffer.indexOf("\n");
      if (nextNewline < 0) {
        break;
      }
      const raw = this.lineBuffer.slice(0, nextNewline).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(nextNewline + 1);
      this.handleRawLine(sessionId, startedAt, raw);
    }
    if (this.lineBuffer.length > 64 * 1024) {
      logger.warn("Resetting oversized IRC line buffer");
      this.lineBuffer = "";
    }
  }

  private handleRawLine(sessionId: string, startedAt: string, rawLine: string): void {
    const parsed = parseIrcLine(rawLine);
    if (!parsed) {
      return;
    }

    if (parsed.command === "PING" && this.activeSocket) {
      const payload = parsed.trailing ?? parsed.params[0] ?? "tmi.twitch.tv";
      this.activeSocket.write(buildPingPong(payload));
      return;
    }

    if (parsed.command === "PASS") {
      logger.debug("Received PASS from game", { sessionId });
      return;
    }

    if (parsed.command === "NICK") {
      const nick = (parsed.params[0] ?? "").toLowerCase();
      if (!nick || !this.activeSocket) {
        return;
      }
      this.activeSocket.write(buildWelcome001(nick));
      this.activeSession = {
        sessionId,
        channelName: nick,
        nick,
        startedAt,
      };
      this.remoteBridgeClient.setSession(this.activeSession);
      logger.info("Completed synthetic IRC welcome handshake", {
        sessionId,
        nick,
      });
      return;
    }

    if (parsed.command === "JOIN") {
      if (!this.activeSocket || !this.activeSession) {
        return;
      }
      const joinTarget = parsed.params[0] ?? `#${this.activeSession.channelName}`;
      const channel = joinTarget.replace(/^#/, "").toLowerCase();
      this.activeSession.channelName = channel;
      this.activeSocket.write(buildJoinAck(channel));
      logger.debug("Observed JOIN from game", { sessionId, channel });
      return;
    }

    if (parsed.command === "PRIVMSG") {
      const msg = parsePrivmsgTargetAndMessage(parsed);
      if (!msg || !this.activeSession) {
        return;
      }
      const channel = msg.channel.replace(/^#/, "").toLowerCase();
      this.activeSession.channelName = channel;
      this.remoteBridgeClient.send({
        type: "game.chat_out",
        payload: {
          sessionId,
          channelName: channel,
          message: msg.message,
          rawLine,
          ts: new Date().toISOString(),
        },
      });
      logger.debug("Forwarded game chat line to remote bridge", {
        sessionId,
        channel,
        messageLength: msg.message.length,
      });
      return;
    }

    logger.debug("Ignoring unhandled IRC command from game", {
      command: parsed.command,
    });
  }
}

function main(): void {
  loadEnvFile(".env.local");
  const config = loadLocalProxyConfig();
  const remoteBridge = new RemoteBridgeClient(config, (message) => {
    if (message.type === "vote.inject") {
      localProxy.injectVote(
        message.payload.sessionId,
        message.payload.username,
        message.payload.voteText,
      );
      return;
    }
    if (message.type === "session.state") {
      logger.info("Received session state from remote bridge", message.payload);
      return;
    }
    if (message.type === "error") {
      logger.warn("Remote bridge returned error", message.payload);
    }
  });
  const localProxy = new LocalIrcProxy(config, remoteBridge);
  const socks5Server = config.enableLocalSocks5Redirect
    ? new Socks5RedirectServer({
        bindHost: config.localSocks5BindHost,
        bindPort: config.localSocks5BindPort,
        redirectHost: config.socks5RedirectHost,
        redirectPort: config.socks5RedirectPort,
        allowedDestPort: config.socks5AllowedDestPort,
        allowedDestHosts: config.socks5AllowedDestHosts,
        allowedDestIps: config.socks5AllowedDestIps,
      })
    : null;
  remoteBridge.start();
  localProxy.start();
  socks5Server?.start();

  const shutdown = () => {
    logger.info("Shutting down local IRC proxy");
    socks5Server?.stop();
    localProxy.stop();
    remoteBridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main();
