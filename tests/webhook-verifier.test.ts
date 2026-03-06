import test from "node:test";
import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { KickWebhookVerifier } from "../src/remote-bridge/webhook-verifier.ts";

function signPayload(privateKeyPem: string, messageId: string, timestamp: string, rawBody: Buffer): string {
  const payload = `${messageId}.${timestamp}.${rawBody.toString("utf8")}`;
  const signer = createSign("RSA-SHA256");
  signer.update(payload);
  signer.end();
  return signer.sign(privateKeyPem, "base64");
}

test("valid Kick webhook signature is accepted and duplicate id is rejected", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
  const publicKeyPem = publicKey.export({ type: "pkcs1", format: "pem" }).toString();
  const verifier = new KickWebhookVerifier(async () => publicKeyPem);
  const rawBody = Buffer.from(JSON.stringify({ event: "chat.message.sent", data: { content: "#1" } }));
  const messageId = "msg-1";
  const timestamp = new Date().toISOString();
  const signature = signPayload(privateKeyPem, messageId, timestamp, rawBody);

  const first = await verifier.verify(
    { messageId, timestamp, signature },
    rawBody,
  );
  assert.equal(first.ok, true);

  const duplicate = await verifier.verify(
    { messageId, timestamp, signature },
    rawBody,
  );
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) {
    assert.match(duplicate.reason, /Duplicate/);
  }
});

test("invalid Kick webhook signature is rejected", async () => {
  const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const publicKeyPem = publicKey.export({ type: "pkcs1", format: "pem" }).toString();
  const verifier = new KickWebhookVerifier(async () => publicKeyPem);
  const rawBody = Buffer.from(JSON.stringify({ event: "chat.message.sent", data: { content: "#2" } }));

  const result = await verifier.verify(
    {
      messageId: "msg-2",
      timestamp: new Date().toISOString(),
      signature: "not-a-real-signature",
    },
    rawBody,
  );
  assert.equal(result.ok, false);
});
