// Minimal OAuth 2.1 layer so claude.ai / Claude Desktop "custom connector" flows
// (which require OAuth + dynamic client registration) can connect. We are not a
// full identity provider: there are no user accounts. Instead, the /authorize
// step is gated by the shared MCP token — whoever holds it can approve a client,
// which then receives short-lived OAuth access tokens accepted at /mcp.
//
// State (clients, codes, tokens) is in-memory and resets on restart; clients
// re-register and re-authorize automatically. The static MCP_AUTH_TOKEN is still
// accepted directly at /mcp (for Claude Code / API header auth).

import crypto from 'node:crypto';
import type { Express, Request } from 'express';

type Client = { client_id: string; redirect_uris: string[]; created: number };
type Code = {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  scope?: string;
  expires: number;
};

const clients = new Map<string, Client>();
const codes = new Map<string, Code>();
const accessTokens = new Map<string, number>(); // token -> expiry (ms)
const refreshTokens = new Map<string, number>();

const now = () => Date.now();
const rand = (n = 32) => crypto.randomBytes(n).toString('base64url');
const sha256 = (s: string) => crypto.createHash('sha256').update(s).digest('base64url');

const ACCESS_TTL = 3600; // seconds
const REFRESH_TTL_MS = 30 * 24 * 3600 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

