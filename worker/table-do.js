// The `Table` Durable Object: one per table code. Holds the WebSockets (Hibernation API) and persists the Room
// (./room.js) in its storage after every change, so a hibernated or evicted object comes back with the same state.
import { DurableObject } from 'cloudflare:workers';
import { Room, RoomError, RateLimiter, parseMessage, LIMITS } from './room.js';

const ROOM_KEY = 'room';
// Close codes the client understands (4000-4999 are free for applications).
export const CLOSE = Object.freeze({
  NO_TABLE: 4404, REFUSED: 4400, KICKED: 4403, REPLACED: 4409, LEFT: 4000, EXPIRED: 4410, ABUSE: 4429,
});

function roomOpts(env) {
  const secs = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n * 1000 : d;
  };
  return {
    turnMs: secs(env.TURN_SECONDS, LIMITS.TURN_MS),
    hostGraceMs: secs(env.HOST_GRACE_SECONDS, LIMITS.HOST_GRACE_MS),
    idleMs: secs(env.IDLE_SECONDS, LIMITS.IDLE_MS),
  };
}

export class Table extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = undefined; // undefined = not loaded yet, null = no table here
    this.limiters = new Map(); // in memory only: resets if the object hibernates, which is fine
    // Keep-alive pings are answered without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async load() {
    if (this.room !== undefined) return this.room;
    const saved = await this.ctx.storage.get(ROOM_KEY);
    this.room = saved ? Room.restore(saved, roomOpts(this.env)) : null;
    if (this.room) this.room.reconcile(this.openPids(), Date.now());
    return this.room;
  }

  async save() {
    if (!this.room) return;
    await this.ctx.storage.put(ROOM_KEY, this.room.toJSON());
    const at = this.room.nextWake();
    if (at == null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(at, Date.now() + 50));
  }

  openPids(except = null) {
    const out = [];
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === except) continue;
      const a = ws.deserializeAttachment();
      if (a && a.pid) out.push(a.pid);
    }
    return out;
  }

  /** RPC from the Worker: set up a new table. False if this code is already in use. */
  async create(code, settings) {
    if (await this.load()) return false;
    this.room = Room.create(code, settings || {}, Date.now(), roomOpts(this.env));
    await this.save();
    return true;
  }

  /** WebSocket upgrade, forwarded by the Worker for GET /ws?table=CODE. */
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    const room = await this.load();
    if (!room) {
      // No table: a plain (non-hibernating) socket that says why and closes.
      server.accept();
      send(server, { type: 'error', code: 'no-table', message: 'No table with that code. It may have closed.' });
      server.close(CLOSE.NO_TABLE, 'no table');
      return new Response(null, { status: 101, webSocket: client });
    }
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ pid: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, data) {
    const now = Date.now();
    let lim = this.limiters.get(ws);
    if (!lim) { lim = new RateLimiter(); this.limiters.set(ws, lim); }
    if (!lim.allow(now)) {
      if (lim.dropped > 50) { this.limiters.delete(ws); ws.close(CLOSE.ABUSE, 'too many messages'); return; }
      if (lim.dropped % 10 === 1) send(ws, { type: 'error', code: 'rate-limited', message: 'Slow down: too many messages.' });
      return;
    }
    const parsed = parseMessage(typeof data === 'string' ? data : null);
    if (!parsed.ok) { send(ws, { type: 'error', ...parsed.error }); return; }
    const msg = parsed.msg;
    const room = await this.load();
    if (!room) { ws.close(CLOSE.NO_TABLE, 'no table'); return; }
    const att = ws.deserializeAttachment() || {};

    if (msg.type === 'hello') {
      if (att.pid) { send(ws, { type: 'error', code: 'bad-message', message: 'Already joined.' }); return; }
      let j;
      try { j = room.join(msg, now); } catch (e) {
        if (!(e instanceof RoomError)) throw e;
        send(ws, { type: 'error', code: e.code, message: e.message });
        ws.close(CLOSE.REFUSED, e.code);
        return;
      }
      // One socket per seat: a second tab (or a reconnect racing the old socket) replaces the older one.
      for (const other of this.ctx.getWebSockets()) {
        if (other !== ws && other.deserializeAttachment()?.pid === j.pid) {
          other.serializeAttachment({ pid: null });
          send(other, { type: 'error', code: 'replaced', message: 'This seat was opened in another window.' });
          other.close(CLOSE.REPLACED, 'replaced');
        }
      }
      ws.serializeAttachment({ pid: j.pid });
      send(ws, { type: 'welcome', token: j.token, code: room.code, rejoined: j.rejoined });
      room.tick(now);
      await this.commit(now);
      return;
    }

    if (!att.pid) { send(ws, { type: 'error', code: 'hello-first', message: 'Say hello first.' }); return; }
    let out;
    try { out = room.handle(att.pid, msg, now); } catch (e) {
      if (!(e instanceof RoomError)) throw e;
      send(ws, { type: 'error', code: e.code, message: e.message });
      return;
    }
    for (const other of this.ctx.getWebSockets()) {
      const pid = other.deserializeAttachment()?.pid;
      if (pid && out.kicked.includes(pid)) {
        other.serializeAttachment({ pid: null });
        send(other, { type: 'error', code: 'kicked', message: 'The host gave your seat away.' });
        other.close(CLOSE.KICKED, 'kicked');
      }
    }
    if (out.left) {
      ws.serializeAttachment({ pid: null });
      send(ws, { type: 'left' });
      ws.close(CLOSE.LEFT, 'left');
    }
    await this.commit(now);
  }

  async webSocketClose(ws, code) {
    await this.closed(ws);
    try { ws.close(code === 1005 || code === 1006 || !code ? 1000 : code, 'bye'); } catch { /* already closed */ }
  }

  async webSocketError(ws) { await this.closed(ws); }

  async closed(ws) {
    this.limiters.delete(ws);
    const pid = ws.deserializeAttachment()?.pid;
    ws.serializeAttachment({ pid: null });
    const room = await this.load();
    if (!room || !pid) return;
    if (this.openPids(ws).includes(pid)) return; // another socket still holds the seat
    room.disconnect(pid, Date.now());
    await this.commit(Date.now());
  }

  async alarm() {
    const room = await this.load();
    if (!room) return;
    const now = Date.now();
    const { expired } = room.tick(now);
    if (expired) {
      for (const ws of this.ctx.getWebSockets()) { try { ws.close(CLOSE.EXPIRED, 'table closed'); } catch { /* gone */ } }
      this.room = null;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    await this.commit(now);
  }

  /** Persist, reschedule the alarm and send every connected player their own view. */
  async commit(now) {
    await this.save();
    const room = this.room;
    if (!room) return;
    for (const ws of this.ctx.getWebSockets()) {
      const pid = ws.deserializeAttachment()?.pid;
      if (pid) send(ws, room.snapshot(pid, now));
    }
  }
}

function send(ws, obj) {
  try { ws.send(JSON.stringify(obj)); } catch { /* socket closing */ }
}
