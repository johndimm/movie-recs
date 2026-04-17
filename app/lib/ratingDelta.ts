import { migrateRatingValue } from "./ratingScale";

export function starDelta(user: number, predicted: number): number {
  return migrateRatingValue(user) - migrateRatingValue(predicted);
}

/** Half-star deltas as strings like +1.5 or -2 */
export function formatStarDelta(d: number): string {
  const x = Math.round(d * 2) / 2;
  if (x === 0) return "0";
  const sign = x > 0 ? "+" : "-";
  const v = Math.abs(x);
  const body = Number.isInteger(v) ? String(v) : v.toFixed(1);
  return `${sign}${body}`;
}
