/** @typedef {'points' | 'dollars'} Currency */

/**
 * @param {unknown} value
 * @returns {Currency}
 */
export function normalizeCurrency(value) {
  return value === 'dollars' ? 'dollars' : 'points';
}

/**
 * Format a stake/jackpot amount for display.
 * Numeric values stay the same; only the unit label changes.
 * @param {number|string|null|undefined} n
 * @param {unknown} currency
 * @param {{ short?: boolean }} [opts] short → "1,000 pts" instead of "1,000 points"
 */
export function formatMoney(n, currency = 'points', opts = {}) {
  const amount = Number(n || 0).toLocaleString('en-US');
  if (normalizeCurrency(currency) === 'dollars') return `$${amount}`;
  return opts.short ? `${amount} pts` : `${amount} points`;
}
