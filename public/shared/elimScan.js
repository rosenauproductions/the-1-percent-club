/** Deterministic blue-light spotlight while eliminating.mp3 searches. */

const STEP_MS = 300;

function scrambleOrder(length, pass) {
  const order = Array.from({ length }, (_, i) => i);
  let seed = ((pass + 1) * 2654435761) >>> 0;
  for (let i = order.length - 1; i > 0; i--) {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    const j = seed % (i + 1);
    const tmp = order[i];
    order[i] = order[j];
    order[j] = tmp;
  }
  return order;
}

/**
 * Which active player the search light is on right now.
 * Same result on every client when given the same elim.scanStartedAt.
 */
export function scanSpotlightId(elim, players, now = Date.now()) {
  if (elim?.stage !== 'scanning') return null;
  const active = (players || []).filter((p) => p && p.status === 'active');
  if (!active.length) return null;
  const started = Number(elim.scanStartedAt) || 0;
  const step = Math.max(0, Math.floor((now - started) / STEP_MS));
  const pass = Math.floor(step / active.length);
  const idx = step % active.length;
  const order = scrambleOrder(active.length, pass);
  return active[order[idx]]?.id ?? null;
}

export const SCAN_STEP_MS = STEP_MS;
