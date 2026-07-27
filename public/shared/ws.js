let socket = null;
let role = 'display';
let playerId = null;
let onState = () => {};
let reconnectTimer = null;

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

function openSocket() {
  if (socket?.readyState === WebSocket.OPEN) return;

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
  });

  socket.addEventListener('message', (event) => {
    try {
      const msg = JSON.parse(event.data);
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
