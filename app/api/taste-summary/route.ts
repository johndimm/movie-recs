import { callLLM } from "../next-movie/llm";
import { type RatingEntry } from "../next-movie/route";
import {
  migrateRatingValue,
  rtTomatometerPercentToStars,
} from "../../lib/ratingScale";

/** Parse "91%" → 91 */
function parseRtPercent(s: string | null | undefined): number | null {
  if (!s) return null;
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : null;
}

function divergence(entry: RatingEntry): number {
  const u = migrateRatingValue(entry.userRating);
  const p = migrateRatingValue(entry.predictedRating);
  const rt = parseRtPercent(entry.rtScore);
  if (rt !== null) {
    return Math.abs(u - rtTomatometerPercentToStars(rt));
  }
  return Math.abs(u - p);
}

export async function POST(request: Request) {
  const raw = (await request.json()) as {
    history?: RatingEntry[];
    watchlistSignals?: { title: string; rtScore?: string | null }[];
    notInterestedSignals?: { title: string; rtScore?: string | null }[];
    existingSummary?: string;
    llm?: string;
  };

  const llm = raw.llm ?? "deepseek";
  const history = raw.history ?? [];
  const watchlistSignals = raw.watchlistSignals ?? [];
  const notInterestedSignals = raw.notInterestedSignals ?? [];

  if (history.length === 0) {
    return Response.json({ tasteSummary: null });
  }

  // Use top divergers + recent for the summary prompt
  const MAX_LINES = 30;
  const recentCount = Math.min(5, history.length);
  const recentEntries = history.slice(-recentCount);
  const recentKeys = new Set(recentEntries.map((e) => e.title.toLowerCase()));
  const olderScored = history
    .slice(0, -recentCount)
    .filter((e) => !recentKeys.has(e.title.toLowerCase()))
    .map((e) => ({ e, d: divergence(e) }))
    .sort((a, b) => b.d - a.d)
    .slice(0, MAX_LINES - recentCount)
    .map((x) => x.e);
  const selected = [...olderScored, ...recentEntries];

  const ratingLines = selected
    .map((h) => {
      const u = migrateRatingValue(h.userRating);
      const p = migrateRatingValue(h.predictedRating);
      const rt = h.rtScore ? ` RT:${h.rtScore}` : "";
      const rtN = parseRtPercent(h.rtScore);
      const gap =
        rtN !== null
          ? ` gap vs RT★: ${Math.abs(u - rtTomatometerPercentToStars(rtN)).toFixed(1)}`
          : "";
      return `- "${h.title}" (${h.type}): user ${u}/5, AI ${p}/5${rt}${gap}`;
    })
    .join("\n");

  const lowRtWants = watchlistSignals.filter((w) => {
    const rt = parseRtPercent(w.rtScore);
    return rt !== null && rt < 60;
  });
  const highRtSkips = notInterestedSignals.filter((n) => {
    const rt = parseRtPercent(n.rtScore);
    return rt !== null && rt >= 70;
  });

  const wantText = lowRtWants.length > 0
    ? lowRtWants.map((w) => `"${w.title}" (RT:${w.rtScore})`).join(", ")
    : "none";
  const skipText = highRtSkips.length > 0
    ? highRtSkips.map((n) => `"${n.title}" (RT:${n.rtScore})`).join(", ")
    : "none";

  const existingNote = raw.existingSummary
    ? `\nPrevious summary to refine: "${raw.existingSummary}"\n`
    : "";

  const systemPrompt = `You analyze movie/TV viewer taste from rating data. Write a concise, specific taste profile addressed directly to the viewer in second person ("You tend to...", "You consistently rate...", "You diverge from critics when..."). Cover what they love, what they avoid, and how their taste compares to critics. Be concrete, not generic. 2–4 sentences max. Reply with ONLY the profile text, no labels or JSON.`;

  const userMessage = `${existingNote}
RATED TITLES (${history.length} total; showing highest-divergence + most recent):
${ratingLines}

Saved to watchlist despite LOW RT (likes what critics don't): ${wantText}
Dismissed despite HIGH RT (dislikes what critics love): ${skipText}`;

  const start = Date.now();
  let summary: string;
  try {
    summary = await callLLM(llm, systemPrompt, userMessage, { maxTokens: 256 });
    console.log(`[taste-summary] done (${llm}) in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error("[taste-summary] LLM failed:", err);
    return Response.json({ tasteSummary: null });
  }

  return Response.json({ tasteSummary: summary.trim() || null });
}
