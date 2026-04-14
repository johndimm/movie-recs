"use client";

import { useState, useEffect, useCallback, useRef, useMemo } from "react";

/** Server merges full rating list in memory; client avoids resending it every request (delta / reuse). */
const LS_LLM_SESSION = "movie-recs-llm-session-id";
const LS_LLM_SYNCED = "movie-recs-llm-history-synced";

function getLlmSessionId(): string {
  let id = localStorage.getItem(LS_LLM_SESSION);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LS_LLM_SESSION, id);
  }
  return id;
}

function getSyncedRatingCount(): number {
  const n = Number.parseInt(localStorage.getItem(LS_LLM_SYNCED) || "0", 10);
  return Number.isFinite(n) ? n : 0;
}

function setSyncedRatingCount(n: number) {
  localStorage.setItem(LS_LLM_SYNCED, String(n));
}

function clearLlmSessionSync() {
  localStorage.removeItem(LS_LLM_SESSION);
  localStorage.removeItem(LS_LLM_SYNCED);
}

function buildHistorySyncPayload(hist: RatingEntry[]): Record<string, unknown> {
  const sessionId = getLlmSessionId();
  let synced = getSyncedRatingCount();
  if (synced > hist.length) synced = 0;

  if (hist.length === 0) {
    return { sessionId, historySync: "full", history: [] };
  }
  if (synced === 0) {
    return { sessionId, historySync: "full", history: hist };
  }
  if (synced < hist.length) {
    return {
      sessionId,
      historySync: "delta",
      baseLength: synced,
      historyAppend: hist.slice(synced),
    };
  }
  return {
    sessionId,
    historySync: "reuse",
    baseLength: hist.length,
  };
}

interface RatingEntry {
  title: string;
  type: "movie" | "tv";
  userRating: number;
  predictedRating: number;
  error: number;
  rtScore?: string | null;
}

interface CurrentMovie {
  title: string;
  type: "movie" | "tv";
  year: number | null;
  director: string | null;
  predictedRating: number;
  actors: string[];
  plot: string;
  posterUrl: string | null;
  rtScore: string | null;
}

interface LastResult extends RatingEntry {
  actors: string[];
  plot: string;
  posterUrl: string | null;
  rtScore: string | null;
}

export interface WatchlistEntry {
  title: string;
  type: "movie" | "tv";
  year: number | null;
  director: string | null;
  actors: string[];
  plot: string;
  posterUrl: string | null;
  rtScore: string | null;
  streaming: string[];
  addedAt: string;
}

/** How many titles the LLM returns per single POST — 5 items ≈ 750 output tokens ≈ 10–15s on DeepSeek. */
const LLM_BATCH_SIZE = 5;
/** Max concurrent LLM fetches. With daisy-chaining, this many batches run continuously until HIGH_WATER_MARK is reached. */
const MAX_REPLENISH_IN_FLIGHT = 3;
/** Stop queuing new batches once the prefetch queue has this many items ready. */
const HIGH_WATER_MARK = 12;

/**
 * Rotating lenses that force the LLM to explore different corners of cinema on each batch.
 * Without this it defaults to the same few hundred popular titles.
 */
const DIVERSITY_LENSES = [
  "films from the 1940s or 1950s",
  "films from the 1960s or 1970s",
  "films from the 1980s",
  "films from the 1990s",
  "films from the 2000s",
  "films from the 2010s or 2020s",
  "non-English language films (French, Italian, Spanish, German, etc.)",
  "Japanese cinema (anime or live-action)",
  "South Korean cinema",
  "Scandinavian or Eastern European cinema",
  "Latin American or Middle Eastern or African cinema",
  "British cinema",
  "documentary films",
  "horror or psychological thriller",
  "science fiction or speculative fiction",
  "comedy or satire",
  "animation (any country, any era)",
  "cult classics or midnight movies",
  "festival darlings (Cannes, Venice, Sundance, TIFF)",
  "overlooked or underseen gems with low name recognition",
  "director-driven auteur films",
  "crime, noir, or heist films",
  "war films or historical epics",
  "romance or coming-of-age stories",
];

const STORAGE_KEY = "movie-recs-history";
const SKIPPED_KEY = "movie-recs-skipped";
const WATCHLIST_KEY = "movie-recs-watchlist";
const NOTSEEN_KEY = "movie-recs-notseen";
const NOT_INTERESTED_KEY = "movie-recs-not-interested"; // {title, rtScore}[] for high-RT taste signal
const TASTE_SUMMARY_KEY = "movie-recs-taste-summary";   // string: LLM's running taste profile

/** Collapse common spellings so the same film is not shown twice (e.g. Se7en vs Seven). */
function canonicalTitleKey(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  if (s === "se7en" || s === "seven") return "seven";
  return s;
}

const WANT_ACCURACY = 85;  // unseen but want to watch — LLM correctly identified appealing content
const SKIP_ACCURACY = 20;  // unseen and not interested — LLM missed the mark entirely

interface NotSeenEvent {
  afterRating: number;
  kind: "want" | "skip";
}

type SeqEvent = { kind: "rated"; error: number } | { kind: "not-seen"; accuracy: number; want: boolean };

function buildSequence(history: RatingEntry[], notSeen: NotSeenEvent[]): SeqEvent[] {
  const sorted = [...notSeen].sort((a, b) => a.afterRating - b.afterRating);
  const events: SeqEvent[] = [];
  let nsIdx = 0;

  const toSeqEvent = (e: NotSeenEvent): SeqEvent => ({
    kind: "not-seen",
    want: e.kind === "want",
    accuracy: e.kind === "want" ? WANT_ACCURACY : SKIP_ACCURACY,
  });

  while (nsIdx < sorted.length && sorted[nsIdx].afterRating === 0) {
    events.push(toSeqEvent(sorted[nsIdx++]));
  }

  for (let i = 0; i < history.length; i++) {
    const e = history[i];
    if (typeof e.error === "number" && !isNaN(e.error)) {
      events.push({ kind: "rated", error: e.error });
    }
    while (nsIdx < sorted.length && sorted[nsIdx].afterRating === i + 1) {
      events.push(toSeqEvent(sorted[nsIdx++]));
    }
  }

  while (nsIdx < sorted.length) {
    events.push(toSeqEvent(sorted[nsIdx++]));
  }

  return events;
}

