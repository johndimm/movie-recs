export interface RatingEntry {
  title: string;
  type: "movie" | "tv";
  /** 0.5–5 half-star scale. Legacy 0–100 is migrated client-side. */
  userRating: number;
  predictedRating: number;
  rtScore?: string | null;
}


export interface NextMovieResponse {
  title: string;
  type: "movie" | "tv";
  year: number | null;
  director: string | null;
  predictedRating: number;
  actors: string[];
  plot: string;
  posterUrl: string | null;
  trailerKey: string | null;
  rtScore: string | null;
}

/** One entry inside the LLM "items" array — snake_case from model output */
interface RawItem {
  title?: string;
  type?: "movie" | "tv";
  year?: number | null;
  director?: string | null;
  predicted_rating?: number;
  actors?: string[];
  plot?: string;
  rt_score?: string | null;
}

import {
  migrateRatingValue,
  normalizePredictedRating,
  rtTomatometerPercentToStars,
} from "../../lib/ratingScale";

/**
 * Items per LLM response — 5 items ≈ 750 output tokens ≈ ~10–15s on DeepSeek.
 * Smaller + parallel beats larger + sequential for keeping the prefetch queue full.
 */
const DEFAULT_BATCH = 5;
const MAX_BATCH = 8;
/** Max rated lines in prompt — highest |user−RT| first (then |user−AI| if no RT). */
const MAX_HISTORY_DIVERGENCE_LINES = 32;
/** Curated unseen signals (low-RT saves, high-RT dismissals). */
const MAX_LOW_RT_WANT_LINES = 28;
const MAX_HIGH_RT_SKIP_LINES = 28;
const LOW_RT_THRESHOLD = 60; // want-to-watch: RT below this is a strong signal
const HIGH_RT_THRESHOLD = 70; // not interested: RT at/above this is a strong signal
/** 5 items × ~200 tokens each + overhead. */
const LLM_OUTPUT_MAX_TOKENS = 1500;

function getYoutubeDataApiKey(): string | undefined {
  return process.env.YOUTUBE_API_KEY || process.env.YOUTUBE_DATA_API_KEY;
}

/**
 * Optional YouTube Data API check (requires {@link getYoutubeDataApiKey}).
 * Drops trailers that cannot be embedded on a third-party site (uploader disabled embeds) or
 * are age-restricted on YouTube (otherwise the iframe shows “Watch on YouTube” only).
 * On API errors we fail open so a bad key or outage does not strip every trailer.
 */
async function youtubeVideoIsEmbeddableForSite(videoId: string): Promise<boolean> {
  const key = getYoutubeDataApiKey();
  if (!key) return true;
  try {
    const url = new URL("https://www.googleapis.com/youtube/v3/videos");
    url.searchParams.set("part", "status,contentDetails");
    url.searchParams.set("id", videoId);
    url.searchParams.set("key", key);
    const res = await fetch(url.toString());
    if (!res.ok) {
      console.warn("[next-movie] YouTube Data API HTTP", res.status);
      return true;
    }
    const data = (await res.json()) as {
      items?: Array<{
        status?: { embeddable?: boolean };
        contentDetails?: { contentRating?: { ytRating?: string } };
      }>;
    };
    const item = data.items?.[0];
    if (!item) return false;
    if (item.status?.embeddable === false) return false;
    if (item.contentDetails?.contentRating?.ytRating === "ytAgeRestricted") return false;
    return true;
  } catch (e) {
    console.warn("[next-movie] YouTube Data API check failed", e);
    return true;
  }
}

