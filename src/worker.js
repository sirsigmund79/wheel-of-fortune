// Worker entry: static pages, room creation, and WebSocket forwarding to the Room Durable Object.
export { Room } from "./room.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const CODE_RE = /^[A-HJ-NP-Z]{4}$/;

function randomCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(4));
  return [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function roomStub(env, code) {
  return env.ROOM.get(env.ROOM.idFromName(code));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/rooms" && request.method === "POST") {
      for (let attempt = 0; attempt < 12; attempt++) {
        const code = randomCode();
        const res = await roomStub(env, code).fetch(`https://room/init?code=${code}`, { method: "POST" });
        const { free } = await res.json();
        if (free) return json({ code });
      }
      return json({ error: "Could not allocate a room, try again." }, 503);
    }

    // The bare site address opens the TV screen; there is no page at "/" itself.
    if (path === "/" || path === "/index.html") return Response.redirect(new URL("/tv" + url.search, url), 302);

    if (path === "/tv" || path === "/tv/" || path === "/play" || path === "/play/") {
      // Serve the page at /tv and /play directly (no redirect). Assets' html_handling may
      // redirect /x/index.html -> /x/, so follow one internal redirect if it does.
      const target = new URL(url);
      target.pathname = path.replace(/\/?$/, "/index.html");
      let res = await env.ASSETS.fetch(new Request(target, request));
      const loc = res.status >= 300 && res.status < 400 && res.headers.get("location");
      if (loc) {
        const next = new URL(loc, target);
        next.search = url.search;
        res = await env.ASSETS.fetch(new Request(next, request));
      }
      return res;
    }

    const ws = path.match(/^\/ws\/([^/]+)\/?$/);
    if (ws) {
      const code = decodeURIComponent(ws[1]).toUpperCase();
      if (!CODE_RE.test(code)) return new Response("Bad room code", { status: 400 });
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
      const target = new URL(request.url);
      target.pathname = "/ws";
      target.searchParams.set("code", code);
      return roomStub(env, code).fetch(new Request(target, request));
    }

    if (path.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
