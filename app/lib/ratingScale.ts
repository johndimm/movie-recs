/**
 * User-facing scale: half stars from 0.5 through 5.0 (same idea as Rate Your Music).
 * Legacy localStorage may still hold 0–100; use migrateRatingValue.
 *
 * Rotten Tomatoes Tomatometer is 0–100%. We map it to the **same 0–5 half-star axis**
 * for display and for |user − critic| comparison: stars = round((pct/100)×5 to nearest 0.5).
 * 0% → 0 stars; 100% → 5 stars.
 */

export const STAR_MIN = 0.5;
export const STAR_MAX = 5;
export const STAR_STEP = 0.5;

/** Round to nearest 0.5 and clamp to [STAR_MIN, STAR_MAX]. */
export function clampStarRating(n: number): number {
  const stepped = Math.round(n / STAR_STEP) * STAR_STEP;
  return Math.min(STAR_MAX, Math.max(STAR_MIN, stepped));
}

/** Convert legacy 0–100 scale to stars (e.g. 70 → 3.5). */
export function fromLegacy100(n: number): number {
  return clampStarRating(n / 20);
}

/**
 * If value looks like legacy 0–100 (>5), convert; otherwise treat as stars.
 */
export function migrateRatingValue(n: number): number {
  if (!Number.isFinite(n)) return 3;
  if (n > 5) return fromLegacy100(n);
  return clampStarRating(n);
}

/**
 * Tomatometer 0–100% → 0–5 half-stars (same granularity as user input; 0% → 0).
 */
export function rtTomatometerPercentToStars(rtPercent: number): number {
  const linear = (Math.min(100, Math.max(0, rtPercent)) / 100) * STAR_MAX;
  return Math.round(linear * 2) / 2;
}

/** Normalize LLM predicted_rating (may be legacy 0–100 or stars). */
export function normalizePredictedRating(raw: unknown, fallback = 3): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return clampStarRating(fallback);
  if (raw > 5) return fromLegacy100(raw);
  return clampStarRating(raw);
}
