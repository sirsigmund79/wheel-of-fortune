// Room Durable Object: one per room code. Hibernating WebSockets, state in ctx.storage ("game"),
// a single alarm for the current game deadline. All game rules live in ./game/engine.js.
import { DurableObject } from "cloudflare:workers";
import { applyIntent, createGame, onDeadline, setConnected, snapshot } from "./game/engine.js";

const IDLE_WIPE_MS = 6 * 60 * 60 * 1000;

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.game = undefined; // undefined = not loaded yet, null = no game stored
  }

  async load() {
    if (this.game === undefined) this.game = (await this.ctx.storage.get("game")) ?? null;
    return this.game;
  }

  async save() {
    await this.ctx.storage.put("game", this.game);
    await this.scheduleAlarm();
  }

  async scheduleAlarm() {
    const g = this.game;
    if (!g) return;
    // Game deadline if any, otherwise an idle-cleanup check.
    const at = g.deadline ?? Math.max((g.lastActive || 0) + IDLE_WIPE_MS, Date.now() + 60 * 60 * 1000);
    const current = await this.ctx.storage.getAlarm();
    if (current !== at) await this.ctx.storage.setAlarm(at);
  }

  newGame(code) {
    const seed = crypto.getRandomValues(new Uint32Array(1))[0] | 0;
    const g = createGame(code, seed);
    g.lastActive = Date.now();
    return g;
  }

  isStale(g) {
    return !g || Date.now() - (g.lastActive || 0) > IDLE_WIPE_MS;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const code = (url.searchParams.get("code") || "").toUpperCase();

    if (url.pathname === "/init") {
      const g = await this.load();
      if (!this.isStale(g)) return Response.json({ free: false });
      this.game = this.newGame(code);
      await this.save();
      return Response.json({ free: true });
    }

    if (url.pathname === "/ws") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const g = await this.load();
      if (!g && code) {
        // e.g. a TV reloading a room after it was wiped: recreate it lazily.
        this.game = this.newGame(code);
        await this.save();
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({ role: null, playerId: null });
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response("Not found", { status: 404 });
  }

  // ------------------------------------------------------------------------------------------

  send(ws, msg) {
    try { ws.send(JSON.stringify(msg)); } catch { /* socket gone */ }
  }

  attachment(ws) {
    try { return ws.deserializeAttachment() || {}; } catch { return {}; }
  }

  openSockets(except) {
    return this.ctx.getWebSockets().filter((ws) => ws !== except && ws.readyState === 1);
  }

  // Recompute connected flags from live sockets; also unbind sockets whose player was removed.
  syncConnections(except) {
    const g = this.game;
    const live = new Set();
    for (const ws of this.openSockets(except)) {
      const a = this.attachment(ws);
      if (a.role !== "player" || !a.playerId) continue;
      if (g.players.some((p) => p.id === a.playerId)) live.add(a.playerId);
      else {
        ws.serializeAttachment({ role: "player", playerId: null });
        this.send(ws, { t: "welcome", role: "player", room: g.room });
      }
    }
    return setConnected(g, live);
  }

  broadcast(events = [], except) {
    const g = this.game;
    const now = Date.now();
    const debug = this.env?.DEBUG_ANSWERS === "1";
    const plain = JSON.stringify({ t: "state", s: snapshot(g, now) });
    const tv = debug ? JSON.stringify({ t: "state", s: snapshot(g, now, { debugAnswer: true }) }) : plain;
    const evs = events.map((e) => JSON.stringify({ t: "ev", ...e }));
    for (const ws of this.openSockets(except)) {
      const isTv = this.attachment(ws).role === "tv";
      try {
        for (const e of evs) ws.send(e);
        ws.send(isTv ? tv : plain);
      } catch { /* ignore */ }
    }
  }

  sendState(ws) {
    const isTv = this.attachment(ws).role === "tv";
    const debug = isTv && this.env?.DEBUG_ANSWERS === "1";
    this.send(ws, { t: "state", s: snapshot(this.game, Date.now(), { debugAnswer: debug }) });
  }

  async webSocketMessage(ws, raw) {
    let msg;
    try { msg = JSON.parse(typeof raw === "string" ? raw : new TextDecoder().decode(raw)); } catch { return; }
    if (!msg || typeof msg.t !== "string") return;
    const g = await this.load();
    if (!g) {
      this.send(ws, { t: "error", code: "no_room", msg: "This room doesn't exist. Check the code on the TV." });
      return;
    }

    if (msg.t === "hello") return this.hello(ws, msg);
    if (msg.t === "ping") return this.send(ws, { t: "pong", serverNow: Date.now() });

    const att = this.attachment(ws);
    if (!att.role) return this.send(ws, { t: "error", code: "hello_first", msg: "Say hello first." });

    const now = Date.now();
    // Catch up on an overdue deadline before applying the intent (alarm may be slightly late).
    const pre = g.deadline && now >= g.deadline ? onDeadline(g, now).events : [];
    const res = applyIntent(g, { role: att.role, playerId: att.playerId }, msg, now);
    if (res.error && !pre.length) return this.send(ws, { t: "error", ...res.error });
    if (res.error) this.send(ws, { t: "error", ...res.error });

    for (const r of res.reply || []) {
      if (r.t === "welcome") ws.serializeAttachment({ role: "player", playerId: r.playerId ?? null });
      this.send(ws, r);
    }
    this.syncConnections();
    await this.save();
    this.broadcast([...pre, ...(res.events || [])]);
  }

  async hello(ws, msg) {
    const g = this.game;
    if (msg.role === "tv") {
      ws.serializeAttachment({ role: "tv", playerId: null });
      this.send(ws, { t: "welcome", role: "tv", room: g.room });
      this.sendState(ws);
      return;
    }
    const known = msg.playerId && g.players.some((p) => p.id === msg.playerId);
    ws.serializeAttachment({ role: "player", playerId: known ? msg.playerId : null });
    this.send(ws, known ? { t: "welcome", role: "player", playerId: msg.playerId, room: g.room } : { t: "welcome", role: "player", room: g.room });
    if (this.syncConnections()) {
      await this.save();
      this.broadcast();
    } else this.sendState(ws);
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 || code === 1006 ? 1000 : code, "bye"); } catch { /* already closed */ }
    await this.dropSocket(ws);
  }

  async webSocketError(ws) {
    await this.dropSocket(ws);
  }

  async dropSocket(ws) {
    const g = await this.load();
    if (!g) return;
    if (this.syncConnections(ws)) {
      await this.save();
      this.broadcast([], ws);
    }
  }

  async alarm() {
    const g = await this.load();
    if (!g) return;
    const now = Date.now();
    if (g.deadline) {
      if (now < g.deadline) return this.scheduleAlarm();
      const { events } = onDeadline(g, now);
      this.syncConnections();
      await this.save();
      this.broadcast(events);
      return;
    }
    // No deadline: idle cleanup.
    if (now - (g.lastActive || 0) > IDLE_WIPE_MS && this.openSockets().length === 0) {
      await this.ctx.storage.deleteAll();
      this.game = null;
      return;
    }
    await this.scheduleAlarm();
  }
}