export function verifyAccessToken(token: string): boolean {
  const exp = accessTokens.get(token);
  if (!exp) return false;
  if (exp < now()) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

export function baseUrl(req: Request, configured?: string): string {
  if (configured) return configured.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol;
  return `${proto}://${req.headers.host}`;
}

function issueTokens(scope = 'mcp', keepRefresh?: string) {
  const access_token = 'at_' + rand(32);
  accessTokens.set(access_token, now() + ACCESS_TTL * 1000);
  let refresh_token = keepRefresh;
  if (!refresh_token) {
    refresh_token = 'rt_' + rand(32);
    refreshTokens.set(refresh_token, now() + REFRESH_TTL_MS);
  }
  return { access_token, token_type: 'Bearer', expires_in: ACCESS_TTL, refresh_token, scope };
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

function approvalHtml(p: {
  client_id: string;
  redirect_uri: string;
  code_challenge: string;
  state: string;
  scope: string;
  error?: string;
}): string {
  const h = (s: string) => escapeHtml(s);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Connect to VibeCheck MCP</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a}
input{width:100%;padding:.6rem;font:inherit;border:1px solid #ccc;border-radius:6px;box-sizing:border-box}
button{margin-top:1rem;padding:.7rem 1.2rem;background:#cf1761;color:#fff;border:0;border-radius:6px;font:inherit;cursor:pointer}
.err{color:#b00020}</style></head><body>
<h1>Connect to VibeCheck MCP</h1>
<p>Paste your MCP token to authorize this connection.</p>
${p.error ? `<p class="err">${h(p.error)}</p>` : ''}
<form method="POST" action="/authorize" id="f">
  <input type="password" name="token" id="tok" placeholder="MCP-token" autocomplete="current-password" autofocus required>
  <label style="display:flex;gap:.5rem;align-items:center;margin-top:.6rem;font-size:.9rem">
    <input type="checkbox" id="remember" checked style="width:auto"> Husk token i denne nettleseren
  </label>
  <input type="hidden" name="client_id" value="${h(p.client_id)}">
  <input type="hidden" name="redirect_uri" value="${h(p.redirect_uri)}">
  <input type="hidden" name="code_challenge" value="${h(p.code_challenge)}">
  <input type="hidden" name="state" value="${h(p.state)}">
  <input type="hidden" name="scope" value="${h(p.scope)}">
  <button type="submit">Godkjenn</button>
</form>
<script>
(function(){
  var tok=document.getElementById('tok'),rem=document.getElementById('remember'),f=document.getElementById('f');
  try{var s=localStorage.getItem('ec_mcp_token');if(s){tok.value=s;rem.checked=true;}}catch(e){}
  f.addEventListener('submit',function(){try{rem.checked?localStorage.setItem('ec_mcp_token',tok.value):localStorage.removeItem('ec_mcp_token');}catch(e){}});
})();
</script></body></html>`;
}

export function registerOAuth(
  app: Express,
  opts: { publicUrl?: string; gateToken: string; resourcePath?: string },
): void {
  const resourcePath = opts.resourcePath ?? '/mcp';

  // Protected Resource Metadata (RFC 9728) — base path and any suffix variant.
  app.get(
    ['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/*'],
    (req, res) => {
      const b = baseUrl(req, opts.publicUrl);
      res.json({ resource: b + resourcePath, authorization_servers: [b] });
    },
  );

  // Authorization Server Metadata (RFC 8414).
  app.get(
    [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/*',
      '/.well-known/openid-configuration',
    ],
    (req, res) => {
      const b = baseUrl(req, opts.publicUrl);
      res.json({
        issuer: b,
        authorization_endpoint: `${b}/authorize`,
        token_endpoint: `${b}/token`,
        registration_endpoint: `${b}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none'],
        scopes_supported: ['mcp'],
      });
    },
  );

  // Dynamic Client Registration (RFC 7591).
  app.post('/register', (req, res) => {
    const body = req.body ?? {};
    const redirect_uris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!redirect_uris.length) {
      res.status(400).json({ error: 'invalid_client_metadata', error_description: 'redirect_uris required' });
      return;
    }
    const client_id = 'c_' + rand(16);
    clients.set(client_id, { client_id, redirect_uris, created: now() });
    res.status(201).json({
      client_id,
      client_id_issued_at: Math.floor(now() / 1000),
      redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      ...(body.client_name ? { client_name: body.client_name } : {}),
      ...(body.scope ? { scope: body.scope } : {}),
    });
  });

  // Authorization endpoint — GET renders the token-gated approval page.
  app.get('/authorize', (req, res) => {
    const q = req.query as Record<string, string>;
    const client = q.client_id ? clients.get(q.client_id) : undefined;
    if (!client || !q.redirect_uri || !client.redirect_uris.includes(q.redirect_uri)) {
      res.status(400).send('Invalid client_id or redirect_uri');
      return;
    }
    if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
      res.status(400).send('PKCE (S256) is required');
      return;
    }
    res.type('html').send(
      approvalHtml({
        client_id: q.client_id,
        redirect_uri: q.redirect_uri,
        code_challenge: q.code_challenge,
        state: q.state ?? '',
        scope: q.scope ?? 'mcp',
      }),
    );
  });

  // Approval submission — verify the gate token, then issue an auth code.
  app.post('/authorize', (req, res) => {
    const b = req.body ?? {};
    const client = b.client_id ? clients.get(b.client_id) : undefined;
    if (!client || !b.redirect_uri || !client.redirect_uris.includes(b.redirect_uri)) {
      res.status(400).send('Invalid client');
      return;
    }
    if (b.token !== opts.gateToken) {
      res.status(401).type('html').send(
        approvalHtml({
          client_id: b.client_id,
          redirect_uri: b.redirect_uri,
          code_challenge: b.code_challenge,
          state: b.state ?? '',
          scope: b.scope ?? 'mcp',
          error: 'Feil token. Prøv igjen.',
        }),
      );
      return;
    }
    const code = rand(24);
    codes.set(code, {
      client_id: b.client_id,
      redirect_uri: b.redirect_uri,
      code_challenge: b.code_challenge,
      scope: b.scope,
      expires: now() + CODE_TTL_MS,
    });
    const u = new URL(b.redirect_uri);
    u.searchParams.set('code', code);
    if (b.state) u.searchParams.set('state', b.state);
    res.redirect(u.toString());
  });

  // Token endpoint.
  app.post('/token', (req, res) => {
    const b = req.body ?? {};
    if (b.grant_type === 'authorization_code') {
      const c = b.code ? codes.get(b.code) : undefined;
      if (!c || c.expires < now()) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      codes.delete(b.code);
      if (c.client_id !== b.client_id || c.redirect_uri !== b.redirect_uri) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      if (!b.code_verifier || sha256(b.code_verifier) !== c.code_challenge) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE verification failed' });
        return;
      }
      res.json(issueTokens(c.scope));
      return;
    }
    if (b.grant_type === 'refresh_token') {
      const exp = b.refresh_token ? refreshTokens.get(b.refresh_token) : undefined;
      if (!exp || exp < now()) {
        res.status(400).json({ error: 'invalid_grant' });
        return;
      }
      res.json(issueTokens('mcp', b.refresh_token));
      return;
    }
    res.status(400).json({ error: 'unsupported_grant_type' });
  });
}
