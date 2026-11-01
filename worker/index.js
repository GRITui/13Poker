// Cloudflare Worker entry. Static files (index.html, css/, js/, assets/) are served by Workers Static Assets; this
// script only runs for /api/* and /ws (see run_worker_first in wrangler.jsonc).
//   GET  /api/health          {ok: true} — the client uses it to pick the WebSocket transport
//   POST /api/tables          create a table: {settings?} -> {code}
//   GET  /ws?table=CODE       WebSocket to that table's Durable Object
import { normalizeCode, randomCode } from './room.js';

export { Table } from './table-do.js';

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
});

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === '/api/health') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json({ error: 'method' }, 405);
      const turn = Number(env.TURN_SECONDS);
      return json({ ok: true, service: '13poker', transport: 'ws', turnSeconds: Number.isFinite(turn) && turn > 0 ? turn : 90 });
    }

    if (pathname === '/api/tables') {
      if (request.method !== 'POST') return json({ error: 'method' }, 405);
      let settings = {};
      const text = await request.text();
      if (text.length > 4096) return json({ error: 'too-large' }, 413);
      if (text) {
        try { settings = JSON.parse(text)?.settings || {}; } catch { return json({ error: 'bad-json' }, 400); }
        if (typeof settings !== 'object' || Array.isArray(settings)) settings = {};
      }
      for (let i = 0; i < 12; i++) {
        const code = randomCode();
        const stub = env.TABLES.get(env.TABLES.idFromName(code));
        if (await stub.create(code, settings)) return json({ code }, 201);
      }
      return json({ error: 'busy', message: 'Couldn’t find a free table code. Try again.' }, 503);
    }

    if (pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ error: 'expected-websocket' }, 426);
      const code = normalizeCode(url.searchParams.get('table') || '');
      if (!code) return json({ error: 'bad-code' }, 400);
      return env.TABLES.get(env.TABLES.idFromName(code)).fetch(request);
    }

    if (pathname.startsWith('/api/')) return json({ error: 'not-found' }, 404);
    return env.ASSETS.fetch(request);
  },
};
