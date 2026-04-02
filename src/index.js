const crypto = require('node:crypto');
const express = require('express');
const axios = require('axios');

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null ? fallback : String(v);
}

function base64url(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function hmacSig(secret, payload) {
  return base64url(crypto.createHmac('sha256', String(secret)).update(String(payload)).digest());
}

function pickConnectedAccounts(connections) {
  const out = { youtube: null, tiktok: null };
  const arr = Array.isArray(connections) ? connections : [];
  for (const c of arr) {
    const type = String(c?.type || '').toLowerCase();
    if (type === 'youtube' && !out.youtube) out.youtube = c?.name || c?.id || null;
    if (type === 'tiktok' && !out.tiktok) out.tiktok = c?.name || c?.id || null;
  }
  return out;
}

async function exchangeCodeForToken({ clientId, clientSecret, redirectUri, code }) {
  const body = new URLSearchParams();
  body.set('client_id', clientId);
  body.set('client_secret', clientSecret);
  body.set('grant_type', 'authorization_code');
  body.set('code', code);
  body.set('redirect_uri', redirectUri);

  const res = await axios.post('https://discord.com/api/v10/oauth2/token', body.toString(), {
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    timeout: 15000,
  });
  return res.data;
}

async function fetchDiscordUser(accessToken) {
  const res = await axios.get('https://discord.com/api/v10/users/@me', {
    headers: { authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
  return res.data;
}

async function fetchDiscordConnections(accessToken) {
  const res = await axios.get('https://discord.com/api/v10/users/@me/connections', {
    headers: { authorization: `Bearer ${accessToken}` },
    timeout: 15000,
  });
  return res.data;
}

async function postWebhook(webhookUrl, content) {
  await axios.post(
    webhookUrl,
    { content, allowed_mentions: { parse: [] } },
    { timeout: 15000, headers: { 'content-type': 'application/json' } },
  );
}

function html(title, body) {
  return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${title}</title>
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0b0f14; color:#e6edf3; padding:24px; }
      .card { max-width: 720px; margin: 0 auto; background:#121826; border:1px solid #263041; border-radius: 12px; padding: 18px 20px; }
      .muted { color:#9aa4b2; }
      code { background:#0f172a; padding:2px 6px; border-radius:8px; }
      a { color:#8ab4ff; }
    </style>
  </head>
  <body>
    <div class="card">${body}</div>
  </body>
</html>`;
}

const app = express();

app.get('/health', (req, res) => res.status(200).send('ok'));

app.get('/connect', (req, res) => {
  const clientId = env('DISCORD_CLIENT_ID').trim();
  const redirectUri = env('DISCORD_REDIRECT_URI').trim();
  if (!clientId || !redirectUri) {
    res.status(500).send('Missing DISCORD_CLIENT_ID or DISCORD_REDIRECT_URI.');
    return;
  }

  const u = new URL('https://discord.com/oauth2/authorize');
  u.searchParams.set('client_id', clientId);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', 'identify connections');
  u.searchParams.set('prompt', 'consent');
  res.redirect(u.toString());
});

app.get('/callback', async (req, res) => {
  const code = String(req.query.code || '').trim();
  if (!code) {
    res.status(400).send(html('AuraBot', '<h2>Missing code</h2><p class="muted">Go back and try again.</p>'));
    return;
  }

  const clientId = env('DISCORD_CLIENT_ID').trim();
  const clientSecret = env('DISCORD_CLIENT_SECRET').trim();
  const redirectUri = env('DISCORD_REDIRECT_URI').trim();
  const webhookUrl = env('DISCORD_RELAY_WEBHOOK_URL').trim();
  const relayPrefix = env('RELAY_PREFIX', 'CONNECTION_DATA').trim() || 'CONNECTION_DATA';
  const relaySecret = env('RELAY_HMAC_SECRET').trim();
  const postRedirect = env('POST_SUCCESS_REDIRECT').trim();

  if (!clientId || !clientSecret || !redirectUri) {
    res.status(500).send(html('AuraBot', '<h2>Server not configured</h2><p class="muted">Missing OAuth env vars.</p>'));
    return;
  }
  if (!webhookUrl) {
    res.status(500).send(html('AuraBot', '<h2>Server not configured</h2><p class="muted">Missing DISCORD_RELAY_WEBHOOK_URL.</p>'));
    return;
  }
  if (!relaySecret) {
    res.status(500).send(html('AuraBot', '<h2>Server not configured</h2><p class="muted">Missing RELAY_HMAC_SECRET.</p>'));
    return;
  }

  try {
    const token = await exchangeCodeForToken({ clientId, clientSecret, redirectUri, code });
    const accessToken = token?.access_token;
    if (!accessToken) throw new Error('Missing access token');

    const user = await fetchDiscordUser(accessToken);
    const connections = await fetchDiscordConnections(accessToken);
    const picked = pickConnectedAccounts(connections);

    const userId = String(user?.id || '').trim();
    if (!userId) throw new Error('Missing user id');

    const ts = String(Date.now());
    const payload = `${userId}|${picked.youtube || ''}|${picked.tiktok || ''}|${ts}`;
    const sig = hmacSig(relaySecret, payload);
    const content = `${relayPrefix}|${userId}|${picked.youtube || ''}|${picked.tiktok || ''}|${ts}|${sig}`;

    await postWebhook(webhookUrl, content);

    if (postRedirect) {
      res.redirect(postRedirect);
      return;
    }

    res
      .status(200)
      .send(
        html(
          'AuraBot Connected',
          `<h2>✅ Connected</h2>
           <p class="muted">Saved your connected accounts.</p>
           <ul>
             <li>YouTube: <strong>${picked.youtube || '—'}</strong></li>
             <li>TikTok: <strong>${picked.tiktok || '—'}</strong></li>
           </ul>
           <p class="muted">Go back to Discord and run <code>/creatorrank</code>.</p>`,
        ),
      );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    res.status(500).send(html('AuraBot Error', `<h2>Error</h2><p class="muted">${msg}</p>`));
  }
});

const port = Number(env('PORT', '3000')) || 3000;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Render auth relay listening on :${port}`);
});

