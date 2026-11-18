// The order statistics every outrun report shares, one definition: `outrun report`'s cache verdict and
// time added (oss), the capacity model and the case study (outrun/cli, private, which import them from here).

/**
 * The [q]-quantile of sorted [values], nearest rank: the ⌈q·n⌉-th smallest (0 for none).
 * @public
 */
export const quantile = (sorted: ArrayLike<number>, q: number) =>
  sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))]!;

/** The median of [values]: the middle one, the mean of the two middle ones for an even count (NaN for none). */
export const median = (values: readonly number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length === 0 ? Number.NaN : sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};
