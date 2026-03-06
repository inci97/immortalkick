export type BridgeMessage =
  | SessionHelloMessage
  | GameChatOutMessage
  | SessionClosedMessage
  | VoteInjectMessage
  | SessionStateMessage
  | ErrorMessage;

export type LocalToRemoteMessage =
  | SessionHelloMessage
  | GameChatOutMessage
  | SessionClosedMessage;

export type RemoteToLocalMessage =
  | VoteInjectMessage
  | SessionStateMessage
  | ErrorMessage;

export type SessionHelloMessage = {
  type: "session.hello";
  payload: {
    sessionId: string;
    channelName: string;
    nick: string;
    startedAt: string;
  };
};

export type GameChatOutMessage = {
  type: "game.chat_out";
  payload: {
    sessionId: string;
    channelName: string;
    message: string;
    rawLine: string;
    ts: string;
  };
};

export type SessionClosedMessage = {
  type: "session.closed";
  payload: {
    sessionId: string;
    ts: string;
  };
};

export type VoteInjectMessage = {
  type: "vote.inject";
  payload: {
    sessionId: string;
    username: string;
    voteText: string;
    ts: string;
  };
};

export type SessionStateMessage = {
  type: "session.state";
  payload: {
    sessionId: string;
    connected: boolean;
    reason?: string;
  };
};

export type ErrorMessage = {
  type: "error";
  payload: {
    code: string;
    message: string;
  };
};

export function parseBridgeMessage(raw: string): BridgeMessage | null {
  try {
    const parsed = JSON.parse(raw) as { type?: string; payload?: unknown };
    if (!parsed || typeof parsed.type !== "string") {
      return null;
    }
    if (parsed.type === "session.hello") {
      const p = parsed.payload as SessionHelloMessage["payload"];
      if (!p || !p.sessionId || !p.channelName || !p.nick || !p.startedAt) {
        return null;
      }
      return { type: "session.hello", payload: p };
    }
    if (parsed.type === "game.chat_out") {
      const p = parsed.payload as GameChatOutMessage["payload"];
      if (!p || !p.sessionId || !p.channelName || !p.message || !p.rawLine || !p.ts) {
        return null;
      }
      return { type: "game.chat_out", payload: p };
    }
    if (parsed.type === "session.closed") {
      const p = parsed.payload as SessionClosedMessage["payload"];
      if (!p || !p.sessionId || !p.ts) {
        return null;
      }
      return { type: "session.closed", payload: p };
    }
    if (parsed.type === "vote.inject") {
      const p = parsed.payload as VoteInjectMessage["payload"];
      if (!p || !p.sessionId || !p.username || !p.voteText || !p.ts) {
        return null;
      }
      return { type: "vote.inject", payload: p };
    }
    if (parsed.type === "session.state") {
      const p = parsed.payload as SessionStateMessage["payload"];
      if (!p || !p.sessionId || typeof p.connected !== "boolean") {
        return null;
      }
      return { type: "session.state", payload: p };
    }
    if (parsed.type === "error") {
      const p = parsed.payload as ErrorMessage["payload"];
      if (!p || !p.code || !p.message) {
        return null;
      }
      return { type: "error", payload: p };
    }
    return null;
  } catch {
    return null;
  }
}

export function stringifyBridgeMessage(message: BridgeMessage): string {
  return JSON.stringify(message);
}
