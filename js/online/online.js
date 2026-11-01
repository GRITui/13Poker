// Online play entry point. Picks a transport at runtime:
//   - inside a claude.ai Artifact (window.claude exists): ./db.js, shared documents through the Artifact runtime;
//   - served by the Cloudflare Worker (the page carries the X-13Poker-Online header and /api/health answers):
//     ./ws.js, a WebSocket to a server that deals and scores (hands stay hidden until the showdown);
//   - anywhere else: ./db.js, which explains that online play isn't available here.
// Single player never depends on any of this.
import { startDb } from './db.js';
import { startWs } from './ws.js';

const $ = (sel) => document.querySelector(sel);

/** Is this page served by the 13 Poker Worker? Resolves to the /api/health body or null. */
async function probeServer() {
  if (!/^https?:$/.test(location.protocol)) return null;
  try {
    // A HEAD of the page itself: plain static servers answer 200 without the header, so nothing 404s in the console.
    const page = await fetch(location.pathname || '/', { method: 'HEAD', cache: 'no-store' });
    if (page.headers.get('x-13poker-online') !== 'ws') return null;
    const res = await fetch(new URL('/api/health', location.origin), { cache: 'no-store' });
    if (!res.ok) return null;
    const body = await res.json();
    return body && body.ok === true && body.transport === 'ws' ? body : null;
  } catch {
    return null;
  }
}

/** Wire the Online button and start the right transport. Returns a debug snapshot function for tests. */
export function initOnline(api) {
  let impl = null;
  $('#btnOnline').addEventListener('click', () => {
    if (impl) impl.onButton();
    else api.toast('Checking whether online play is available…');
  });
  const pick = async () => {
    const cl = window.claude;
    if (cl && typeof cl.use === 'function') return startDb(api);
    const server = await probeServer();
    return server ? startWs(api, server) : startDb(api);
  };
  pick().then((x) => { impl = x; });
  return () => (impl ? impl.debug() : { mode: null, status: 'pending' });
}