/** Prefer official trailers, then other trailers, then any YouTube clip TMDB listed. */
function orderedYoutubeCandidateKeys(
  ytVideos: { key: string; site: string; type: string; official?: boolean }[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (k: string | undefined) => {
    if (!k || seen.has(k)) return;
    seen.add(k);
    out.push(k);
  };
  const trailers = ytVideos.filter((v) => v.type === "Trailer");
  trailers.sort((a, b) => Number(!!b.official) - Number(!!a.official));
  for (const v of trailers) add(v.key);
  for (const v of ytVideos) add(v.key);
  return out;
}

/** Official poster + YouTube trailer key via TMDB — one search + one videos call per title. */
async function fetchTmdbAssets(
  title: string,
  type: "movie" | "tv",
  year: number | null
): Promise<{ posterUrl: string | null; trailerKey: string | null }> {
  const apiKey = process.env.TMDB_API_KEY;
  if (!apiKey) return { posterUrl: null, trailerKey: null };
  const base = "https://api.themoviedb.org/3";
  const path = type === "tv" ? "search/tv" : "search/movie";
  try {
    const params = new URLSearchParams({ api_key: apiKey, query: title });
    if (year !== null && year !== undefined) {
      if (type === "tv") params.set("first_air_date_year", String(year));
      else params.set("year", String(year));
    }
    let res = await fetch(`${base}/${path}?${params.toString()}`);
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("[next-movie] TMDB search HTTP", res.status, errBody.slice(0, 200));
      return { posterUrl: null, trailerKey: null };
    }
    let data = (await res.json()) as { results?: { id?: number; poster_path?: string | null }[] };
    let results = data.results ?? [];
    if (results.length === 0 && year !== null) {
      const p2 = new URLSearchParams({ api_key: apiKey, query: title });
      res = await fetch(`${base}/${path}?${p2.toString()}`);
      if (res.ok) {
        data = (await res.json()) as { results?: { id?: number; poster_path?: string | null }[] };
        results = data.results ?? [];
      }
    }
    const hit = results.find((r) => r.poster_path) ?? results[0] ?? null;
    const posterUrl = hit?.poster_path ? `https://image.tmdb.org/t/p/w500${hit.poster_path}` : null;
    const tmdbId = hit?.id ?? null;

    let trailerKey: string | null = null;
    if (tmdbId !== null) {
      try {
        const videoPath = type === "tv" ? `tv/${tmdbId}/videos` : `movie/${tmdbId}/videos`;
        const vRes = await fetch(`${base}/${videoPath}?api_key=${apiKey}`);
        if (vRes.ok) {
          const vData = (await vRes.json()) as {
            results?: { key: string; site: string; type: string; official?: boolean }[];
          };
          const ytVideos = (vData.results ?? []).filter((v) => v.site === "YouTube");
          const candidateKeys = orderedYoutubeCandidateKeys(ytVideos);
          for (const key of candidateKeys) {
            if (await youtubeVideoIsEmbeddableForSite(key)) {
              trailerKey = key;
              break;
            }
          }
        }
      } catch (e) {
        console.error("[next-movie] TMDB videos fetch failed:", e);
      }
    }

    return { posterUrl, trailerKey };
  } catch (e) {
    console.error("[next-movie] TMDB assets fetch failed:", e);
    return { posterUrl: null, trailerKey: null };
  }
}

/** Google Images via Serper — optional fallback when TMDB has no match or no TMDB key. */
async function fetchPosterFromSerper(title: string, type: "movie" | "tv", year: number | null): Promise<string | null> {
  if (!process.env.SERPER_API_KEY) return null;
  const yearStr = year ? ` ${year}` : "";
  const query = `${title}${yearStr} ${type === "tv" ? "TV series" : "film"} official poster`;
  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: 3 }),
    });
    if (!res.ok) {
      const errBody = await res.text().catch(() => "");
      console.error("[next-movie] Serper images HTTP", res.status, errBody.slice(0, 200));
      return null;
    }
    const data = await res.json() as { images?: { imageUrl: string; width?: number; height?: number }[] };
    const images = data.images ?? [];
    const portrait = images.find((img) => !img.width || !img.height || img.height >= img.width);
    const url = (portrait ?? images[0])?.imageUrl ?? null;
    return url ? url.replace(/^http:\/\//i, "https://") : null;
  } catch (e) {
    console.error("[next-movie] Serper images fetch failed:", e);
    return null;
  }
}

/** Serper-only fallback used when TMDB_API_KEY is absent — returns poster only, no trailer. */
async function fetchPosterFallback(title: string, type: "movie" | "tv", year: number | null): Promise<string | null> {
  const serper = await fetchPosterFromSerper(title, type, year);
  if (serper) return serper;
  if (!process.env.SERPER_API_KEY) {
    console.warn("[next-movie] Set TMDB_API_KEY (recommended) or SERPER_API_KEY — poster lookup disabled");
  }
  return null;
}

