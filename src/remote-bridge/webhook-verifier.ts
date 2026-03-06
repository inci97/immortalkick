import { createVerify } from "node:crypto";

export type KickWebhookHeaders = {
  messageId?: string;
  timestamp?: string;
  signature?: string;
};

export type VerifyResult =
  | { ok: true; messageId: string }
  | { ok: false; reason: string };

export class KickWebhookVerifier {
  private readonly seen = new Map<string, number>();
  private readonly getPublicKeyPem: () => Promise<string>;
  private readonly maxAgeMs: number;

  constructor(getPublicKeyPem: () => Promise<string>, maxAgeMs = 10 * 60_000) {
    this.getPublicKeyPem = getPublicKeyPem;
    this.maxAgeMs = maxAgeMs;
  }

  async verify(headers: KickWebhookHeaders, rawBody: Buffer): Promise<VerifyResult> {
    const messageId = headers.messageId?.trim();
    const timestamp = headers.timestamp?.trim();
    const signature = headers.signature?.trim();

    if (!messageId || !timestamp || !signature) {
      return { ok: false, reason: "Missing signature headers" };
    }
    const timestampMs = parseTimestampMs(timestamp);
    if (timestampMs === null) {
      return { ok: false, reason: "Invalid timestamp header" };
    }
    if (Math.abs(Date.now() - timestampMs) > this.maxAgeMs) {
      return { ok: false, reason: "Webhook timestamp outside allowed age window" };
    }

    this.cleanupSeen(Date.now());
    if (this.seen.has(messageId)) {
      return { ok: false, reason: "Duplicate webhook message id" };
    }

    const key = await this.getPublicKeyPem();
    const signedPayload = `${messageId}.${timestamp}.${rawBody.toString("utf8")}`;
    const verifier = createVerify("RSA-SHA256");
    verifier.update(signedPayload);
    verifier.end();
    const valid = verifier.verify(key, signature, "base64");
    if (!valid) {
      return { ok: false, reason: "Invalid webhook signature" };
    }

    this.seen.set(messageId, Date.now() + this.maxAgeMs);
    return { ok: true, messageId };
  }

  private cleanupSeen(nowMs: number): void {
    for (const [id, expiry] of this.seen.entries()) {
      if (expiry <= nowMs) {
        this.seen.delete(id);
      }
    }
  }
}

function parseTimestampMs(input: string): number | null {
  const parsedDate = Date.parse(input);
  if (Number.isFinite(parsedDate)) {
    return parsedDate;
  }

  const raw = Number.parseInt(input, 10);
  if (!Number.isFinite(raw)) {
    return null;
  }
  if (input.length <= 10) {
    return raw * 1000;
  }
  return raw;
}
