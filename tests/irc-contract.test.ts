import test from "node:test";
import assert from "node:assert/strict";
import {
  buildInjectedVoteLine,
  buildWelcome001,
  parseIrcLine,
  parsePrivmsgTargetAndMessage,
} from "../src/shared/irc.ts";
import { normalizeVoteToken } from "../src/shared/votes.ts";

test("buildWelcome001 contains IRC 001 token", () => {
  const line = buildWelcome001("streamer");
  assert.match(line, / 001 streamer /);
  assert.ok(line.endsWith("\r\n"));
});

test("parses Twitch-like PRIVMSG lines", () => {
  const parsed = parseIrcLine("PRIVMSG #mychannel :UI/TwitchScrollPollStart");
  assert.ok(parsed);
  const msg = parsePrivmsgTargetAndMessage(parsed);
  assert.deepEqual(msg, {
    channel: "#mychannel",
    message: "UI/TwitchScrollPollStart",
  });
});

test("injects vote line in expected format", () => {
  const line = buildInjectedVoteLine("Viewer.One", "MyChannel", "#2");
  assert.equal(line, ":viewer_one!viewer_one@kick PRIVMSG #mychannel :#2\r\n");
});

test("normalizes supported vote tokens only", () => {
  assert.equal(normalizeVoteToken("1"), "#1");
  assert.equal(normalizeVoteToken("#2"), "#2");
  assert.equal(normalizeVoteToken(" 3 "), "#3");
  assert.equal(normalizeVoteToken("4"), null);
  assert.equal(normalizeVoteToken("foo"), null);
});