/** First balanced `{ ... }` with string-aware brace tracking */
function extractRootJsonObject(text: string): string | null {
  const start = text.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function parseLlmResponse(text: string, fallbackSingleObjectWalker: string): { items: RawItem[]; tasteSummary: string | null } {
  let stripped = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  let jsonText = stripped.replace(/[\r\n]+/g, " ");
  let root: unknown;
  try {
    root = JSON.parse(jsonText);
  } catch {
    const extracted = extractRootJsonObject(stripped) ?? extractRootJsonObject(fallbackSingleObjectWalker);
    if (!extracted) throw new Error("no JSON");
    jsonText = extracted.replace(/[\r\n]+/g, " ");
    root = JSON.parse(jsonText);
  }

  let items: RawItem[];
  let tasteSummary: string | null = null;

  if (Array.isArray(root)) {
    items = root as RawItem[];
  } else if (root && typeof root === "object" && root !== null) {
    const o = root as Record<string, unknown>;
    if (typeof o.taste_summary === "string") tasteSummary = o.taste_summary.trim() || null;
    if (Array.isArray(o.items)) items = o.items as RawItem[];
    else if (Array.isArray(o.titles)) items = o.titles as RawItem[];
    else if (typeof o.title === "string" && (o.type === "movie" || o.type === "tv")) items = [o as RawItem];
    else items = [];
  } else {
    items = [];
  }

  return { items, tasteSummary };
}

/** Parse "91%" → 91, returns null if unparseable */
function parseRtPercent(rtScore: string | null | undefined): number | null {
  if (!rtScore) return null;
  const n = parseInt(rtScore, 10);
  return Number.isFinite(n) ? n : null;
}

/**
 * Taste information density: prefer |user − RT| (RT % mapped to same half-star scale); else |user − AI|.
 */
function divergenceScore(entry: RatingEntry): number {
  const u = migrateRatingValue(entry.userRating);
  const rt = parseRtPercent(entry.rtScore);
  if (rt !== null) {
    return Math.abs(u - rtTomatometerPercentToStars(rt));
  }
  return Math.abs(u - migrateRatingValue(entry.predictedRating));
}

function selectInformativeHistory(history: RatingEntry[], maxEntries: number): RatingEntry[] {
  if (history.length <= maxEntries) return history;
  // Reserve ~1/4 of slots for recency signal; fill the rest with highest-divergence entries.
  const recentCount = Math.min(Math.floor(maxEntries / 4), 10);
  const recentEntries = history.slice(-recentCount);
  const recentKeys = new Set(recentEntries.map((e) => e.title.toLowerCase()));
  const olderEntries = history.slice(0, -recentCount).filter((e) => !recentKeys.has(e.title.toLowerCase()));
  const remainingSlots = maxEntries - recentEntries.length;
  const scored = olderEntries.map((entry) => ({ entry, divergence: divergenceScore(entry) }));
  scored.sort((a, b) => b.divergence - a.divergence);
  const divergentEntries = scored.slice(0, remainingSlots).map((s) => s.entry);
  // Divergent first (context), recent last (freshest signal)
  return [...divergentEntries, ...recentEntries];
}

import { callLLM } from "./llm";
import { resolveHistoryForPrompt } from "./historySessionStore";

interface ChannelPayload {
  id: string;
  name: string;
  genres: string[];
  timePeriods: string[];
  language: string;
  region: string;
  artists: string;
  freeText: string;
  popularity: number;
}

function buildChannelConstraint(ch: ChannelPayload): string {
  const lines: string[] = [];
  if (ch.genres.length) lines.push(`- Genres: ${ch.genres.join(", ")}`);
  if (ch.timePeriods.length) lines.push(`- Time periods: ${ch.timePeriods.join(", ")}`);
  if (ch.language.trim()) lines.push(`- Language: ${ch.language.trim()}`);
  if (ch.region.trim()) lines.push(`- Region/Country: ${ch.region.trim()}`);
  if (ch.artists.trim()) lines.push(`- Focus on work by: ${ch.artists.trim()}`);
  if (ch.freeText.trim()) lines.push(`- Additional: ${ch.freeText.trim()}`);

  const pop = ch.popularity;
  if (pop <= 15) lines.push("- Popularity: Hidden gems only — obscure, underseen, cult, or arthouse titles. Avoid mainstream blockbusters entirely.");
  else if (pop <= 35) lines.push("- Popularity: Mostly obscure — prefer lesser-known films, avoid the biggest blockbusters.");
  else if (pop <= 45) lines.push("- Popularity: Lean obscure — mix of hidden gems and mid-range titles, avoiding mainstream hits.");
  else if (pop <= 55) lines.push("- Popularity: Balanced mix of mainstream and hidden gems.");
  else if (pop <= 65) lines.push("- Popularity: Lean mainstream — prefer well-known titles, include some lesser-known.");
  else if (pop <= 85) lines.push("- Popularity: Mostly mainstream — well-known, popular titles.");
  else lines.push("- Popularity: Mainstream only — widely-known, popular, commercially successful titles.");

  if (lines.length === 0) return "";
  return `CHANNEL — "${ch.name}" — HARD CONSTRAINT: Every item MUST fit this channel. Requirements:\n${lines.join("\n")}`;
}

export async function POST(request: Request) {
  const raw = (await request.json()) as {
    sessionId?: string;
    historySync?: "full" | "delta" | "reuse";
    history?: RatingEntry[];
    baseLength?: number;
    historyAppend?: RatingEntry[];
    skipped?: string[];
    watchlistTitles?: Array<string | { title: string; rtScore?: string | null }>;
    notInterestedItems?: Array<{ title: string; rtScore?: string | null }>;
    tasteSummary?: string;
    diversityLens?: string;
    userRequest?: string;
    activeChannel?: ChannelPayload;
    mediaType?: "movie" | "tv" | "both";
    llm?: string;
    count?: number;
  };

  const skipped = raw.skipped ?? [];
  // Support both legacy string[] and new {title, rtScore}[] formats
  const rawWatchlistItems = raw.watchlistTitles ?? [];
  const watchlistItems: { title: string; rtScore?: string | null }[] = rawWatchlistItems.map((item) =>
    typeof item === "string" ? { title: item } : item
  );
  const watchlistTitles = watchlistItems.map((w) => w.title);
  const notInterestedItems: { title: string; rtScore?: string | null }[] = raw.notInterestedItems ?? [];
  const existingTasteSummary = raw.tasteSummary?.trim() || null;
  const diversityLens = raw.diversityLens?.trim() || null;
  const userRequest = raw.userRequest?.trim() || null;
  const activeChannel = raw.activeChannel ?? null;
  // "all" is the special no-filter channel — treat it like no channel so the diversity lens applies
  const channelConstraint = (activeChannel && activeChannel.id !== "all") ? buildChannelConstraint(activeChannel) : null;
  const mediaType = raw.mediaType ?? "both";
  const llm = raw.llm ?? "deepseek";
  const countRaw = raw.count;

  const merged = resolveHistoryForPrompt(raw.sessionId, raw.historySync, {
    history: raw.history,
    baseLength: raw.baseLength,
    historyAppend: raw.historyAppend,
  });

  if (!merged.ok) {
    return Response.json(
      { error: "session_resync", reason: merged.reason, message: "Send historySync full with complete history" },
      { status: 409 }
    );
  }

  const history = merged.history;

  const batchCount = Math.min(MAX_BATCH, Math.max(1, Math.floor(Number(countRaw) || DEFAULT_BATCH)));

  const ratedTitles = history.map((h) => h.title);
  const allExcluded = [...new Set([...ratedTitles, ...skipped, ...watchlistTitles])];

  // --- Informative taste-signal sections (token-efficient; full exclusion lists not sent) ---

  const informativeHistory = selectInformativeHistory(history, MAX_HISTORY_DIVERGENCE_LINES);
  const historyTrimmed = history.length > informativeHistory.length;

  const historyText =
    informativeHistory.length === 0
      ? "No ratings yet."
      : informativeHistory
          .map((h) => {
            const rt = h.rtScore ? ` RT:${h.rtScore}` : "";
            const rt_n = parseRtPercent(h.rtScore);
            const u = migrateRatingValue(h.userRating);
            const rtAsStars = rt_n !== null ? rtTomatometerPercentToStars(rt_n) : null;
            const gap =
              rtAsStars !== null
                ? ` |user−RT★|=${Math.abs(u - rtAsStars)} (Tomatometer → ${rtAsStars}/5 stars)`
                : ` |user−AI|=${Math.abs(u - migrateRatingValue(h.predictedRating))} (no RT)`;
            return `- "${h.title}" (${h.type}): user ${u}/5, AI ${migrateRatingValue(h.predictedRating)}/5${rt}${gap}`;
          })
          .join("\n");

  const historyNote = historyTrimmed
    ? `[Subset: ${informativeHistory.length} of ${history.length} rated — kept those with largest divergence from RT (or from AI if RT missing)]`
    : "";

  const lowRtCandidates = watchlistItems
    .map((w) => ({ ...w, rtN: parseRtPercent(w.rtScore) }))
    .filter((w): w is typeof w & { rtN: number } => w.rtN !== null && w.rtN < LOW_RT_THRESHOLD)
    .sort((a, b) => a.rtN - b.rtN)
    .slice(0, MAX_LOW_RT_WANT_LINES);

  const lowRtWantText =
    lowRtCandidates.length === 0
      ? "None."
      : lowRtCandidates.map((w) => `"${w.title}" (RT:${w.rtScore})`).join(", ");

  const highRtCandidates = notInterestedItems
    .map((n) => ({ ...n, rtN: parseRtPercent(n.rtScore) }))
    .filter((n): n is typeof n & { rtN: number } => n.rtN !== null && n.rtN >= HIGH_RT_THRESHOLD)
    .sort((a, b) => b.rtN - a.rtN)
    .slice(0, MAX_HIGH_RT_SKIP_LINES);

  const highRtSkipText =
    highRtCandidates.length === 0
      ? "None."
      : highRtCandidates.map((n) => `"${n.title}" (RT:${n.rtScore})`).join(", ");

  const mediaConstraint =
    mediaType === "movie"
      ? '\nIMPORTANT: Every item must be a movie only (not TV). Each "type" field must be "movie".'
      : mediaType === "tv"
        ? '\nIMPORTANT: Every item must be a TV series only (not movies). Each "type" field must be "tv".'
        : "";

  const systemPrompt = `You are calibrating a movie/TV recommendation system to a specific user's taste.

The user rates with **half stars from 0.5 to 5** (not percentages). Rotten Tomatoes Tomatometer scores are percentages; the app converts them to the same star scale for comparison.

Many cards have no Rotten Tomatoes score — that is normal.

Your job each turn:
1. Propose ${batchCount} titles (aim for variety). The client removes duplicates against a large exclusion set you do not receive in full — repeats are OK; the app will filter.
2. For each title, predict the rating they would give on a **0.5–5 star scale (half-star steps only)**.
3. Return title, year, director, top 3-4 actors, a 1-2 sentence plot summary, and Rotten Tomatoes Tomatometer when known.
4. Respond with ONLY valid JSON — no markdown, no explanation:
{"items":[{"title":"...","type":"movie","year":1994,"director":"...","predicted_rating":3.5,"actors":["...","..."],"plot":"...","rt_score":"94%"}]}

Rules:
- Return exactly ${batchCount} objects in "items" (unless absolutely impossible — then return as many distinct valid picks as you can)
- Avoid duplicate titles within "items". Do not worry about overlap with the user's full past list — the app enforces that separately
- "type" must be exactly "movie" or "tv"
- "year" is a number; "director" is the creator/showrunner for TV
- "predicted_rating" is a number from 0.5 to 5 in steps of 0.5 (half stars) — never use 0–100
- "rt_score" is the Tomatometer percentage (e.g. "94%") or null if unknown
- All string values must be on a single line — no newline characters inside strings
- Vary genres, eras, and (if media allows) movie vs TV to calibrate faster
- Predict honestly — vary predictions; the midpoint is not always 3
- Taste data below is intentionally small: high-divergence ratings, low-RT wants, high-RT dismissals. Full exclusion is not listed.${mediaConstraint}${channelConstraint ? `\n\n${channelConstraint}` : ""}${userRequest ? `\nUSER REQUEST — ADDITIONAL HARD CONSTRAINT: The user has also asked for "${userRequest}". Every item must satisfy BOTH the channel requirements above AND this request.` : !channelConstraint && diversityLens ? `\nDIVERSITY LENS FOR THIS BATCH: ${diversityLens}. Every item must fit this lens. This is how the app explores beyond the obvious — treat it as a hard constraint.` : ""}`;

  const tasteSummarySection = existingTasteSummary
    ? `RUNNING TASTE PROFILE (your summary from the previous session — treat as primary signal, refine it):
${existingTasteSummary}

`
    : "";

  const userMessage = `${tasteSummarySection}RATED TITLES — selected for largest |user−RT| divergence, plus most recent (most informative per token):
${historyText}
${historyNote}

UNSEEN SIGNALS — where this user disagrees with critics (curated, strongest first):
Want to watch despite LOW RT (below ${LOW_RT_THRESHOLD}%): ${lowRtWantText}
Not interested despite HIGH RT (${HIGH_RT_THRESHOLD}%+): ${highRtSkipText}

EXCLUSION (counts only — the app drops any repeat client-side):
${allExcluded.length} titles already decided (${ratedTitles.length} rated, ${watchlistTitles.length} on watchlist, ${skipped.length} skipped/dismissed). Suggest ${batchCount} diverse candidates.

${history.length === 0 && allExcluded.length === 0
  ? `No history yet — suggest ${batchCount} well-known, widely-seen titles to start learning preferences (varied mix of genres helps).`
  : `Analyze all signals above and pick ${batchCount} titles that will confirm or usefully challenge your model of their taste.`}`;


  // Set NEXT_MOVIE_LOG_LLM_PROMPTS=1 in .env.local to re-enable prompt logging when debugging.
  const logLlmPrompts = process.env.NEXT_MOVIE_LOG_LLM_PROMPTS === "1" || process.env.NEXT_MOVIE_LOG_LLM_PROMPTS === "true";
  if (logLlmPrompts) {
    console.log(
      `[next-movie] LLM submit (${llm}): ${batchCount} titles requested. sync=${raw.historySync ?? "legacy"} rated=${ratedTitles.length} promptLines=${informativeHistory.length} skipped=${skipped.length} watchlist=${watchlistTitles.length} notInterested=${notInterestedItems.length} excluded=${allExcluded.length}`
    );
    console.log("[next-movie] --- system prompt ---\n" + systemPrompt);
    console.log("[next-movie] --- user message ---\n" + userMessage);
  }

  let text: string;
  const llmStart = Date.now();
  try {
    text = await callLLM(llm, systemPrompt, userMessage, { maxTokens: LLM_OUTPUT_MAX_TOKENS });
    const llmMs = Date.now() - llmStart;
    console.log(`[next-movie] LLM done (${llm}) in ${(llmMs / 1000).toFixed(1)}s — output ${text.length} chars`);
  } catch (err) {
    const llmMs = Date.now() - llmStart;
    console.error(`[next-movie] LLM failed (${llm}) after ${(llmMs / 1000).toFixed(1)}s:`, err);
    return Response.json({ error: String(err) }, { status: 500 });
  }

  // Fallback: legacy walker that collected inner JSON objects (last wins) — reuse for parseItems second arg
  let legacyWalker = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const candidates: string[] = [];
  let depth = 0,
    start = -1;
  for (let i = 0; i < legacyWalker.length; i++) {
    const ch = legacyWalker[i];
    if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start !== -1) {
        candidates.push(legacyWalker.slice(start, i + 1));
        start = -1;
      }
    }
  }
  if (candidates.length > 0) legacyWalker = candidates[candidates.length - 1];

  let rawItems: RawItem[];
  try {
    rawItems = parseLlmResponse(text, legacyWalker).items;
  } catch (e) {
    console.error("Failed to parse LLM response as JSON:", text, e);
    return Response.json({ error: "Failed to parse response", raw: text }, { status: 500 });
  }

  const seenKeys = new Set<string>();
  const normalized: NextMovieResponse[] = [];

  for (const raw of rawItems) {
    if (!raw?.title || (raw.type !== "movie" && raw.type !== "tv")) continue;
    const key = raw.title.toLowerCase();
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);

    normalized.push({
      title: raw.title,
      type: raw.type,
      year: raw.year ?? null,
      director: raw.director ?? null,
      predictedRating: normalizePredictedRating(raw.predicted_rating, 3),
      actors: raw.actors ?? [],
      plot: raw.plot ?? "",
      posterUrl: null,
      trailerKey: null,
      rtScore: raw.rt_score ?? null,
    });
  }

  if (normalized.length === 0) {
    console.error("LLM returned no valid items:", text);
    return Response.json({ error: "No valid titles in response", raw: text }, { status: 500 });
  }

  const assets = await Promise.all(
    normalized.map(async (m) => {
      if (process.env.TMDB_API_KEY) {
        return fetchTmdbAssets(m.title, m.type, m.year);
      }
      const posterUrl = await fetchPosterFallback(m.title, m.type, m.year);
      return { posterUrl, trailerKey: null };
    })
  );
  for (let i = 0; i < normalized.length; i++) {
    normalized[i] = { ...normalized[i], posterUrl: assets[i].posterUrl, trailerKey: assets[i].trailerKey };
  }

  return Response.json({ movies: normalized });
}
