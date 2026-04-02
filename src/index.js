/* Load env vars from a local .env file when present.
 * Note: Render normally expects env vars set in the dashboard; .env files are not
 * uploaded unless you commit them (not recommended for secrets). */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
// eslint-disable-next-line global-require
const dotenv = require('dotenv');

function tryLoadDotenv(dotenvPath) {
  try {
    if (!dotenvPath) return false;
    if (!fs.existsSync(dotenvPath)) return false;
    dotenv.config({ path: dotenvPath });
    // eslint-disable-next-line no-console
    console.log(`[render-auth] Loaded .env from ${dotenvPath}`);
    return true;
  } catch {
    return false;
  }
}

// Try CWD first (common when running from the render-auth folder), then script-relative.
tryLoadDotenv(path.join(process.cwd(), '.env'));
tryLoadDotenv(path.join(__dirname, '..', '.env'));

const crypto = require('node:crypto');
const express = require('express');
const axios = require('axios');

function env(name, fallback = '') {
  const v = process.env[name];
  return v == null ? fallback : String(v);
}

function resolveDataDir() {
  const explicit = env('DATA_DIR', '').trim();
  if (explicit) return explicit;

  // Render/production filesystems can be ephemeral or read-only in the repo dir.
  // Prefer OS temp directory in production-ish environments.
  const isProd = env('NODE_ENV', '').trim() === 'production' || Boolean(env('RENDER', '').trim());
  if (isProd) return path.join(os.tmpdir(), 'aurabot-render-auth');

  return path.join(__dirname, '..', 'data');
}

const DATA_DIR = resolveDataDir();
const CONNECTIONS_FILE = path.join(DATA_DIR, 'connections.json');

const memConnections = new Map(); // userId -> { youtube, tiktok, updatedAt }

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

