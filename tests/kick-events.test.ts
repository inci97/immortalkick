import test from "node:test";
import assert from "node:assert/strict";
import { extractKickVoteFromWebhook } from "../src/remote-bridge/kick-events.ts";

test("extracts #2 vote from chat.message.sent payload", () => {
  const vote = extractKickVoteFromWebhook(
    "chat.message.sent",
    {
      sender: {
        user_id: "1234",
        username: "viewer123",
      },
      content: "#2",
    },
    ["chat.message.sent"],
    "9999",
  );
  assert.deepEqual(vote, {
    broadcasterChannelSlug: undefined,
    broadcasterUserId: undefined,
    senderId: "1234",
    username: "viewer123",
    voteText: "#2",
  });
});

test("filters bot author and non-votes", () => {
  const fromBot = extractKickVoteFromWebhook(
    "chat.message.sent",
    {
      sender: { user_id: "55", username: "mybot" },
      content: "#1",
    },
    ["chat.message.sent"],
    "55",
  );
  assert.equal(fromBot, null);

  const nonVote = extractKickVoteFromWebhook(
    "chat.message.sent",
    {
      sender: { user_id: "123", username: "viewer" },
      content: "hello",
    },
    ["chat.message.sent"],
    "55",
  );
  assert.equal(nonVote, null);
});
