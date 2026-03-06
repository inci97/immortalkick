import test from "node:test";
import assert from "node:assert/strict";
import { isSocksDestinationAllowed, parseSocks5ConnectRequest } from "../src/local-proxy/socks5.ts";

function buildDomainConnectRequest(host: string, port: number): Buffer {
  const hostBuffer = Buffer.from(host, "utf8");
  const frame = Buffer.alloc(4 + 1 + hostBuffer.length + 2);
  frame[0] = 0x05;
  frame[1] = 0x01;
  frame[2] = 0x00;
  frame[3] = 0x03;
  frame[4] = hostBuffer.length;
  hostBuffer.copy(frame, 5);
  frame.writeUInt16BE(port, 5 + hostBuffer.length);
  return frame;
}

test("parses SOCKS5 CONNECT domain request", () => {
  const request = buildDomainConnectRequest("irc.twitch.tv", 6667);
  const parsed = parseSocks5ConnectRequest(request);
  assert.ok(parsed);
  assert.equal(parsed?.destination.host, "irc.twitch.tv");
  assert.equal(parsed?.destination.port, 6667);
});

test("destination allowlist logic works for port and host", () => {
  const allowed = isSocksDestinationAllowed(
    { host: "irc.twitch.tv", port: 6667 },
    {
      allowedDestPort: 6667,
      allowedDestHosts: ["irc.twitch.tv"],
      allowedDestIps: [],
    },
  );
  assert.equal(allowed, true);

  const blockedPort = isSocksDestinationAllowed(
    { host: "irc.twitch.tv", port: 6666 },
    {
      allowedDestPort: 6667,
      allowedDestHosts: ["irc.twitch.tv"],
      allowedDestIps: [],
    },
  );
  assert.equal(blockedPort, false);

  const blockedHost = isSocksDestinationAllowed(
    { host: "example.com", port: 6667 },
    {
      allowedDestPort: 6667,
      allowedDestHosts: ["irc.twitch.tv"],
      allowedDestIps: [],
    },
  );
  assert.equal(blockedHost, false);
});

test("empty host/ip allowlists allow all hosts on configured port", () => {
  const allowed = isSocksDestinationAllowed(
    { host: "34.212.92.60", port: 6667 },
    {
      allowedDestPort: 6667,
      allowedDestHosts: [],
      allowedDestIps: [],
    },
  );
  assert.equal(allowed, true);
});
