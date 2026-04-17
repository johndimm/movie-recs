"use client";

/** Half-star display on 0–5 (0 allowed for RT-only display). */
export function StaticStars({
  rating,
  color,
  ariaLabel,
}: {
  rating: number;
  color: "red" | "blue" | "amber" | "violet";
  ariaLabel?: string;
}) {
  const stars = Math.min(5, Math.max(0, rating));
  const filledColor =
    color === "red"
      ? "text-red-500"
      : color === "blue"
        ? "text-blue-500"
        : color === "amber"
          ? "text-amber-500"
          : "text-violet-600";
  const label =
    ariaLabel ?? `${stars % 1 === 0 ? stars : stars.toFixed(1)} out of 5 stars`;
  return (
    <span className="inline-flex leading-none" role="img" aria-label={label}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span key={n} className="relative inline-block text-base leading-none">
          <span className="text-zinc-200">★</span>
          {stars >= n && <span className={`absolute inset-0 ${filledColor}`}>★</span>}
          {stars >= n - 0.5 && stars < n && (
            <span className={`absolute inset-0 overflow-hidden ${filledColor}`} style={{ width: "50%" }}>
              ★
            </span>
          )}
        </span>
      ))}
    </span>
  );
}