function ErrorChart({
  history,
  notSeen,
  watchlistCount,
  dontSeeCount,
}: {
  history: RatingEntry[];
  notSeen: NotSeenEvent[];
  /** Saved watchlist size — source of truth (may exceed decision-log events if notSeen drifted). */
  watchlistCount: number;
  /** Not-interested titles (skipped, not on watchlist) — matches dont-see list. */
  dontSeeCount: number;
}) {
  const seq = buildSequence(history, notSeen);
  if (seq.length === 0) return null;

  const W = 600;
  const H = 130;
  const PAD = { top: 10, right: 20, bottom: 30, left: 40 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const n = seq.length;

  const xScale = (i: number) =>
    n === 1 ? PAD.left + chartW / 2 : PAD.left + (i / (n - 1)) * chartW;
  const yScale = (acc: number) =>
    PAD.top + chartH - (Math.min(Math.max(acc, 0), 100) / 100) * chartH;

  const eventAccuracy = (e: SeqEvent) => e.kind === "rated" ? 100 - e.error : e.accuracy;

  const WINDOW = 5;
  const combinedAvgs = seq.map((_, i) => {
    const slice = seq.slice(Math.max(0, i - WINDOW + 1), i + 1);
    return slice.reduce((s, e) => s + eventAccuracy(e), 0) / slice.length;
  });

  const avgPath =
    n === 1
      ? ""
      : combinedAvgs
          .map((v, i) => `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(2)} ${yScale(v).toFixed(2)}`)
          .join(" ");

  const currentAvg = combinedAvgs[combinedAvgs.length - 1];
  const ratedCount = seq.filter((e) => e.kind === "rated").length;
  const wantMarkers = seq.filter((e) => e.kind === "not-seen" && e.want).length;
  const skipMarkers = seq.filter((e) => e.kind === "not-seen" && !e.want).length;

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-2 text-sm text-zinc-500">
        <span><span className="font-semibold text-zinc-800">{ratedCount}</span> rated</span>
        {watchlistCount > 0 && (
          <span title="Titles on your watchlist (saved). Green markers on the chart are from the decision log when each was added; counts can differ if the log was cleared or from older sessions.">
            <span className="font-semibold text-green-600">{watchlistCount}</span> on watchlist{" "}
            <span className="text-zinc-400 text-xs">(+{WANT_ACCURACY})</span>
            {wantMarkers !== watchlistCount && (
              <span className="text-zinc-400 text-xs"> · {wantMarkers} on chart</span>
            )}
          </span>
        )}
        {dontSeeCount > 0 && (
          <span title="Titles marked not interested (saved). Red markers follow the decision log; may differ for the same reasons.">
            <span className="font-semibold text-red-600">{dontSeeCount}</span> not interested{" "}
            <span className="text-zinc-400 text-xs">({SKIP_ACCURACY})</span>
            {skipMarkers !== dontSeeCount && (
              <span className="text-zinc-400 text-xs"> · {skipMarkers} on chart</span>
            )}
          </span>
        )}
        <span>Avg accuracy: <span className="font-semibold text-indigo-700">{currentAvg.toFixed(1)}</span></span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 130 }}>
        {/* Grid lines */}
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={PAD.left} y1={yScale(v)} x2={PAD.left + chartW} y2={yScale(v)}
              stroke={v === WANT_ACCURACY ? "#bbf7d0" : v === SKIP_ACCURACY ? "#fca5a5" : "#e4e4e7"}
              strokeWidth={v === WANT_ACCURACY || v === SKIP_ACCURACY ? 1.5 : 1}
              strokeDasharray={v === WANT_ACCURACY || v === SKIP_ACCURACY ? "4 3" : undefined} />
            <text x={PAD.left - 4} y={yScale(v)} textAnchor="end" dominantBaseline="middle" fontSize="9"
              fill={v === WANT_ACCURACY ? "#16a34a" : v === SKIP_ACCURACY ? "#dc2626" : "#a1a1aa"}>{v}</text>
          </g>
        ))}

        {/* Bars / markers per event */}
        {seq.map((e, i) => {
          const x = xScale(i);
          const acc = eventAccuracy(e);
          if (e.kind === "rated") {
            const barH = (Math.min(Math.max(acc, 0), 100) / 100) * chartH;
            return <rect key={i} x={x - 3} y={yScale(acc)} width={6} height={barH} fill="#93c5fd" opacity={0.7} rx={1} />;
          } else {
            const cy = yScale(acc);
            const r = 5;
            const fill = e.want ? "#16a34a" : "#dc2626";
            return (
              <polygon key={i}
                points={`${x},${cy - r} ${x + r},${cy} ${x},${cy + r} ${x - r},${cy}`}
                fill={fill} opacity={0.85}
              />
            );
          }
        })}

        {/* Combined running average */}
        {n === 1 ? (
          <circle cx={xScale(0)} cy={yScale(combinedAvgs[0])} r={4} fill="#4f46e5" />
        ) : (
          <path d={avgPath} fill="none" stroke="#4f46e5" strokeWidth="2" strokeLinejoin="round" />
        )}

        <text x={PAD.left + chartW / 2} y={H - 4} textAnchor="middle" fontSize="9" fill="#a1a1aa">← decisions →</text>
      </svg>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1 text-xs text-zinc-400">
        <span className="flex items-center gap-1"><span className="inline-block w-3 h-2 rounded bg-blue-300 opacity-70" /> accuracy</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rotate-45 bg-green-600 opacity-85" /> want to see ({WANT_ACCURACY})</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rotate-45 bg-red-600 opacity-85" /> not interested ({SKIP_ACCURACY})</span>
        <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-indigo-600" /> avg accuracy</span>
      </div>
    </div>
  );
}


