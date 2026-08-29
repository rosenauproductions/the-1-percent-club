let socket = null;
let role = 'display';
let playerId = null;
let onState = () => {};
let reconnectTimer = null;
const openListeners = new Set();
const pongListeners = new Set();

export function connect(clientRole, stateCallback, opts = {}) {
  role = clientRole;
  playerId = opts.playerId || null;
  onState = stateCallback;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    try {
      socket.onclose = null;
      socket.close();
    } catch {
      // ignore
    }
    socket = null;
  }
  fetchInitialState();
  openSocket();
}

export function setPlayerId(id) {
  playerId = id;
}

export function isSocketOpen() {
  return socket?.readyState === WebSocket.OPEN;
}

/** Subscribe to WS open (reconnect included). Returns unsubscribe. */
export function onWsOpen(fn) {
  openListeners.add(fn);
  return () => openListeners.delete(fn);
}

/** Subscribe to server pong replies. Returns unsubscribe. */
export function onWsPong(fn) {
  pongListeners.add(fn);
  return () => pongListeners.delete(fn);
}

/** Send a presence ping if the socket is open. */
export function sendPing() {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify({ type: 'ping', playerId: playerId || undefined }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Re-open the WS if it dropped (state sync). Actions still go over HTTP.
 * When already open as a player, sends an immediate presence ping.
 * @returns {boolean} true if already OPEN
 */
export function ensureConnected() {
  if (socket?.readyState === WebSocket.OPEN) {
    if (role === 'player' && playerId) sendPing();
    return true;
  }
  if (socket?.readyState === WebSocket.CONNECTING) return false;
  openSocket();
  return false;
}

async function fetchInitialState() {
  try {
    const qs = playerId ? `?playerId=${encodeURIComponent(playerId)}` : '';
    const res = await fetch(`/api/state${qs}`, {
      headers: roleHeader(),
    });
    if (!res.ok) return;
    const state = await res.json();
    onState(state);
  } catch {
    // Server may still be starting
  }
}

function roleHeader() {
  const h = { 'X-Client-Role': role };
  if (playerId) h['X-Player-Id'] = playerId;
  return h;
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let url = `${proto}//${location.host}?role=${encodeURIComponent(role)}`;
  if (playerId) url += `&playerId=${encodeURIComponent(playerId)}`;
  return url;
}

function notifyOpen() {
  for (const fn of openListeners) {
    try {
      fn();
    } catch {
      // ignore listener errors
    }
  }
}

function notifyPong(msg) {
  for (const fn of pongListeners) {
    try {
      fn(msg);
    } catch {
      // ignore listener errors
    }
  }
}

function openSocket() {
  if (socket?.readyState === WebSocket.OPEN) return;
  if (socket?.readyState === WebSocket.CONNECTING) return;

  try {
    socket = new WebSocket(wsUrl());
  } catch (err) {
    reconnectTimer = setTimeout(openSocket, 1500);
    return;
  }

  socket.addEventListener('open', () => {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (playerId && role === 'player') {
      try {
        socket.send(JSON.stringify({ type: 'identify', playerId }));
      } catch {
        // ignore
      }
    }
    notifyOpen();
  });

  socket.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
      if (msg.type === 'pong') {
        notifyPong(msg);
        return;
      }
      if (msg.type === 'state') onState(msg.state);
    } catch {
      // ignore bad frames
    }
  });

  socket.addEventListener('close', () => {
    reconnectTimer = setTimeout(openSocket, 1500);
  });

  socket.addEventListener('error', () => {
    // close handler will reconnect
  });
}

/** Actions use HTTP so the client updates immediately; others sync via WebSocket. */
export async function sendAction(action, payload = {}) {
  ensureConnected();
  const res = await fetch('/api/action', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...roleHeader(),
    },
    body: JSON.stringify({ action, playerId, ...payload }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Action failed');
  if (data.state) onState(data.state);
  return data;
}

/**
 * Retry an action until the HTTP ACK succeeds (or a non-retryable error).
 * Useful on flaky mobile networks during answering.
 */
export async function sendActionWithRetry(action, payload = {}, opts = {}) {
  const maxAttempts = opts.maxAttempts ?? 3;
  let lastErr;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      ensureConnected();
      return await sendAction(action, payload);
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || '');
      // Don't retry business-rule failures
      if (
        /already used pass|not accepting|cannot pass|no pass|not an active|answer required/i.test(
          msg,
        )
      ) {
        throw err;
      }
      await new Promise((r) => setTimeout(r, 180 * (attempt + 1)));
    }
  }
  throw lastErr;
}
