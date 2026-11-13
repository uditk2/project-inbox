// Cloudflare Worker entry: the same app as the local one, behind an access token, with a Resend webhook, a cron sync
// and an MCP endpoint. D1 stands in for SQLite (the app already talks to its database through the D1 interface).
import {api, errorResponse, servePublic} from './app.js';
import {HttpError, json} from './core.js';
import {authenticate, login, logout, webhook, syncAll} from './hosted.js';
import {handleMcp} from './mcp-http.js';

const unauthorized = (message = 'Sign in or send the access token as a bearer token') =>
  Response.json({error: message}, {status: 401, headers: {'WWW-Authenticate': 'Bearer', 'Cache-Control': 'no-store'}});

export default {
  async fetch(request, env) {
    try {
      const url = new URL(request.url);
      if (url.pathname === '/health') return json({status: 'ok', app: 'project-inbox', mode: 'hosted'});
      const hook = url.pathname.match(/^\/webhooks\/resend\/([a-z0-9-]{1,48})$/);
      if (hook) return await webhook(request, env, hook[1]);
      if (url.pathname === '/login') return await login(request, env);
      if (url.pathname === '/logout') return logout(request);
      const user = await authenticate(request, env);
      const isApi = url.pathname.startsWith('/api/'), isMcp = url.pathname === '/mcp';
      if (!user) return isApi || isMcp ? unauthorized() : Response.redirect(`${url.origin}/login`, 302);
      if (isMcp) {
        if (user.via !== 'bearer') return unauthorized('The MCP endpoint needs the access token as a bearer token');
        return await handleMcp(request, async inner => { try { return await api(inner, env, user); } catch (e) { return errorResponse(e); } });
      }
      if (isApi) {
        if (!['GET', 'HEAD'].includes(request.method)) {
          if (Number(request.headers.get('Content-Length') || 0) > 1000000) throw new HttpError(413, 'Request too large');
          // A browser session is a cookie, so writes must come from this site's own pages. A bearer token is not sent
          // automatically by browsers, so it needs no such check.
          if (user.via === 'cookie' && (request.headers.get('Origin') !== url.origin || !request.headers.get('Content-Type')?.startsWith('application/json'))) throw new HttpError(403, 'Same-origin JSON request required');
        }
        return await api(request, env, user);
      }
      return await servePublic(request, env);
    } catch (e) {
      return errorResponse(e);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(syncAll(env).then(report => console.log(JSON.stringify({cron: 'sync', report}))));
  }
};
