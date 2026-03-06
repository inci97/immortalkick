# Kick Bridge Server (Vercel)

This folder contains only the remote server/API part of the project, prepared for Vercel deployment.

## What It Exposes

1. `GET /health`
1. `GET /oauth/start`
1. `GET /oauth/callback`
1. `POST /kick/bootstrap`
1. `POST /webhooks/kick` (or custom `KICK_WEBHOOK_PATH`)
1. `POST /api/local/event` (local proxy -> server)
1. `GET /api/local/poll` (local proxy <- server)

## Deploy To Vercel

1. Push this folder to a GitHub repo.
1. Create a Vercel project from that repo.
1. Add all env vars from `.env.example` into Vercel project settings.
1. Set `WEBHOOK_PUBLIC_URL` to your Vercel production URL (for example `https://your-app.vercel.app`).
1. Set `KICK_REDIRECT_URI` to `https://your-app.vercel.app/oauth/callback`.
1. Deploy.

## Local Proxy Settings (Game Machine)

In local proxy `.env.local`:

1. `REMOTE_BRIDGE_MODE=http_poll`
1. `REMOTE_BRIDGE_HTTP_BASE_URL=https://your-app.vercel.app`
1. `REMOTE_BRIDGE_TOKEN=<same as LOCAL_PROXY_SHARED_TOKEN on server>`

## Notes

1. Game-side DLL patch should point to local proxy (`127.000.000.1`), not directly to Vercel.
1. Direct chat voting mode stays enabled by default (`RELAY_GAME_CHAT_TO_KICK=false`).
