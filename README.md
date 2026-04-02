# Render Auth Relay (AuraBot)
This is a small OAuth2 callback server you can host on Render. It exchanges Discord's `code` for an access token **server-side**, fetches the user's Discord Connections, then relays only the extracted YouTube/TikTok connection names (no tokens) to your bot via a Discord webhook message.

## Endpoints
- `GET /health` → `ok`
- `GET /connect` → redirects to Discord OAuth2 authorize page
- `GET /callback?code=...` → exchanges code, fetches `/users/@me/connections`, relays `CONNECTION_DATA|...`, shows success page

## Environment variables
Copy `render-auth/.env.example` into Render's Environment settings:
- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_REDIRECT_URI` (must be `https://YOUR_RENDER_DOMAIN/callback`)
- `DISCORD_RELAY_WEBHOOK_URL` (webhook in your server `#auth-log` channel)
- `RELAY_HMAC_SECRET` (set the same value in your bot `.env` as `BOT4_RELAY_HMAC_SECRET`)

## Discord Developer Portal setup
Add your redirect URI:
- `https://YOUR_RENDER_DOMAIN/callback`

## Bot setup
In your bot `.env`:
- `BOT4_AUTH_LOG_CHANNEL=auth-log` (or set `BOT4_AUTH_LOG_CHANNEL_ID`)
- `BOT4_CONNECTION_DATA_ENABLED=1`
- `BOT4_RELAY_HMAC_SECRET=...` (must match `RELAY_HMAC_SECRET`)

## Relay message format
The server posts a message like:
`CONNECTION_DATA|USER_ID|YOUTUBE|TIKTOK|TS|SIG`

Your bot listens in `#auth-log`, verifies the HMAC signature, deletes the message, and stores the connected accounts.

