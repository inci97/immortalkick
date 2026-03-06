# Kick Compatibility Bridge for Immortal Redneck

This project keeps **Immortal Redneck unmodified** and makes its Twitch IRC integration work with Kick by bridging protocols.

## What It Implements

1. **Local IRC compatibility proxy** (`127.0.0.1:6667`)
1. **Optional local SOCKS5 redirect endpoint** (`127.0.0.1:1080`) for process-level routing on Windows
1. **Remote Kick bridge service** (HTTP API + optional WebSocket)
1. **Bridge protocol**:
   - Local -> Remote: `session.hello`, `game.chat_out`, `session.closed`
   - Remote -> Local: `vote.inject`, `session.state`
1. **Vote mode**: Kick chat pseudo-poll (`#1/#2/#3` or `1/2/3`)

## Protocol Contract Covered

1. Emulates Twitch IRC host/port expectation (`irc.twitch.tv:6667`) once traffic is routed to local proxy.
1. Accepts game login flow (`PASS`, `NICK`, waits for `001`, then `JOIN`).
1. Optionally forwards outbound `PRIVMSG #channel :message` lines to Kick chat (`RELAY_GAME_CHAT_TO_KICK=true`).
1. Injects synthetic IRC vote lines back to game:

```txt
:<username>!<username>@kick PRIVMSG #<channel> :<vote>\r\n
```

## Directory Layout

```txt
kick-compat-bridge/
  src/local-proxy/main.ts
  src/remote-bridge/main.ts
  src/shared/*
  tests/*.test.ts
  .env.local.example
  .env.remote.example
```

## Requirements

1. Node.js `>=25` (used with `--experimental-strip-types`).
1. Public HTTPS domain for the remote service webhook endpoint.
1. Kick developer app credentials.
1. Windows process-level TCP redirect tool (recommended: Proxifier) if you do not use hosts override.

## Configuration

1. Copy local config:

```bash
cp .env.local.example .env.local
```

2. Copy remote config:

```bash
cp .env.remote.example .env.remote
```

3. Set the same shared secret in both:
   - `REMOTE_BRIDGE_TOKEN` (local)
   - `LOCAL_PROXY_SHARED_TOKEN` (remote)
1. For Windows non-hosts mode, keep these in `.env.local`:
   - `ENABLE_LOCAL_SOCKS5_REDIRECT=true`
   - `LOCAL_SOCKS5_BIND_PORT=1080`
   - `SOCKS5_REDIRECT_HOST=127.0.0.1`
   - `SOCKS5_REDIRECT_PORT=6667`
   - `SOCKS5_ALLOWED_DEST_PORT=6667`
1. Channel binding mode:
   - If `KICK_BROADCASTER_USER_ID` is set, bridge uses it directly.
   - If empty, bridge auto-resolves channel from game `NICK` (Twitch username box) as Kick channel slug.
1. Vercel-compatible local->remote transport:
   - Set `REMOTE_BRIDGE_MODE=http_poll`
   - Set `REMOTE_BRIDGE_HTTP_BASE_URL=https://<your-vercel-domain>`
   - Keep same `REMOTE_BRIDGE_TOKEN` / `LOCAL_PROXY_SHARED_TOKEN`

## Kick App Setup (Full Onboarding)

1. Create a Kick app in the Kick developer dashboard.
1. Set redirect URI to exactly:
   - `https://<your-domain>/oauth/callback`
1. Collect:
   - `KICK_CLIENT_ID`
   - `KICK_CLIENT_SECRET`
   - `KICK_BROADCASTER_USER_ID` (optional; can be auto-resolved from game username)
   - `KICK_BOT_USER_ID`
1. Ensure app scopes include:
   - `chat:write`
   - `events:subscribe`
   - `user:read`

## Start Remote Bridge

```bash
npm run dev:remote
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

OAuth bootstrap:

1. Open `https://<your-domain>/oauth/start` in a browser.
1. Complete Kick authorization.
1. The bridge handles OAuth 2.1 PKCE (`S256`) automatically.
1. Confirm token file is created at `KICK_TOKEN_FILE`.

Subscribe webhook/event:

```bash
curl -X POST https://<your-domain>/kick/bootstrap
```

Webhook endpoint path is configurable with `KICK_WEBHOOK_PATH` (default `/webhooks/kick`).

## Start Local Proxy

```bash
npm run dev:local
```

## Windows Routing (No Hosts Override)

Recommended path for Windows: route `ImmortalRedneck.exe` IRC traffic through local SOCKS5.

1. Install and open Proxifier on Windows.
1. Add a SOCKS5 proxy server:
   - Address: `127.0.0.1`
   - Port: `1080`
   - Auth: none
1. Add a rule:
   - Applications: `ImmortalRedneck.exe`
   - Target hosts: `irc.twitch.tv`
   - Target ports: `6667`
   - Action: use the local SOCKS5 proxy above
1. Apply rules and launch the game.

The SOCKS server redirects allowed IRC connects to `127.0.0.1:6667` (the local IRC compatibility proxy).

## Runtime Order

1. Start remote bridge.
1. Start local proxy.
1. Ensure Proxifier rule is active (Windows non-hosts mode).
1. Launch game.
1. Begin Twitch-integrated poll flow in-game.
1. Kick chat users vote with `#1/#2/#3` (or `1/2/3`).

## Direct Chat Voting Mode

Default configuration uses direct chat voting:

1. `RELAY_GAME_CHAT_TO_KICK=false` (remote does not post poll lines to Kick).
1. Viewers type `1`, `2`, `3` (or `#1/#2/#3`) directly in Kick chat.
1. Bridge filters `chat.message.sent` events and injects valid votes to game.

## Security Behaviors

1. Local websocket requires shared token.
1. Local HTTP poll API requires the same bearer token.
1. Kick webhook signature verification:
   - Uses headers:
     - `Kick-Event-Message-Id`
     - `Kick-Event-Message-Timestamp`
     - `Kick-Event-Signature`
     - `Kick-Event-Type`
   - Verifies `RSA-SHA256` signature over:
     - `"{messageId}.{timestamp}.{rawBody}"`
1. Rejects duplicate webhook message IDs.
1. Rejects stale webhook timestamps.

## Test Suite

```bash
npm test
```

Covers:

1. IRC handshake and `PRIVMSG` parsing.
1. Vote token normalization and IRC vote injection format.
1. Webhook signature verification and duplicate-id rejection.
1. Kick vote extraction/filtering (event type, bot filtering, vote format).

## Failure Handling

1. If remote bridge is down:
   - Local proxy keeps game running.
   - WebSocket reconnect uses exponential backoff (websocket mode).
   - HTTP event queue retries on next poll/flush cycle (http poll mode).
1. If Kick send fails:
   - Error is logged with session id.
   - Session receives `session.state` disconnected reason.
1. Queue pressure:
   - Oldest outbound messages are dropped with warning logs.

## Rollback

1. Stop both bridge services.
1. Disable/remove Proxifier rule for `ImmortalRedneck.exe`.
1. Start game normally.