const SLIDER_THUMB = 28; // px — large enough for a comfortable touch target

/**
 * Custom slider that works reliably on iOS.
 * Uses pointer capture + touch-action:none to avoid scroll conflicts.
 */
function RatingSlider({
  value,
  sliderRef,
  onChange,
  onCommit,
  onEnter,
}: {
  value: number;
  sliderRef?: React.RefObject<HTMLDivElement | null>;
  onChange: (v: number) => void;
  onCommit: (v: number) => void;
  onEnter: () => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  const clamp = (n: number) => Math.round(Math.min(100, Math.max(0, n)));

  const valueFromClientX = (clientX: number): number => {
    const el = trackRef.current;
    if (!el) return value;
    const rect = el.getBoundingClientRect();
    const pct = (clientX - rect.left - SLIDER_THUMB / 2) / (rect.width - SLIDER_THUMB);
    return clamp(pct * 100);
  };

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as HTMLDivElement).setPointerCapture(e.pointerId);
    dragging.current = true;
    onChange(valueFromClientX(e.clientX));
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    onChange(valueFromClientX(e.clientX));
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging.current) return;
    dragging.current = false;
    const v = valueFromClientX(e.clientX);
    onChange(v);
    onCommit(v);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter") { onEnter(); return; }
    const steps: Partial<Record<string, number>> = {
      ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1,
      PageUp: 10, PageDown: -10,
    };
    if (e.key === "Home") { e.preventDefault(); onChange(0); onCommit(0); return; }
    if (e.key === "End")  { e.preventDefault(); onChange(100); onCommit(100); return; }
    const delta = steps[e.key];
    if (delta === undefined) return;
    e.preventDefault();
    const next = clamp(value + delta);
    onChange(next);
    onCommit(next);
  };

  return (
    <div
      ref={(node) => {
        (trackRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
        if (sliderRef) (sliderRef as React.MutableRefObject<HTMLDivElement | null>).current = node;
      }}
      role="slider"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={value}
      tabIndex={0}
      className="relative w-full rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-blue-400"
      style={{ height: 44, touchAction: "none", userSelect: "none", cursor: "pointer" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onKeyDown={onKeyDown}
    >
      {/* Track */}
      <div
        className="absolute rounded-full bg-zinc-200 overflow-hidden"
        style={{ left: SLIDER_THUMB / 2, right: SLIDER_THUMB / 2, top: "50%", transform: "translateY(-50%)", height: 10 }}
      >
        <div className="h-full rounded-full bg-blue-500" style={{ width: `${value}%` }} />
      </div>
      {/* Thumb */}
      <div
        className="absolute rounded-full bg-white border-2 border-blue-500 shadow"
        style={{
          width: SLIDER_THUMB,
          height: SLIDER_THUMB,
          top: "50%",
          transform: "translateY(-50%)",
          left: `calc(${value / 100} * (100% - ${SLIDER_THUMB}px))`,
          pointerEvents: "none",
        }}
      />
    </div>
  );
}

function RTBadge({ score }: { score: string }) {
  const pct = parseInt(score, 10);
  const fresh = !isNaN(pct) ? pct >= 60 : true;
  return (
    <span className={`inline-flex items-center gap-1 text-xs font-semibold px-2 py-0.5 rounded-full ${fresh ? "bg-red-50 text-red-700" : "bg-zinc-100 text-zinc-500"}`}>
      <span>{fresh ? "🍅" : "💀"}</span>
      {score}
    </span>
  );
}

export default function Home() {
  const [history, setHistory] = useState<RatingEntry[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [notSeen, setNotSeen] = useState<NotSeenEvent[]>([]);
  const [notInterested, setNotInterested] = useState<{ title: string; rtScore?: string | null }[]>([]);
  const [tasteSummary, setTasteSummary] = useState<string | null>(null);
  const [current, setCurrent] = useState<CurrentMovie | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [cardOpacity, setCardOpacity] = useState(1);
  const [userRating, setUserRating] = useState("50");
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<"both" | "movie" | "tv">("both");
  const [llm, setLlm] = useState<string>("deepseek");
  const [availableLlms, setAvailableLlms] = useState<{ id: string; label: string }[]>([]);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const inputRef = useRef<HTMLDivElement>(null);
  const prefetchRef = useRef<CurrentMovie[]>([]);
  const replenishInFlight = useRef(0);
  const batchYieldRef = useRef<number[]>([]); // rolling yield fractions (fresh / requested)

  const historyRef = useRef(history);
  const skippedRef = useRef(skipped);
  const watchlistRef = useRef(watchlist);
  const notInterestedRef = useRef(notInterested);
  const tasteSummaryRef = useRef(tasteSummary);
  const replenishOptsRef = useRef<{ mediaType: string; llm: string }>({ mediaType: "both", llm: "deepseek" });
  const zeroYieldStreakRef = useRef(0); // consecutive batches with 0 fresh items — stop daisy-chaining when high
  const lensIndexRef = useRef(0);       // rotates through DIVERSITY_LENSES so each batch explores a different area
  historyRef.current = history;
  skippedRef.current = skipped;
  watchlistRef.current = watchlist;
  notInterestedRef.current = notInterested;
  tasteSummaryRef.current = tasteSummary;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setLightboxUrl(null); }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) setHistory(JSON.parse(stored));
      const storedSkipped = localStorage.getItem(SKIPPED_KEY);
      if (storedSkipped) setSkipped(JSON.parse(storedSkipped));
      const storedWatchlist = localStorage.getItem(WATCHLIST_KEY);
      if (storedWatchlist) setWatchlist(JSON.parse(storedWatchlist));
      const storedNotSeen = localStorage.getItem(NOTSEEN_KEY);
      if (storedNotSeen) setNotSeen(JSON.parse(storedNotSeen));
      const storedNotInterested = localStorage.getItem(NOT_INTERESTED_KEY);
      if (storedNotInterested) setNotInterested(JSON.parse(storedNotInterested));
      const storedTasteSummary = localStorage.getItem(TASTE_SUMMARY_KEY);
      if (storedTasteSummary) { setTasteSummary(storedTasteSummary); tasteSummaryRef.current = storedTasteSummary; }
    } catch {}
  }, []);

  const saveHistory = (h: RatingEntry[]) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(h));
    historyRef.current = h;
    setHistory(h);
  };

  /** Fire-and-forget: ask the LLM to summarize taste. Called after ratings hit 1, 5, 10, 15 ... */
  const updateTasteSummary = useCallback((hist: RatingEntry[], currentLlm: string) => {
    const wl = watchlistRef.current;
    const ni = notInterestedRef.current;
    fetch("/api/taste-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        history: hist,
        watchlistSignals: wl.map((w) => ({ title: w.title, rtScore: w.rtScore })),
        notInterestedSignals: ni,
        existingSummary: tasteSummaryRef.current ?? undefined,
        llm: currentLlm,
      }),
    })
      .then((r) => r.ok ? r.json() : null)
      .then((d: { tasteSummary?: string | null } | null) => {
        if (d?.tasteSummary) {
          localStorage.setItem(TASTE_SUMMARY_KEY, d.tasteSummary);
          tasteSummaryRef.current = d.tasteSummary;
          setTasteSummary(d.tasteSummary);
        }
      })
      .catch(() => {});
  }, []);

  // Single POST: LLM returns many titles; duplicate filtering happens here.
  // Reads history/watchlist from refs at request time so in-flight calls stay aligned with the latest ratings.
  const fetchMovieBatch = useCallback(async (opts: {
    mediaType: string;
    llm: string;
    /** Merged skip list (base skipped + prefetch queue titles + retry dupes). */
    skipped: string[];
  }): Promise<CurrentMovie[] | null> => {
    const timeoutMs = 180_000;
    for (let attempt = 0; attempt < 2; attempt++) {
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), timeoutMs);
      try {
        const hist = historyRef.current;
        const wl = watchlistRef.current;
        const ni = notInterestedRef.current;
        const res = await fetch("/api/next-movie", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({
            ...buildHistorySyncPayload(hist),
            skipped: opts.skipped,
            watchlistTitles: wl.map((w) => ({ title: w.title, rtScore: w.rtScore })),
            notInterestedItems: ni,
            tasteSummary: tasteSummaryRef.current ?? undefined,
            diversityLens: DIVERSITY_LENSES[lensIndexRef.current % DIVERSITY_LENSES.length],
            mediaType: opts.mediaType,
            llm: opts.llm,
            count: LLM_BATCH_SIZE,
          }),
        });
        if (res.status === 409) {
          setSyncedRatingCount(0);
          continue;
        }
        if (!res.ok) continue;
        setSyncedRatingCount(historyRef.current.length);
        const data = (await res.json()) as { movies?: CurrentMovie[] };
        const movies = data.movies?.filter((m) => m?.title) ?? [];
        if (movies.length > 0) return movies;
      } catch (e) {
        if (e instanceof Error && e.name === "AbortError") {
          console.warn("next-movie request timed out after", timeoutMs, "ms");
        }
      } finally {
        window.clearTimeout(timer);
      }
    }
    return null;
  }, []);

  // LLM round-trip. Daisy-chains: after each batch completes, immediately starts another
  // if the queue is below HIGH_WATER_MARK, so the queue is continuously filled.
  const replenish = useCallback(async (
    opts: { mediaType: string; llm: string },
    extraRetrySkips: string[] = []
  ): Promise<Set<string>> => {
    if (replenishInFlight.current >= MAX_REPLENISH_IN_FLIGHT) return new Set();
    replenishOptsRef.current = opts;

    replenishInFlight.current++;
    lensIndexRef.current++; // advance lens so concurrent batches each explore a different area
    const seenThisBatch = new Set<string>();

    try {
      const skippedForApi = [
        ...skippedRef.current,
        ...extraRetrySkips,
        ...prefetchRef.current.map((m) => m.title),
      ];

      const movies = await fetchMovieBatch({
        mediaType: opts.mediaType,
        llm: opts.llm,
        skipped: skippedForApi,
      });

      let freshCount = 0;

      if (movies) {
        // After await, re-check against latest refs — avoids a slower in-flight request
        // re-adding a title the user just rated while another replenish was in flight.
        const excluded = new Set<string>();
        for (const h of historyRef.current) excluded.add(canonicalTitleKey(h.title));
        for (const s of skippedRef.current) excluded.add(canonicalTitleKey(s));
        for (const w of watchlistRef.current) excluded.add(canonicalTitleKey(w.title));
        for (const m of prefetchRef.current) excluded.add(canonicalTitleKey(m.title));

        for (const movie of movies) {
          const key = canonicalTitleKey(movie.title);
          seenThisBatch.add(key);
          if (prefetchRef.current.some((m) => canonicalTitleKey(m.title) === key)) continue;
          if (excluded.has(key)) continue;
          excluded.add(key);
          prefetchRef.current = [...prefetchRef.current, movie];
          freshCount++;
        }
      }

      batchYieldRef.current = [...batchYieldRef.current.slice(-4), freshCount / LLM_BATCH_SIZE];
      zeroYieldStreakRef.current = freshCount > 0 ? 0 : zeroYieldStreakRef.current + 1;
    } finally {
      replenishInFlight.current--;
      // Daisy-chain: keep filling until high-water mark, but stop if recent batches are all dupes.
      // zeroYieldStreak >= 3 means the LLM is stuck — no point hammering it further.
      if (
        prefetchRef.current.length < HIGH_WATER_MARK &&
        replenishInFlight.current < MAX_REPLENISH_IN_FLIGHT &&
        zeroYieldStreakRef.current < 3
      ) {
        replenish(replenishOptsRef.current);
      }
    }

    return seenThisBatch;
  }, [fetchMovieBatch]);

  // Pop instantly from prefetch queue; if empty, wait for replenish first
  const fetchNext = useCallback(async (
    opts: { mediaType: string; llm: string },
    isFirst = false
  ) => {
    setFetchError(null);

    // Drain the queue, skipping any title the user already decided on (guards against stale prefetch entries).
    while (prefetchRef.current.length > 0) {
      const [next, ...rest] = prefetchRef.current;
      prefetchRef.current = rest;
      const excluded = new Set<string>();
      for (const h of historyRef.current) excluded.add(canonicalTitleKey(h.title));
      for (const s of skippedRef.current) excluded.add(canonicalTitleKey(s));
      for (const w of watchlistRef.current) excluded.add(canonicalTitleKey(w.title));
      if (excluded.has(canonicalTitleKey(next.title))) continue; // already seen — discard silently
      if (!isFirst) {
        setCardOpacity(0);
        await new Promise<void>(r => setTimeout(r, 150));
      }
      setCurrent(next); setUserRating("50"); setInitialLoading(false); setCardOpacity(1);
      // Always keep MAX_REPLENISH_IN_FLIGHT batches running so the queue never drains while waiting.
      if (replenishInFlight.current < MAX_REPLENISH_IN_FLIGHT) replenish(opts);
      return;
    }

    // Queue empty — show loading indicator and wait for a batch
    if (!isFirst) setCardOpacity(0.45);
    try {
      // Queue is empty — wait for whatever is already in-flight, or start a fresh batch.
      // Poll until a card arrives or we've waited long enough (up to ~90s total).
      zeroYieldStreakRef.current = 0; // reset so the daisy-chain can run
      if (replenishInFlight.current === 0) replenish(opts); // nothing running — kick one off
      const deadline = Date.now() + 90_000;
      while (prefetchRef.current.length === 0 && replenishInFlight.current > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 200));
      }
      const next = prefetchRef.current.shift();
      if (!next) {
        setCardOpacity(1); setInitialLoading(false);
        setFetchError("Couldn't find a new title. Try again.");
        return;
      }
      if (!isFirst) {
        setCardOpacity(0);
        await new Promise<void>(r => setTimeout(r, 150));
      }
      setCurrent(next); setUserRating("50"); setInitialLoading(false); setCardOpacity(1); setFetchError(null);
    } catch (e) {
      console.error("fetchNext failed:", e);
      setCardOpacity(1); setInitialLoading(false);
      setFetchError("Something went wrong. Try again.");
    }
  }, [replenish]);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const hist: RatingEntry[] = stored ? JSON.parse(stored) : [];
    const storedSkipped = localStorage.getItem(SKIPPED_KEY);
    const skip: string[] = storedSkipped ? JSON.parse(storedSkipped) : [];
    const storedWl = localStorage.getItem(WATCHLIST_KEY);
    const wl: WatchlistEntry[] = storedWl ? JSON.parse(storedWl) : [];
    const storedNi = localStorage.getItem(NOT_INTERESTED_KEY);
    const ni: { title: string; rtScore?: string | null }[] = storedNi ? JSON.parse(storedNi) : [];
    historyRef.current = hist;
    skippedRef.current = skip;
    watchlistRef.current = wl;
    notInterestedRef.current = ni;
    fetchNext({ mediaType, llm }, true);
  }, [fetchNext]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: { llms: { id: string; label: string }[] }) => {
        setAvailableLlms(d.llms);
        if (d.llms.length > 0) setLlm(d.llms[0].id);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (current && cardOpacity === 1) inputRef.current?.focus();
  }, [current, cardOpacity]);

  // When mediaType changes, replace the current card if it doesn't match
  useEffect(() => {
    if (!current) return;
    if (mediaType !== "both" && current.type !== mediaType) {
      prefetchRef.current = [];
      batchYieldRef.current = [];
      fetchNext({ mediaType, llm });
    }
  }, [mediaType]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRate = (overrideRating?: number) => {
    const rating =
      overrideRating !== undefined
        ? Math.min(100, Math.max(0, Math.round(overrideRating)))
        : parseInt(userRating, 10) || 50;
    if (!current) return;
    const error = Math.abs(rating - current.predictedRating);
    const entry: RatingEntry = { title: current.title, type: current.type, userRating: rating, predictedRating: current.predictedRating, error, rtScore: current.rtScore };
    setLastResult({ ...entry, actors: current.actors, plot: current.plot, posterUrl: current.posterUrl, rtScore: current.rtScore });
    const newHistory = [...history, entry];
    saveHistory(newHistory);
    zeroYieldStreakRef.current = 0; // new exclusion may unblock the LLM
    // Update taste profile after 1st rating, then every 5 (1, 5, 10, 15 …)
    const n = newHistory.length;
    if (n === 1 || n % 5 === 0) updateTasteSummary(newHistory, llm);
    fetchNext({ mediaType, llm });
  };

  const recordNotSeen = (kind: "want" | "skip") => {
    if (!current) return;
    const snapshot = current;

    let newWatchlist = watchlist;
    if (kind === "want") {
      // Save immediately with empty streaming so the card advances without waiting
      const entry: WatchlistEntry = {
        title: snapshot.title,
        type: snapshot.type,
        year: snapshot.year,
        director: snapshot.director,
        actors: snapshot.actors,
        plot: snapshot.plot,
        posterUrl: snapshot.posterUrl,
        rtScore: snapshot.rtScore,
        streaming: [],
        addedAt: new Date().toISOString(),
      };
      newWatchlist = [entry, ...watchlist.filter((w) => w.title !== snapshot.title)];
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(newWatchlist));
      setWatchlist(newWatchlist);

      // Patch streaming in the background
      fetch("/api/streaming", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: snapshot.title, year: snapshot.year, llm }),
      }).then(r => r.ok ? r.json() : { services: [] })
        .then(({ services }: { services: string[] }) => {
          if (!services.length) return;
          setWatchlist(prev => {
            const updated = prev.map(w => w.title === snapshot.title ? { ...w, streaming: services } : w);
            localStorage.setItem(WATCHLIST_KEY, JSON.stringify(updated));
            return updated;
          });
        })
        .catch(() => {});
    }

    const nsEvent: NotSeenEvent = { afterRating: history.length, kind };
    const newNotSeen = [...notSeen, nsEvent];
    localStorage.setItem(NOTSEEN_KEY, JSON.stringify(newNotSeen));
    setNotSeen(newNotSeen);

    const newSkipped = [...skipped, snapshot.title];
    localStorage.setItem(SKIPPED_KEY, JSON.stringify(newSkipped));
    setSkipped(newSkipped);

    // For "not interested" items, store with RT score so the server can surface high-RT dismissals
    // as a taste signal (user diverges from critical consensus).
    let newNotInterested = notInterested;
    if (kind === "skip") {
      newNotInterested = [...notInterested, { title: snapshot.title, rtScore: snapshot.rtScore }];
      localStorage.setItem(NOT_INTERESTED_KEY, JSON.stringify(newNotInterested));
      setNotInterested(newNotInterested);
    }

    skippedRef.current = newSkipped;
    watchlistRef.current = newWatchlist;
    notInterestedRef.current = newNotInterested;
    zeroYieldStreakRef.current = 0; // new exclusion may unblock the LLM
    fetchNext({ mediaType, llm });
  };


  const handleReset = () => {
    if (confirm("Clear all ratings and start over?")) {
      saveHistory([]);
      localStorage.removeItem(SKIPPED_KEY);
      localStorage.removeItem(NOTSEEN_KEY);
      localStorage.removeItem(WATCHLIST_KEY);
      localStorage.removeItem(NOT_INTERESTED_KEY);
      localStorage.removeItem(TASTE_SUMMARY_KEY);
      clearLlmSessionSync();
      setSkipped([]);
      setNotSeen([]);
      setWatchlist([]);
      setNotInterested([]);
      setTasteSummary(null);
      tasteSummaryRef.current = null;
      skippedRef.current = [];
      watchlistRef.current = [];
      notInterestedRef.current = [];
      prefetchRef.current = [];
      batchYieldRef.current = [];
      fetchNext({ mediaType, llm });
    }
  };

  /** Remove a rated entry from history and show it as the current card for re-rating. */
  const reconsiderHistoryEntry = (entry: RatingEntry) => {
    const newHistory = history.filter((h) => h.title !== entry.title);
    saveHistory(newHistory);
    const movie: CurrentMovie = {
      title: entry.title,
      type: entry.type,
      year: null,
      director: null,
      predictedRating: entry.predictedRating,
      actors: [],
      plot: "",
      posterUrl: null,
      rtScore: entry.rtScore ?? null,
    };
    setUserRating("50");
    setCurrent(movie);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /** Remove a not-interested entry from skipped/not-interested lists and show it as the current card. */
  const reconsiderNotInterested = (item: { title: string; rtScore?: string | null }) => {
    const newSkipped = skipped.filter((s) => s !== item.title);
    localStorage.setItem(SKIPPED_KEY, JSON.stringify(newSkipped));
    setSkipped(newSkipped);
    skippedRef.current = newSkipped;

    const newNotInterested = notInterested.filter((n) => n.title !== item.title);
    localStorage.setItem(NOT_INTERESTED_KEY, JSON.stringify(newNotInterested));
    setNotInterested(newNotInterested);
    notInterestedRef.current = newNotInterested;

    const movie: CurrentMovie = {
      title: item.title,
      type: "movie",
      year: null,
      director: null,
      predictedRating: 50,
      actors: [],
      plot: "",
      posterUrl: null,
      rtScore: item.rtScore ?? null,
    };
    setUserRating("50");
    setCurrent(movie);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const ratingNum = parseInt(userRating, 10);

  /** Haven’t-seen titles you didn’t add to the watchlist (not interested), newest first — includes legacy rows stored only in `skipped`. */
  const dontSeeRows = useMemo(() => {
    const wl = new Set(watchlist.map((w) => canonicalTitleKey(w.title)));
    const rtByKey = new Map<string, string | null | undefined>();
    for (const n of notInterested) {
      rtByKey.set(canonicalTitleKey(n.title), n.rtScore);
    }
    const out: { title: string; rtScore: string | null | undefined }[] = [];
    const seen = new Set<string>();
    for (let i = skipped.length - 1; i >= 0; i--) {
      const s = skipped[i];
      const k = canonicalTitleKey(s);
      if (wl.has(k) || seen.has(k)) continue;
      seen.add(k);
      out.push({
        title: s,
        rtScore: rtByKey.has(k) ? rtByKey.get(k) : null,
      });
    }
    return out;
  }, [skipped, watchlist, notInterested]);

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-6 sm:py-10 px-4">
      <div className="w-full max-w-3xl space-y-4 sm:space-y-6">

        {/* Header */}
        <div className="flex items-start justify-between gap-2">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-zinc-900">Movie Recs</h1>
            <p className="text-sm text-zinc-500">Discover films you haven&apos;t seen but will love.</p>
            <p className="text-xs text-zinc-400 hidden sm:block">Rate what you&apos;ve seen — the AI learns your taste to find them.</p>
          </div>
          {history.length > 0 && (
            <button onClick={handleReset} className="text-xs text-zinc-400 hover:text-red-500 transition-colors">
              Reset
            </button>
          )}
        </div>

        {/* Controls */}
        <div className="flex flex-wrap items-center gap-3">
          {/* Media type toggle */}
          <div className="flex rounded-xl border border-zinc-200 bg-white overflow-hidden text-sm shadow-sm">
            {(["both", "movie", "tv"] as const).map((opt) => (
              <button
                key={opt}
                onClick={() => setMediaType(opt)}
                className={`px-3 py-1.5 font-medium transition-colors ${
                  mediaType === opt
                    ? "bg-zinc-900 text-white"
                    : "text-zinc-500 hover:bg-zinc-50"
                }`}
              >
                {opt === "both" ? "Movies & TV" : opt === "movie" ? "Movies" : "TV Series"}
              </button>
            ))}
          </div>

          {/* LLM selector */}
          {availableLlms.length > 1 && (
            <div className="flex rounded-xl border border-zinc-200 bg-white overflow-hidden text-sm shadow-sm">
              {availableLlms.map((l) => (
                <button
                  key={l.id}
                  onClick={() => setLlm(l.id)}
                  className={`px-3 py-1.5 font-medium transition-colors ${
                    llm === l.id
                      ? "bg-indigo-600 text-white"
                      : "text-zinc-500 hover:bg-zinc-50"
                  }`}
                >
                  {l.label}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Stats chart + last result */}
        {history.length > 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 p-4 shadow-sm space-y-4">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">How well the AI knows your taste</p>
            <ErrorChart
              history={history}
              notSeen={notSeen}
              watchlistCount={watchlist.length}
              dontSeeCount={dontSeeRows.length}
            />

            {lastResult && (
              <div className="border-t border-zinc-100 pt-4 space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-xs text-zinc-400">
                    Last: <span className="font-medium text-zinc-600">{lastResult.title}</span>
                  </p>
                  {lastResult.rtScore && <RTBadge score={lastResult.rtScore} />}
                </div>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className="bg-zinc-50 rounded-xl py-2">
                    <div className="text-xs text-zinc-400">You</div>
                    <div className="text-2xl font-bold text-zinc-900">{lastResult.userRating}</div>
                  </div>
                  <div className="bg-zinc-50 rounded-xl py-2">
                    <div className="text-xs text-zinc-400">AI</div>
                    <div className="text-2xl font-bold text-blue-600">{lastResult.predictedRating}</div>
                  </div>
                  <div className={`rounded-xl py-2 ${lastResult.error <= 10 ? "bg-green-50" : lastResult.error <= 25 ? "bg-yellow-50" : "bg-red-50"}`}>
                    <div className="text-xs text-zinc-400">Error</div>
                    <div className={`text-2xl font-bold ${lastResult.error <= 10 ? "text-green-700" : lastResult.error <= 25 ? "text-yellow-700" : "text-red-700"}`}>
                      {lastResult.error}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        )}


        {/* Taste profile card */}
        {tasteSummary && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-4">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">AI&apos;s model of your taste</p>
            <p className="text-sm text-zinc-700 leading-relaxed" style={{ borderLeft: "3px solid #a78bfa", paddingLeft: "12px" }}>
              {tasteSummary}
            </p>
          </div>
        )}

        {/* Movie card */}
        <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
          {initialLoading ? (
            <div className="p-10 flex items-center justify-center">
              <div className="flex gap-1">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="w-2 h-2 bg-blue-400 rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
                ))}
              </div>
            </div>
          ) : current ? (
            <div
              className="flex flex-col sm:flex-row gap-4 p-4 sm:p-6"
              style={{ opacity: cardOpacity, transition: "opacity 150ms ease" }}
            >
              <div className="sm:flex-shrink-0 sm:self-start w-full sm:w-56">
                {current.posterUrl ? (
                  <button
                    type="button"
                    onClick={() => setLightboxUrl(current.posterUrl)}
                    className="w-full rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow cursor-zoom-in block"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={current.posterUrl}
                      alt={`${current.title} poster`}
                      referrerPolicy="no-referrer"
                      className="w-full sm:w-56 h-52 sm:h-auto object-cover object-center sm:object-top"
                    />
                  </button>
                ) : (
                  <div
                    className="w-full sm:w-56 h-52 sm:min-h-[14rem] rounded-xl bg-zinc-100 border border-zinc-200 flex flex-col items-center justify-center gap-2 text-zinc-400 text-sm px-3 text-center"
                    title="Posters: TMDB (TMDB_API_KEY) first, then Serper (SERPER_API_KEY). Add TMDB for free official posters."
                  >
                    <span className="text-3xl" aria-hidden>🎬</span>
                    <span>No poster yet</span>
                  </div>
                )}
              </div>
              <div className="flex-1 min-w-0 space-y-4">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                      {current.type === "tv" ? "TV Series" : "Movie"}
                      {current.year && <span className="ml-1 font-normal">· {current.year}</span>}
                    </span>
                    {current.rtScore && <RTBadge score={current.rtScore} />}
                  </div>
                  <h2 className="text-2xl font-bold text-zinc-900 mt-1 leading-tight">{current.title}</h2>
                  {current.director && (
                    <p className="mt-1 text-sm text-zinc-500">
                      <span className="text-zinc-400">{current.type === "tv" ? "Created by" : "Dir."}</span> {current.director}
                    </p>
                  )}
                  {current.actors.length > 0 && (
                    <p className="mt-0.5 text-sm text-zinc-500">{current.actors.join(" · ")}</p>
                  )}
                  {current.plot && (
                    <p className="mt-2 text-sm text-zinc-600 leading-relaxed">{current.plot}</p>
                  )}
                </div>

                <div className="space-y-3">
                  {/* Seen it — rate it */}
                  <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-3 space-y-3">
                    <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">I&apos;ve seen it — rate it</p>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-zinc-600">Your rating</span>
                      <span className="text-3xl font-bold text-zinc-900 w-14 text-right tabular-nums">{ratingNum || 50}</span>
                    </div>
                    <RatingSlider
                      value={ratingNum || 50}
                      sliderRef={inputRef}
                      onChange={(v) => setUserRating(String(v))}
                      onCommit={(v) => handleRate(v)}
                      onEnter={() => handleRate()}
                    />
                    <div className="flex justify-between text-xs text-zinc-400 px-0.5">
                      <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
                    </div>
                    <p className="text-xs text-zinc-400 text-center">Drag the slider — rating saves on release. Arrow keys or Enter also work.</p>
                  </div>

                  {/* Haven't seen it */}
                  <div className="rounded-xl bg-zinc-50 border border-zinc-200 p-3 space-y-2">
                    <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Haven&apos;t seen it</p>
                    <div className="grid grid-cols-2 gap-2">
                      <button
                        onClick={() => recordNotSeen("skip")}
                        className="py-2 rounded-xl border border-zinc-200 text-sm text-zinc-500 hover:bg-zinc-100 active:bg-zinc-200 active:border-zinc-400 active:scale-95 transition-all"
                      >
                        Not interested
                      </button>
                      <button
                        onClick={() => recordNotSeen("want")}
                        className="py-2 rounded-xl border border-green-200 bg-green-50 text-sm font-medium text-green-700 hover:bg-green-100 active:bg-green-200 active:border-green-400 active:scale-95 transition-all"
                      >
                        Want to watch
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Full rating history */}
        {history.length > 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm">
            <div className="px-4 py-3 border-b border-zinc-100 flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">All ratings</p>
              <span className="text-xs text-zinc-400 tabular-nums">{history.length}</span>
            </div>
            <ul className="divide-y divide-zinc-50 max-h-[min(50vh,28rem)] overflow-y-auto overscroll-contain">
              {[...history].reverse().map((e, i) => (
                <li
                  key={`${e.title}-${history.length - 1 - i}`}
                  onClick={() => reconsiderHistoryEntry(e)}
                  className="px-4 py-2 flex items-center justify-between gap-3 text-sm min-w-0 cursor-pointer hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
                  title="Click to re-rate"
                >
                  <div className="min-w-0 flex items-baseline gap-1.5">
                    <span className="font-medium text-zinc-800 truncate">{e.title}</span>
                    <span className="text-xs text-zinc-400 flex-shrink-0">{e.type === "tv" ? "TV" : "Film"}</span>
                  </div>
                  <div className="flex items-center gap-2 text-xs flex-shrink-0">
                    <span className="text-zinc-600">You: <strong>{e.userRating}</strong></span>
                    <span className="text-blue-500">AI: <strong>{e.predictedRating}</strong></span>
                    <span className={`font-bold ${e.error <= 10 ? "text-green-600" : e.error <= 25 ? "text-yellow-600" : "text-red-600"}`}>
                      ±{e.error}
                    </span>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}

        {/* All “not interested” (haven’t seen — didn’t want to watch) */}
        {dontSeeRows.length > 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm">
            <div className="px-4 py-3 border-b border-zinc-100 flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Not interested</p>
              <span className="text-xs text-zinc-400 tabular-nums">{dontSeeRows.length}</span>
            </div>
            <ul className="divide-y divide-zinc-50 max-h-[min(40vh,22rem)] overflow-y-auto overscroll-contain">
              {dontSeeRows.map((e, i) => (
                <li
                  key={`${e.title}-${i}`}
                  onClick={() => reconsiderNotInterested(e)}
                  className="px-4 py-2 flex items-center justify-between gap-3 text-sm min-w-0 cursor-pointer hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
                  title="Click to reconsider"
                >
                  <span className="font-medium text-zinc-800 truncate">{e.title}</span>
                  {e.rtScore != null && e.rtScore !== "" ? (
                    <span className="text-xs text-zinc-500 flex-shrink-0 tabular-nums">RT {e.rtScore}</span>
                  ) : (
                    <span className="text-xs text-zinc-400 flex-shrink-0">—</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

      </div>

      {/* Fetch error with retry */}
      {fetchError && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-3 px-4 py-2.5 rounded-full bg-red-900 text-white text-sm shadow-lg">
          <span>{fetchError}</span>
          <button
            onClick={() => fetchNext({ mediaType, llm })}
            className="font-semibold underline underline-offset-2 hover:no-underline"
          >
            Retry
          </button>
        </div>
      )}

      {/* Thinking indicator — fixed so it's always visible */}
      <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-zinc-900 text-white text-sm shadow-lg transition-all duration-300 ${cardOpacity < 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}`}>
        <div className="flex gap-1">
          {[0,1,2].map(i => (
            <div key={i} className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
        LLM is thinking…
      </div>

      {/* Lightbox */}
      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 cursor-zoom-out"
          onClick={() => setLightboxUrl(null)}
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={lightboxUrl}
            alt="Poster"
            className="max-h-[90vh] max-w-[90vw] rounded-2xl shadow-2xl object-contain"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}
    </div>
  );
}
