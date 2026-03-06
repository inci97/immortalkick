export type ParsedIrcLine = {
  raw: string;
  command: string;
  params: string[];
  trailing?: string;
};

export function splitIrcLines(chunk: Buffer | string): string[] {
  const text = typeof chunk === "string" ? chunk : chunk.toString("utf8");
  return text
    .split(/\r\n|\n/g)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function parseIrcLine(rawLine: string): ParsedIrcLine | null {
  const line = rawLine.trim();
  if (line.length === 0) {
    return null;
  }

  let body = line;
  if (body.startsWith(":")) {
    const firstSpace = body.indexOf(" ");
    if (firstSpace === -1) {
      return null;
    }
    body = body.slice(firstSpace + 1);
  }

  const firstColon = body.indexOf(" :");
  let trailing: string | undefined;
  if (firstColon >= 0) {
    trailing = body.slice(firstColon + 2);
    body = body.slice(0, firstColon);
  }

  const tokens = body
    .trim()
    .split(/\s+/)
    .filter((token) => token.length > 0);
  if (tokens.length === 0) {
    return null;
  }
  const [command, ...params] = tokens;
  return {
    raw: line,
    command: command.toUpperCase(),
    params,
    trailing,
  };
}

export function parsePrivmsgTargetAndMessage(parsed: ParsedIrcLine): { channel: string; message: string } | null {
  if (parsed.command !== "PRIVMSG") {
    return null;
  }
  if (parsed.params.length < 1 || parsed.trailing === undefined) {
    return null;
  }
  return {
    channel: parsed.params[0],
    message: parsed.trailing,
  };
}

export function buildWelcome001(nick: string): string {
  return `:tmi.twitch.tv 001 ${nick} :Welcome, GLHF!\r\n`;
}

export function buildJoinAck(channelName: string): string {
  return `:${channelName}!${channelName}@tmi.twitch.tv JOIN #${channelName}\r\n`;
}

export function buildPingPong(payload: string): string {
  return `PONG :${payload}\r\n`;
}

export function sanitizeKickUsername(username: string): string {
  const cleaned = username
    .toLowerCase()
    .replace(/[^a-z0-9_]/g, "_")
    .slice(0, 24);
  return cleaned.length > 0 ? cleaned : "kick_user";
}

export function buildInjectedVoteLine(username: string, channelName: string, voteText: string): string {
  const user = sanitizeKickUsername(username);
  return `:${user}!${user}@kick PRIVMSG #${channelName.toLowerCase()} :${voteText}\r\n`;
}
