import test from "node:test";
import assert from "node:assert/strict";
import { parseBridgeMessage, stringifyBridgeMessage } from "../src/shared/protocol.ts";

test("round-trips vote.inject payload", () => {
  const raw = stringifyBridgeMessage({
    type: "vote.inject",
    payload: {
      sessionId: "s-1",
      username: "user",
      voteText: "#3",
      ts: new Date().toISOString(),
    },
  });
  const parsed = parseBridgeMessage(raw);
  assert.ok(parsed);
  assert.equal(parsed?.type, "vote.inject");
});

test("rejects malformed payload", () => {
  const parsed = parseBridgeMessage(JSON.stringify({ type: "vote.inject", payload: { sessionId: "x" } }));
  assert.equal(parsed, null);
});
