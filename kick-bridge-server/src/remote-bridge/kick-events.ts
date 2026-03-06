import { normalizeVoteToken } from "../shared/votes.ts";

type KickChatEventPayload = {
  sender?: {
    id?: string | number;
    user_id?: string | number;
    username?: string;
    slug?: string;
    name?: string;
  };
  content?: string;
  message?: string;
  text?: string;
};

export type ExtractedKickVote = {
  username: string;
  voteText: string;
  senderId?: string;
  broadcasterUserId?: string;
  broadcasterChannelSlug?: string;
};

function parseSenderId(data: KickChatEventPayload | null): string | null {
  const id = data?.sender?.user_id ?? data?.sender?.id;
  if (typeof id === "string" && id.length > 0) {
    return id;
  }
  if (typeof id === "number" && Number.isFinite(id)) {
    return String(id);
  }
  return null;
}

function parseSenderName(data: KickChatEventPayload | null): string {
  return data?.sender?.username ?? data?.sender?.slug ?? data?.sender?.name ?? "kick_user";
}

function parseMessageText(data: KickChatEventPayload | null): string {
  return (data?.content ?? data?.message ?? data?.text ?? "").trim();
}

export function extractKickVoteFromWebhook(
  eventType: string,
  payload: Record<string, unknown>,
  subscribedEvents: string[],
  botUserId?: string,
): ExtractedKickVote | null {
  if (!eventType || !subscribedEvents.includes(eventType)) {
    return null;
  }
  const data = (payload as KickChatEventPayload | undefined) ?? null;
  const senderId = parseSenderId(data);
  if (botUserId && senderId && senderId === botUserId) {
    return null;
  }
  const voteText = normalizeVoteToken(parseMessageText(data));
  if (!voteText) {
    return null;
  }
  const broadcaster = (payload.broadcaster as Record<string, unknown> | undefined) ?? undefined;
  const broadcasterIdRaw = broadcaster?.user_id ?? broadcaster?.id;
  let broadcasterUserId: string | undefined;
  if (typeof broadcasterIdRaw === "string" && broadcasterIdRaw.length > 0) {
    broadcasterUserId = broadcasterIdRaw;
  } else if (typeof broadcasterIdRaw === "number" && Number.isFinite(broadcasterIdRaw)) {
    broadcasterUserId = String(broadcasterIdRaw);
  }
  const broadcasterChannelSlug =
    typeof broadcaster?.channel_slug === "string" && broadcaster.channel_slug.length > 0
      ? broadcaster.channel_slug.toLowerCase()
      : undefined;
  return {
    username: parseSenderName(data),
    voteText,
    senderId: senderId ?? undefined,
    broadcasterUserId,
    broadcasterChannelSlug,
  };
}
