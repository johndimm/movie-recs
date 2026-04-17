"use client";

import { StaticStars } from "./Stars";
import { rtTomatometerPercentToStars } from "../lib/ratingScale";

/** Rotten Tomatoes Tomatometer % mapped to half-stars (same scale as user ratings). */
export default function RTBadge({ score }: { score: string }) {
  const raw = parseInt(score.replace(/[^\d]/g, ""), 10);
  const pct = Number.isFinite(raw) ? Math.min(100, Math.max(0, raw)) : null;
  const fresh = pct !== null ? pct >= 60 : true;

  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs font-semibold px-2 py-0.5 rounded-full ${
        fresh ? "bg-red-50 text-red-700" : "bg-zinc-100 text-zinc-500"
      }`}
      title={pct !== null ? `Rotten Tomatoes ${pct}%` : `Rotten Tomatoes ${score}`}
    >
      <span aria-hidden>{fresh ? "🍅" : "💀"}</span>
      {pct !== null ? (
        <span aria-hidden>
          <StaticStars rating={rtTomatometerPercentToStars(pct)} color="amber" />
        </span>
      ) : (
        <span className="text-[0.7rem] font-normal opacity-80">—</span>
      )}
      <span className="sr-only">Rotten Tomatoes {score}</span>
    </span>
  );
}
