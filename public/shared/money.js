/** @typedef {'points' | 'dollars' | 'custom'} Currency */

export const DEFAULT_MAX_JACKPOT = 100;
export const DEFAULT_CURRENCY_LABEL = 'Gold Bars';
/** Classic show stake before max-jackpot scaling. */
export const CLASSIC_STAKE = 1000;

/**
 * @param {unknown} value
 * @returns {Currency}
 */
export function normalizeCurrency(value) {
  if (value === 'dollars' || value === 'custom') return value;
  return 'points';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function normalizeCurrencyLabel(value) {
  const s = String(value ?? '').trim().slice(0, 32);
  return s || DEFAULT_CURRENCY_LABEL;
}

/**
 * Target prize pot if every player contributes their stake.
 * @param {unknown} value
 * @returns {number}
 */
export function normalizeMaxJackpot(value) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n) || n < 1) return DEFAULT_MAX_JACKPOT;
  return Math.min(1_000_000_000, n);
}

/**
 * Per-player stake: floor(maxJackpot / playerCount), at least 1.
 * @param {unknown} maxJackpot
 * @param {unknown} playerCount
 * @returns {number}
 */
export function computeStake(maxJackpot, playerCount) {
  const pot = normalizeMaxJackpot(maxJackpot);
  const n = Math.max(1, Math.round(Number(playerCount)) || 1);
  return Math.max(1, Math.floor(pot / n));
}

/**
 * Live stake: locked at game start when present; else lobby preview from
 * maxJackpot ÷ current joined count (uses 1 when lobby is empty).
 * @param {{ stake?: unknown, players?: unknown[], setup?: { maxJackpot?: unknown } } | null | undefined} state
 * @returns {number}
 */
export function stakeFromState(state) {
  const locked = Math.round(Number(state?.stake));
  if (Number.isFinite(locked) && locked >= 1) return locked;
  const n = Array.isArray(state?.players) ? state.players.length : 0;
  return computeStake(state?.setup?.maxJackpot, Math.max(1, n));
}

/**
 * Format a stake/jackpot amount for display.
 * @param {number|string|null|undefined} n
 * @param {unknown} currencyOrSetup currency string, or setup object with currency/currencyLabel
 * @param {{ short?: boolean, label?: string }} [opts] short → abbreviated unit labels
 */
export function formatMoney(n, currencyOrSetup = 'points', opts = {}) {
  const amount = Number(n || 0).toLocaleString('en-US');
  const fromSetup = currencyOrSetup && typeof currencyOrSetup === 'object';
  const currency = normalizeCurrency(
    fromSetup ? currencyOrSetup.currency : currencyOrSetup,
  );
  if (currency === 'dollars') return `$${amount}`;

  const label = normalizeCurrencyLabel(
    fromSetup ? currencyOrSetup.currencyLabel : opts.label,
  );

  if (currency === 'custom') {
    return opts.short ? `${amount} ${label}` : `${amount} ${label}`;
  }

  return opts.short ? `${amount} pts` : `${amount} points`;
}