function timingSafeEq(a, b) {
  const ab = Buffer.from(String(a || ''), 'utf8');
  const bb = Buffer.from(String(b || ''), 'utf8');
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
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

function missingEnv(names) {
  const missing = [];
  for (const name of names) {
    if (!env(name).trim()) missing.push(name);
  }
  return missing;
}

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    ensureDir();
    if (!fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  ensureDir();
  try {
    fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8');
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[render-auth] Failed to write DB file:', { file, msg: e instanceof Error ? e.message : String(e) });
  }
}

function saveConnections(userId, connections) {
  const uid = String(userId || '').trim();
  if (!uid) return null;
  memConnections.set(uid, {
    youtube: connections?.youtube ? String(connections.youtube) : null,
    tiktok: connections?.tiktok ? String(connections.tiktok) : null,
    updatedAt: Date.now(),
  });
  const db = readJson(CONNECTIONS_FILE, { users: {} });
  if (!db.users) db.users = {};
  db.users[uid] = {
    youtube: connections?.youtube ? String(connections.youtube) : null,
    tiktok: connections?.tiktok ? String(connections.tiktok) : null,
    updatedAt: Date.now(),
  };
  writeJson(CONNECTIONS_FILE, db);
  return db.users[uid];
}

function getSavedConnections(userId) {
  const uid = String(userId || '').trim();
  const inMem = memConnections.get(uid);
  if (inMem) return inMem;
  const db = readJson(CONNECTIONS_FILE, { users: {} });
  return db.users?.[uid] || null;
}

function getDbSummary() {
  const db = readJson(CONNECTIONS_FILE, { users: {} });
  const users = db.users || {};
  const entries = Object.entries(users);
  let last = null;
  for (const [userId, entry] of entries) {
    if (!entry?.updatedAt) continue;
    if (!last || Number(entry.updatedAt) > Number(last.entry.updatedAt)) last = { userId, entry };
  }
  const fileExists = fs.existsSync(CONNECTIONS_FILE);
  const stat = fileExists ? fs.statSync(CONNECTIONS_FILE) : null;
  return {
    file: {
      path: CONNECTIONS_FILE,
      exists: fileExists,
      size: stat ? stat.size : 0,
      mtimeMs: stat ? stat.mtimeMs : null,
    },
    memory: {
      count: memConnections.size,
    },
    users: {
      count: entries.length,
      last,
    },
  };
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

app.get('/status', (req, res) => {
  const clientId = env('DISCORD_CLIENT_ID').trim();
  const redirectUri = env('DISCORD_REDIRECT_URI').trim();
  const webhookUrl = env('DISCORD_RELAY_WEBHOOK_URL').trim();
  const hasSecret = Boolean(env('DISCORD_CLIENT_SECRET').trim());
  const hasHmac = Boolean(env('RELAY_HMAC_SECRET').trim());
  const hasApiKey = Boolean(env('AURABOT_API_KEY').trim());

  res.status(200).json({
    ok: Boolean(clientId && redirectUri && hasSecret && (hasApiKey || (webhookUrl && hasHmac))),
    configured: {
      DISCORD_CLIENT_ID: Boolean(clientId),
      DISCORD_CLIENT_SECRET: hasSecret,
      DISCORD_REDIRECT_URI: Boolean(redirectUri),
      AURABOT_API_KEY: hasApiKey,
      DISCORD_RELAY_WEBHOOK_URL: Boolean(webhookUrl),
      RELAY_HMAC_SECRET: hasHmac,
    },
    values: {
      DISCORD_REDIRECT_URI: redirectUri || null,
      RELAY_PREFIX: env('RELAY_PREFIX', 'CONNECTION_DATA').trim() || 'CONNECTION_DATA',
      POST_SUCCESS_REDIRECT: env('POST_SUCCESS_REDIRECT').trim() || null,
      DATA_DIR,
    },
  });
});

app.get('/api/connections/:userId', (req, res) => {
  const apiKey = env('AURABOT_API_KEY').trim();
  if (!apiKey) {
    res.status(500).json({ error: 'Server not configured (missing AURABOT_API_KEY).' });
    return;
  }

  const provided = String(req.header('x-api-key') || '').trim();
  if (!provided || !timingSafeEq(provided, apiKey)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const userId = String(req.params.userId || '').trim();
  const entry = getSavedConnections(userId);
  if (!entry) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  res.status(200).json({ userId, ...entry });
});

app.get('/api/debug', (req, res) => {
  const apiKey = env('AURABOT_API_KEY').trim();
  if (!apiKey) {
    res.status(500).json({ error: 'Server not configured (missing AURABOT_API_KEY).' });
    return;
  }
  const provided = String(req.header('x-api-key') || '').trim();
  if (!provided || !timingSafeEq(provided, apiKey)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  res.status(200).json(getDbSummary());
});

app.get('/connect', (req, res) => {
  const clientId = env('DISCORD_CLIENT_ID').trim();
  const redirectUri = env('DISCORD_REDIRECT_URI').trim();
  if (!clientId || !redirectUri) {
    const missing = missingEnv(['DISCORD_CLIENT_ID', 'DISCORD_REDIRECT_URI']);
    res.status(500).send(`Server not configured.\nMissing: ${missing.join(', ') || 'unknown'}`);
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
  const apiKey = env('AURABOT_API_KEY').trim();
  const webhookUrl = env('DISCORD_RELAY_WEBHOOK_URL').trim();
  const relayPrefix = env('RELAY_PREFIX', 'CONNECTION_DATA').trim() || 'CONNECTION_DATA';
  const relaySecret = env('RELAY_HMAC_SECRET').trim();
  const postRedirect = env('POST_SUCCESS_REDIRECT').trim();

  const missingOAuth = missingEnv(['DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_REDIRECT_URI']);
  if (missingOAuth.length > 0) {
    res
      .status(500)
      .send(
        html(
          'AuraBot',
          `<h2>Server not configured</h2><p class="muted">Missing OAuth env vars: <code>${missingOAuth.join(
            ', ',
          )}</code></p><p class="muted">On Render, set these in the dashboard Environment. For local runs, create <code>render-auth/.env</code>.</p>`,
        ),
      );
    return;
  }
  const webhookRelayEnabled = Boolean(webhookUrl && relaySecret);
  const apiEnabled = Boolean(apiKey);
  if (!webhookRelayEnabled && !apiEnabled) {
    res
      .status(500)
      .send(
        html(
          'AuraBot',
          '<h2>Server not configured</h2><p class="muted">Set <code>AURABOT_API_KEY</code> (recommended) or set both <code>DISCORD_RELAY_WEBHOOK_URL</code> and <code>RELAY_HMAC_SECRET</code> (legacy).</p>',
        ),
      );
    return;
  }

  try {
    // eslint-disable-next-line no-console
    console.log('[render-auth] /callback start', { hasCode: true });
    const token = await exchangeCodeForToken({ clientId, clientSecret, redirectUri, code });
    const accessToken = token?.access_token;
    if (!accessToken) throw new Error('Missing access token');

    const user = await fetchDiscordUser(accessToken);
    const connections = await fetchDiscordConnections(accessToken);
    const picked = pickConnectedAccounts(connections);

    const userId = String(user?.id || '').trim();
    if (!userId) throw new Error('Missing user id');

    // Save for bot polling (no webhook needed)
    saveConnections(userId, picked);
    // eslint-disable-next-line no-console
    console.log('[render-auth] saved connections', { userId, youtube: picked.youtube || null, tiktok: picked.tiktok || null });

    const ts = String(Date.now());
    const payload = `${userId}|${picked.youtube || ''}|${picked.tiktok || ''}|${ts}`;
    if (webhookRelayEnabled) {
      const sig = hmacSig(relaySecret, payload);
      const content = `${relayPrefix}|${userId}|${picked.youtube || ''}|${picked.tiktok || ''}|${ts}|${sig}`;
      await postWebhook(webhookUrl, content);
    }

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
    const ax = e;
    const status = ax?.response?.status;
    const data = ax?.response?.data;
    const msg = e instanceof Error ? e.message : String(e);
    // eslint-disable-next-line no-console
    console.error('[render-auth] callback failed:', { msg, status, data });

    const hint =
      status === 400
        ? 'Check that your Redirect URI matches exactly in Discord Developer Portal and in DISCORD_REDIRECT_URI.'
        : status === 401
          ? 'Check DISCORD_CLIENT_SECRET (rotate it if leaked).'
          : 'Check your Render environment variables.';

    res
      .status(500)
      .send(
        html(
          'AuraBot Error',
          `<h2>Error</h2>
           <p class="muted">${msg}</p>
           <p class="muted">${hint}</p>
           <p class="muted">Open <code>/status</code> on this service to verify configuration.</p>`,
        ),
      );
  }
});

const port = Number(env('PORT', '3000')) || 3000;
app.listen(port, () => {
  // eslint-disable-next-line no-console
  console.log(`Render auth relay listening on :${port}`);
});
