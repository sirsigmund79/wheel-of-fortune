// Reconnecting WebSocket client shared by /tv and /play.
// usage: const net = connect(room, { role, onState, onEvent, onWelcome, onError, onStatus, onMessage })
//        net.send({ t: "spin" })
//        net.now()  -> server-clock ms (for deadline countdowns)

export function connect(room, opts) {
  const { role } = opts;
  const key = "sns:" + room;
  let ws = null;
  let retry = 0;
  let offset = 0; // serverNow - Date.now()
  let closed = false;
  const queue = [];

  const storedId = () => {
    try { return localStorage.getItem(key); } catch { return null; }
  };

  function open() {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${location.host}/ws/${encodeURIComponent(room)}`);
    ws.onopen = () => {
      retry = 0;
      opts.onStatus?.("open");
      const hello = { t: "hello", role };
      if (role === "player" && storedId()) hello.playerId = storedId();
      ws.send(JSON.stringify(hello));
      while (queue.length) ws.send(queue.shift());
    };
    ws.onmessage = (m) => {
      let msg;
      try { msg = JSON.parse(m.data); } catch { return; }
      if (msg.t === "state") {
        if (msg.s?.serverNow) offset = msg.s.serverNow - Date.now();
        opts.onState?.(msg.s);
      } else if (msg.t === "ev") opts.onEvent?.(msg);
      else if (msg.t === "welcome") {
        if (msg.playerId) { try { localStorage.setItem(key, msg.playerId); } catch {} }
        opts.onWelcome?.(msg);
      } else if (msg.t === "error") opts.onError?.(msg);
      opts.onMessage?.(msg);
    };
    ws.onclose = () => {
      opts.onStatus?.("closed");
      if (closed) return;
      const delay = Math.min(8000, 400 * 2 ** retry++);
      setTimeout(open, delay);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  }

  // Reconnect immediately when a phone wakes up / tab becomes visible.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && ws && ws.readyState > 1) { retry = 0; open(); }
  });

  open();
  return {
    send(obj) {
      const s = JSON.stringify(obj);
      if (ws && ws.readyState === 1) ws.send(s);
      else queue.push(s);
    },
    now: () => Date.now() + offset,
    forget() { try { localStorage.removeItem(key); } catch {} },
    close() { closed = true; ws?.close(); },
  };
}
