"use client";

import { useState, useEffect, useCallback, useRef, useId, memo } from "react";
import Link from "next/link";
import type { Channel } from "./channels/page";
import { ALL_CHANNEL, normalizeChannel } from "./channels/page";
import RTBadge from "./components/RTBadge";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { clampStarRating, migrateRatingValue } from "./lib/ratingScale";
import {
  LEGACY_PREFETCH_QUEUE_KEY,
  prefetchQueueStorageKey,
} from "./lib/storageKeys";
import {
  applyFactoryBootstrap,
  hasNoChannelsPersisted,
  mergeFactoryChannelsAndQueues,
} from "./lib/factoryChannels";
import { pushUnseenInterestEntry, type UnseenInterestEntry } from "./lib/unseenInterestLog";

function migrateRatingEntry(e: RatingEntry): RatingEntry {
  const u = migrateRatingValue(e.userRating);
  const p = migrateRatingValue(e.predictedRating);
  return { ...e, userRating: u, predictedRating: p, error: Math.abs(u - p) };
}

// ── YouTube IFrame API minimal type shim ──────────────────────────────────────
declare global {
  interface Window {
    YT: {
      Player: new (
        el: HTMLElement,
        opts: {
          videoId: string;
          width?: string | number;
          height?: string | number;
          playerVars?: Record<string, unknown>;
          events?: {
            onReady?: (e: { target: YTPlayer }) => void;
            onStateChange?: (e: { data: number }) => void;
          };
        }
      ) => YTPlayer;
      PlayerState: { ENDED: number; PLAYING: number; PAUSED: number; BUFFERING: number; CUED: number };
    };
    onYouTubeIframeAPIReady?: () => void;
  }
}
interface YTPlayer {
  getCurrentTime(): number;
  getDuration(): number;
  getVolume(): number;
  isMuted(): boolean;
  setVolume(v: number): void;
  unMute(): void;
  loadVideoById(videoId: string, startSeconds?: number): void;
  destroy(): void;
}

// Loads https://www.youtube.com/iframe_api once; resolves when YT.Player is available.
let _ytApiLoaded = false;
let _ytApiReady = false;
const _ytReadyCallbacks: Array<() => void> = [];

function flushYtReady() {
  if (!window.YT?.Player) return;
  if (_ytApiReady) return;
  _ytApiReady = true;
  _ytReadyCallbacks.forEach((cb) => cb());
  _ytReadyCallbacks.length = 0;
}

function loadYouTubeApi(): Promise<void> {
  return new Promise((resolve) => {
    if (_ytApiReady && window.YT?.Player) {
      resolve();
      return;
    }
    _ytReadyCallbacks.push(resolve);
    if (_ytApiLoaded) {
      // Script tag already injected but callback may be delayed or blocked — poll for YT.
      const t = window.setInterval(() => {
        if (window.YT?.Player) {
          window.clearInterval(t);
          flushYtReady();
        }
      }, 50);
      window.setTimeout(() => window.clearInterval(t), 20_000);
      return;
    }
    _ytApiLoaded = true;
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      flushYtReady();
    };
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);
    // If the script was cached and YT appears before the global callback runs.
    window.setTimeout(() => {
      if (window.YT?.Player) flushYtReady();
    }, 0);
  });
}

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

export interface RatingEntry {
  title: string;
  type: "movie" | "tv";
  userRating: number;
  predictedRating: number;
  error: number;
  rtScore?: string | null;
  channelId?: string;
  posterUrl?: string | null;
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
  trailerKey: string | null;
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
/**
 * Stop daisy-chaining replenishes once the queue has this many items.
 * Lower = new ratings affect upcoming picks sooner (fewer “stale” cards buffered).
 * Higher = less risk of an empty queue if the LLM is slow. ~6 ≈ 1–2 batches ahead.
 */
const HIGH_WATER_MARK = 6;

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

/** YouTube search for clips when the card has no embedded trailer (poster-only layout). */
function youtubeSearchUrlForMovie(title: string, type: "movie" | "tv", year: number | null): string {
  const q = [title, year != null ? String(year) : null, type === "tv" ? "TV series trailer" : "movie trailer"]
    .filter(Boolean)
    .join(" ");
  return `https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`;
}

const STORAGE_KEY = "movie-recs-history";
const SKIPPED_KEY = "movie-recs-skipped";
/** Titles advanced with "Next" — excluded from picks, not a rating or "not interested". */
const PASSED_KEY = "movie-recs-passed";
const WATCHLIST_KEY = "movie-recs-watchlist";
const NOTSEEN_KEY = "movie-recs-notseen";
const NOT_INTERESTED_KEY = "movie-recs-not-interested"; // {title, rtScore}[] for high-RT taste signal
const TASTE_SUMMARY_KEY = "movie-recs-taste-summary";   // string: LLM's running taste profile
const SETTINGS_KEY = "movie-recs-settings";
const RECONSIDER_KEY = "movie-recs-reconsider";
const CHANNELS_KEY = "movie-recs-channels";
const ACTIVE_CHANNEL_KEY = "movie-recs-active-channel";

function loadSetting<T>(key: string, fallback: T): T {
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    if (!s) return fallback;
    const obj = JSON.parse(s);
    return key in obj ? (obj[key] as T) : fallback;
  } catch {
    return fallback;
  }
}

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

interface NotSeenEvent {
  afterRating: number;
  kind: "want" | "skip";
}

/** Resolve mouse/touch X position within a button to a half-star value (0.5 increments). */
function halfStarValue(clientX: number, rect: DOMRect, n: number): number {
  return clientX - rect.left < rect.width / 2 ? n - 0.5 : n;
}

/** A row of 5 clickable stars supporting half-star precision. */
const StarRow = memo(function StarRow({
  filled,
  color,
  label,
  onRate,
  compact = false,
}: {
  filled: number;
  color: "red" | "blue";
  label: string;
  onRate: (stars: number) => void;
  /** Tighter label + stars for single-line toolbar layout */
  compact?: boolean;
}) {
  const [hover, setHover] = useState(0);
  /** Value from last click — keeps stars lit after pointer leaves (hover clears on mouseleave). */
  const [committed, setCommitted] = useState(0);
  useEffect(() => {
    setCommitted(filled);
    setHover(0);
  }, [filled]);
  const active = hover || filled || committed;
  const filledColor = color === "red" ? "text-red-500" : "text-blue-500";

  return (
    <div
      className={`flex min-w-0 flex-wrap items-center ${compact ? "justify-center gap-x-1.5 gap-y-1 sm:gap-x-2 sm:gap-y-0" : "gap-3"}`}
    >
      <span
        className={`font-medium text-zinc-800 shrink-0 leading-snug ${compact ? "text-left text-xs w-12 sm:w-16 sm:text-sm" : "text-right text-sm w-28"}`}
      >
        {label}
      </span>
      <div className={`flex min-w-0 shrink ${compact ? "gap-px sm:gap-0.5" : "gap-1"}`} onMouseLeave={() => setHover(0)}>
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            /* pointerdown preventDefault: blocks focus() scroll on tap (mouse + touch); keyboard still uses keydown to focus */
            onPointerDown={(e) => e.preventDefault()}
            onMouseMove={(e) => setHover(halfStarValue(e.clientX, e.currentTarget.getBoundingClientRect(), n))}
            onClick={(e) => {
              const v = halfStarValue(e.clientX, e.currentTarget.getBoundingClientRect(), n);
              setCommitted(v);
              onRate(v);
            }}
            className={`relative leading-none select-none ${compact ? "text-2xl sm:text-3xl" : "text-3xl"}`}
            style={{ touchAction: "manipulation" }}
          >
            <span className="text-zinc-200">★</span>
            {active >= n && (
              <span className={`absolute inset-0 ${filledColor}`}>★</span>
            )}
            {active >= n - 0.5 && active < n && (
              <span className={`absolute inset-0 overflow-hidden ${filledColor}`} style={{ width: "50%" }}>★</span>
            )}
          </button>
        ))}
      </div>
    </div>
  );
});

const PassNextButton = memo(function PassNextButton({
  onPass,
  compact = false,
  prominent = false,
}: {
  onPass: () => void;
  compact?: boolean;
  /** Larger, hero-style — use when Next is the primary control above the rating row */
  prominent?: boolean;
}) {
  const sizing = prominent
    ? "gap-2 rounded-xl px-8 py-3.5 text-base font-semibold shadow-lg sm:px-10 sm:py-4 sm:text-lg"
    : compact
      ? "gap-1 rounded-lg px-2.5 py-1.5 text-xs shadow-md"
      : "gap-1.5 rounded-lg px-4 py-2 text-sm shadow-md";
  const iconClass = prominent ? "h-5 w-5 sm:h-6 sm:w-6" : compact ? "h-3.5 w-3.5" : "h-4 w-4";
  return (
    <button
      type="button"
      onPointerDown={(e) => e.preventDefault()}
      onClick={onPass}
      className={`inline-flex items-center bg-zinc-900 font-semibold text-white transition-colors hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2 shrink-0 touch-manipulation ${sizing}`}
      title="Go to the next title"
      aria-label="Next title"
    >
      Next
      <svg className={`text-white/90 ${iconClass}`} viewBox="0 0 20 20" fill="currentColor" aria-hidden>
        <path fillRule="evenodd" d="M3 10a.75.75 0 01.75-.75h10.638L10.23 5.29a.75.75 0 111.04-1.08l5.5 5.25a.75.75 0 010 1.08l-5.5 5.25a.75.75 0 11-1.04-1.08l4.158-3.96H3.75A.75.75 0 013 10z" clipRule="evenodd" />
      </svg>
    </button>
  );
});

/** Native radios: "Seen it" vs "Not yet" — mutually exclusive, proper keyboard + SR semantics. */
const SeenOrNotRadios = memo(function SeenOrNotRadios({
  name,
  value,
  onChange,
}: {
  name: string;
  value: "unseen" | null;
  onChange: (v: "unseen" | null) => void;
}) {
  return (
    <fieldset className="min-w-0 border-0 p-0 m-0">
      <legend className="sr-only">Have you seen this title?</legend>
      <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2 sm:gap-6">
        <label
          className={`inline-flex cursor-pointer touch-manipulation items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] sm:text-xs font-medium transition-colors ${
            value === null
              ? "border-zinc-300 bg-white text-zinc-900 shadow-sm"
              : "border-transparent text-zinc-500 hover:bg-zinc-100/80"
          }`}
        >
          <input
            type="radio"
            name={name}
            className="h-3.5 w-3.5 shrink-0 accent-zinc-900 sm:h-4 sm:w-4"
            checked={value === null}
            onChange={() => onChange(null)}
          />
          <span>Seen it</span>
        </label>
        <label
          className={`inline-flex cursor-pointer touch-manipulation items-center gap-2 rounded-lg border px-2.5 py-1.5 text-[11px] sm:text-xs font-medium transition-colors ${
            value === "unseen"
              ? "border-zinc-300 bg-white text-zinc-900 shadow-sm"
              : "border-transparent text-zinc-500 hover:bg-zinc-100/80"
          }`}
        >
          <input
            type="radio"
            name={name}
            className="h-3.5 w-3.5 shrink-0 accent-zinc-900 sm:h-4 sm:w-4"
            checked={value === "unseen"}
            onChange={() => onChange("unseen")}
          />
          <span>Not yet</span>
        </label>
      </div>
    </fieldset>
  );
});

// Persists volume across trailer cards (module-level, not localStorage — session only)
let _lastVolume: number | null = null;

/** Reserves the same space as the loaded movie card so initial fetch does not reflow the layout. */
function MovieCardSkeleton({ mode }: { mode: "trailers" | "posters" }) {
  const ratingBlock = (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-2 py-2 sm:px-3 sm:py-2.5">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex justify-center">
          <div className="h-12 w-36 animate-pulse rounded-xl bg-zinc-200 sm:h-14 sm:w-44" />
        </div>
        <div className="flex flex-wrap items-center justify-center gap-x-4 gap-y-2">
          <div className="h-8 w-24 animate-pulse rounded-lg bg-zinc-200" />
          <div className="h-8 w-24 animate-pulse rounded-lg bg-zinc-200" />
        </div>
        <div className="mx-auto h-10 max-w-sm animate-pulse rounded-lg bg-zinc-100" />
      </div>
    </div>
  );

  if (mode === "trailers") {
    return (
      <div className="flex flex-col gap-4 p-4 sm:p-6" aria-busy="true" aria-label="Loading movie">
        {/* Same footprint as TrailerPlayer + metadata + rating */}
        <div className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl bg-black">
          <div className="absolute inset-0 animate-pulse bg-zinc-800/40" aria-hidden />
        </div>
        <div className="space-y-3 animate-pulse">
          <div className="h-3 w-28 rounded bg-zinc-200" />
          <div className="h-8 max-w-lg rounded bg-zinc-200" />
          <div className="h-4 w-full rounded bg-zinc-100" />
          <div className="h-4 w-full rounded bg-zinc-100" />
          <div className="h-4 w-2/3 rounded bg-zinc-100" />
        </div>
        {ratingBlock}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4 p-4 sm:p-6" aria-busy="true" aria-label="Loading movie">
      <div className="flex gap-4 sm:items-start">
        <div
          className="h-[10.5rem] w-28 shrink-0 animate-pulse rounded-xl bg-zinc-200 sm:h-[18rem] sm:w-48"
          aria-hidden
        />
        <div className="min-w-0 flex-1 space-y-3 animate-pulse">
          <div className="h-3 w-24 rounded bg-zinc-200" />
          <div className="h-8 w-4/5 rounded bg-zinc-200" />
          <div className="h-4 w-full rounded bg-zinc-100" />
          <div className="h-4 w-full rounded bg-zinc-100" />
        </div>
      </div>
      {ratingBlock}
    </div>
  );
}

// ── Home hero (isolated from card state so clicks don’t re-render the banner) ──
const HomeHero = memo(function HomeHero() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-zinc-200/90 shadow-sm ring-1 ring-black/5">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src="/banner.png"
        alt=""
        className="pointer-events-none block h-auto w-full select-none"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 z-[1]"
        aria-hidden
        style={{
          background:
            "linear-gradient(to left, rgba(0, 0, 0, 0.4) 0%, rgba(0, 0, 0, 0.14) 38%, transparent 58%)",
        }}
      />
      <div className="absolute inset-0 z-10 flex flex-col justify-center items-end px-4 py-6 sm:px-6 sm:py-8">
        <div className="max-w-xl text-right">
          <h1 className="text-2xl font-bold tracking-tight text-white sm:text-3xl md:text-4xl [text-shadow:1px_0_0_rgba(0,0,0,0.85),-1px_0_0_rgba(0,0,0,0.85),0_1px_0_rgba(0,0,0,0.85),0_-1px_0_rgba(0,0,0,0.85),1px_1px_0_rgba(0,0,0,0.75),-1px_-1px_0_rgba(0,0,0,0.75),1px_-1px_0_rgba(0,0,0,0.75),-1px_1px_0_rgba(0,0,0,0.75),0_2px_12px_rgba(0,0,0,0.45)]">
            Trailer Vision
          </h1>
          <p className="mt-2 text-base font-semibold leading-snug text-white sm:text-lg [text-shadow:1px_0_0_rgba(0,0,0,0.8),-1px_0_0_rgba(0,0,0,0.8),0_1px_0_rgba(0,0,0,0.8),0_-1px_0_rgba(0,0,0,0.8),1px_1px_0_rgba(0,0,0,0.65),-1px_-1px_0_rgba(0,0,0,0.65),0_1px_10px_rgba(0,0,0,0.4)]">
            Discover great films that are new to you
          </p>
        </div>
      </div>
    </div>
  );
});

const PrefetchQueuePanel = memo(function PrefetchQueuePanel({
  prefetchQueueUi,
  channels,
  activeChannelId,
  onPlayAtIndex,
  onRemoveAtIndex,
}: {
  prefetchQueueUi: CurrentMovie[];
  channels: Channel[];
  activeChannelId: string;
  onPlayAtIndex: (index: number) => void;
  onRemoveAtIndex: (index: number) => void;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 sm:p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold text-zinc-900">Upcoming queue</h2>
        <span className="text-xs text-zinc-400 tabular-nums">
          {prefetchQueueUi.length} title{prefetchQueueUi.length === 1 ? "" : "s"}
          {channels.length > 0 && activeChannelId ? (
            <span className="font-medium text-zinc-600">
              {" "}
              · {channels.find((c) => c.id === activeChannelId)?.name ?? "channel"}
            </span>
          ) : null}
        </span>
      </div>
      <p className="text-xs text-zinc-500 mt-1">
        Click a title to play it now. Remove drops it from the list. Saved per channel when Settings backup includes the prefetch queue.
      </p>
      {prefetchQueueUi.length === 0 ? (
        <p className="text-sm text-zinc-400 mt-3">Nothing queued yet — titles appear here as the model responds.</p>
      ) : (
        <ul className="mt-3 divide-y divide-zinc-100 max-h-56 overflow-y-auto rounded-lg border border-zinc-100 bg-white">
          {prefetchQueueUi.map((m, index) => (
            <li
              key={`${canonicalTitleKey(m.title)}-${index}`}
              className="flex items-stretch gap-1 py-1 px-1 text-sm"
            >
              <button
                type="button"
                onClick={() => onPlayAtIndex(index)}
                className="min-w-0 flex-1 flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-zinc-800 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
                aria-label={`Play ${m.title} now`}
              >
                <span className="min-w-0 flex-1 truncate" title={m.title}>
                  {m.title}
                  {m.year != null && <span className="text-zinc-400 font-normal"> · {m.year}</span>}
                </span>
                <span className="shrink-0 text-[10px] uppercase tracking-wide text-zinc-400">
                  {m.type === "tv" ? "TV" : "Film"}
                </span>
              </button>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveAtIndex(index);
                }}
                className="shrink-0 self-center rounded-lg px-2 py-1 text-xs font-medium text-zinc-500 hover:bg-red-50 hover:text-red-600 transition-colors"
                aria-label={`Remove ${m.title} from queue`}
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
});

// ── TrailerPlayer ─────────────────────────────────────────────────────────────
/** One iframe per mount; swap trailers with loadVideoById so rapid card changes don't cancel init (black player). */
const TrailerPlayer = memo(function TrailerPlayer({ videoId }: { videoId: string }) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<YTPlayer | null>(null);
  const videoIdRef = useRef(videoId);

  useEffect(() => {
    videoIdRef.current = videoId;
  }, [videoId]);

  useEffect(() => {
    const mountEl = document.createElement("div");
    mountEl.style.position = "absolute";
    mountEl.style.inset = "0";
    mountEl.style.backgroundColor = "#000";
    wrapperRef.current?.appendChild(mountEl);

    let cancelled = false;
    let playerInstance: YTPlayer | null = null;

    loadYouTubeApi().then(() => {
      if (cancelled || !mountEl.isConnected) return;
      // Must match the parent page origin (including http://localhost:PORT) so the JS API
      // postMessage targets line up. Omitting it on localhost often triggers www-widgetapi errors.
      const origin =
        typeof window !== "undefined" ? window.location.origin : undefined;
      playerInstance = new window.YT.Player(mountEl, {
        videoId: videoIdRef.current,
        width: "100%",
        height: "100%",
        playerVars: {
          autoplay: 1,
          mute: 1,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          enablejsapi: 1,
          ...(origin ? { origin } : {}),
        },
        events: {
          onReady: (e: { target: YTPlayer }) => {
            if (cancelled) return;
            playerRef.current = e.target;
            if (_lastVolume !== null) e.target.setVolume(_lastVolume);
            e.target.unMute();
            try {
              e.target.loadVideoById(videoIdRef.current);
            } catch {
              /* ignore */
            }
          },
        },
      });
    });

    return () => {
      cancelled = true;
      try {
        const p = playerRef.current ?? playerInstance;
        if (p && !p.isMuted()) {
          _lastVolume = p.getVolume();
        }
        p?.destroy();
      } catch {
        /* ignore */
      }
      playerRef.current = null;
      playerInstance = null;
      if (mountEl.isConnected) mountEl.remove();
    };
  }, []);

  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    try {
      p.loadVideoById(videoId);
    } catch {
      /* ignore */
    }
  }, [videoId]);

  return (
    <div
      ref={wrapperRef}
      className="relative aspect-video w-full shrink-0 overflow-hidden rounded-xl bg-black"
      style={{ backgroundColor: "#000" }}
    />
  );
});

/** Trailer layout: title block only — isolated from rating state. */
const TrailerMetadata = memo(function TrailerMetadata({ movie }: { movie: CurrentMovie }) {
  return (
    <div>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
          {movie.type === "tv" ? "TV Series" : "Movie"}
          {movie.year && <span className="ml-1 font-normal">· {movie.year}</span>}
        </span>
        {movie.rtScore && <RTBadge score={movie.rtScore} />}
      </div>
      <h2 className="text-2xl font-bold text-zinc-900 mt-1 leading-tight">{movie.title}</h2>
      {movie.director && (
        <p className="mt-1 text-sm text-zinc-500">
          <span className="text-zinc-400">{movie.type === "tv" ? "Created by" : "Dir."}</span> {movie.director}
        </p>
      )}
      {movie.actors.length > 0 && (
        <p className="mt-0.5 text-sm text-zinc-500">{movie.actors.join(" · ")}</p>
      )}
      {movie.plot && <p className="mt-2 text-sm text-zinc-600 leading-relaxed">{movie.plot}</p>}
    </div>
  );
});

/** Poster layout: poster + metadata — isolated from rating state. */
const PosterMovieTop = memo(function PosterMovieTop({
  movie,
  onOpenPoster,
}: {
  movie: CurrentMovie;
  onOpenPoster: (url: string) => void;
}) {
  return (
    <div className="flex gap-4 sm:items-start">
      <div className="flex-shrink-0 self-start">
        {movie.posterUrl ? (
          <button
            type="button"
            onClick={() => onOpenPoster(movie.posterUrl!)}
            className="rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow cursor-zoom-in block"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={movie.posterUrl}
              alt={`${movie.title} poster`}
              referrerPolicy="no-referrer"
              className="w-28 sm:w-48 h-[10.5rem] sm:h-auto object-cover object-center sm:object-top"
            />
          </button>
        ) : (
          <div className="w-28 sm:w-48 h-[10.5rem] sm:h-[18rem] rounded-xl bg-zinc-100 border border-zinc-200 flex flex-col items-center justify-center gap-1 text-zinc-400 text-xs px-2 text-center">
            <span className="text-2xl" aria-hidden>
              🎬
            </span>
            <span>No poster</span>
          </div>
        )}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
            {movie.type === "tv" ? "TV Series" : "Movie"}
            {movie.year && <span className="ml-1 font-normal">· {movie.year}</span>}
          </span>
          {movie.rtScore && <RTBadge score={movie.rtScore} />}
        </div>
        <h2 className="text-xl sm:text-2xl font-bold text-zinc-900 mt-0.5 leading-tight">
          {!movie.trailerKey ? (
            <a
              href={youtubeSearchUrlForMovie(movie.title, movie.type, movie.year)}
              target="_blank"
              rel="noopener noreferrer"
              className="underline decoration-zinc-300 decoration-2 underline-offset-2 hover:text-indigo-700 hover:decoration-indigo-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300 rounded-sm"
              aria-label={`Search YouTube for ${movie.title} trailer`}
            >
              {movie.title}
            </a>
          ) : (
            movie.title
          )}
        </h2>
        {movie.director && (
          <p className="mt-1 text-sm text-zinc-500">
            <span className="text-zinc-400">{movie.type === "tv" ? "Created by" : "Dir."}</span> {movie.director}
          </p>
        )}
        {movie.actors.length > 0 && (
          <p className="mt-0.5 text-sm text-zinc-500">{movie.actors.join(" · ")}</p>
        )}
        {movie.plot && (
          <p className="mt-2 text-sm text-zinc-600 leading-relaxed line-clamp-3 sm:line-clamp-none">{movie.plot}</p>
        )}
      </div>
    </div>
  );
});

const MovieRatingBlock = memo(function MovieRatingBlock({
  passCurrentCardStable,
  rateSeenStable,
  rateUnseenStable,
  movieTitle,
  starKeyPrefix,
}: {
  passCurrentCardStable: () => void;
  rateSeenStable: (n: number) => void;
  rateUnseenStable: (n: number) => void;
  movieTitle: string;
  starKeyPrefix: "tr" | "po";
}) {
  const seenRadioGroupName = useId();
  const [seenStatus, setSeenStatus] = useState<"unseen" | null>(null);
  useEffect(() => {
    setSeenStatus(null);
  }, [movieTitle]);
  const onSeenStatusChange = useCallback((v: "unseen" | null) => {
    setSeenStatus(v);
  }, []);

  return (
    <div className="rounded-xl bg-zinc-50 border border-zinc-200 px-2 py-2 sm:px-3 sm:py-2.5">
      <div className="flex min-w-0 flex-col gap-3">
        <div className="flex justify-center">
          <PassNextButton prominent onPass={passCurrentCardStable} />
        </div>
        <SeenOrNotRadios name={seenRadioGroupName} value={seenStatus} onChange={onSeenStatusChange} />
        <div className="flex flex-wrap items-center justify-center gap-x-1.5 gap-y-2 sm:gap-2 min-w-0">
          <div className="min-w-0">
            {seenStatus === null ? (
              <StarRow
                key={`${starKeyPrefix}-seen-${movieTitle}`}
                compact
                filled={0}
                color="red"
                label="Rating"
                onRate={rateSeenStable}
              />
            ) : (
              <StarRow
                key={`${starKeyPrefix}-unseen-${movieTitle}`}
                compact
                filled={0}
                color="blue"
                label="Interest"
                onRate={rateUnseenStable}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

const ChannelsToolbar = memo(function ChannelsToolbar({
  channels,
  activeChannelId,
  onLoadStarter,
  onSelectChannel,
  onRequestDeleteChannel,
}: {
  channels: Channel[];
  activeChannelId: string;
  onLoadStarter: () => void;
  onSelectChannel: (id: string) => void;
  onRequestDeleteChannel: (ch: Channel) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2 items-center pb-1">
      {!channels.some((ch) => ch.id !== "all") ? (
        <>
          <button
            type="button"
            onClick={onLoadStarter}
            className="shrink-0 rounded-full border border-indigo-200 bg-indigo-50 px-4 py-2 text-sm font-semibold text-indigo-900 shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-100"
          >
            Load starter channels
          </button>
          <Link
            href="/channels?new=1"
            className="shrink-0 flex size-8 items-center justify-center rounded-full border border-dashed border-zinc-300 bg-white text-lg font-light leading-none text-zinc-500 transition-colors hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600"
            title="Create a new channel"
            aria-label="Create a new channel"
          >
            +
          </Link>
        </>
      ) : (
        <>
          {channels.map((ch) => {
            const deletable = ch.id !== "all";
            return (
              <div key={ch.id} className="group relative shrink-0">
                <button
                  type="button"
                  onClick={() => onSelectChannel(ch.id)}
                  className={`max-w-[240px] rounded-full py-1.5 text-sm font-semibold whitespace-nowrap transition-colors pl-3.5 ${
                    deletable ? "pr-9" : "pr-3.5"
                  } ${
                    activeChannelId === ch.id
                      ? "bg-zinc-900 text-white shadow-sm"
                      : "bg-white border border-zinc-200 text-zinc-800 hover:border-zinc-300 hover:bg-zinc-50"
                  }`}
                >
                  <span className="block truncate">{ch.name}</span>
                </button>
                {deletable && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onRequestDeleteChannel(ch);
                    }}
                    className={`absolute right-1 top-1/2 z-10 flex h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full text-sm leading-none opacity-100 transition-opacity sm:pointer-events-none sm:opacity-0 sm:group-hover:pointer-events-auto sm:group-hover:opacity-100 ${
                      activeChannelId === ch.id
                        ? "text-zinc-300 hover:bg-white/10 hover:text-red-300"
                        : "text-zinc-400 hover:bg-red-50 hover:text-red-600"
                    }`}
                    aria-label={`Delete channel ${ch.name}`}
                  >
                    ×
                  </button>
                )}
              </div>
            );
          })}
          <Link
            href="/channels?new=1"
            className="shrink-0 flex size-8 items-center justify-center rounded-full border border-dashed border-zinc-300 bg-white text-lg font-light leading-none text-zinc-500 transition-colors hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600"
            title="Create a new channel"
            aria-label="Create a new channel"
          >
            +
          </Link>
        </>
      )}
    </div>
  );
});

export default function Home() {
  /** Persisted lists — refs only on this page (nothing in the tree reads them for render). Updates skip full-tree re-renders. */
  const historyRef = useRef<RatingEntry[]>([]);
  const skippedRef = useRef<string[]>([]);
  const passedRef = useRef<string[]>([]);
  const watchlistRef = useRef<WatchlistEntry[]>([]);
  const notSeenRef = useRef<NotSeenEvent[]>([]);
  const notInterestedRef = useRef<{ title: string; rtScore?: string | null }[]>([]);
  const [tasteSummary, setTasteSummary] = useState<string | null>(null);
  const [current, setCurrent] = useState<CurrentMovie | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  /** True while fetchNext is loading the next title (after first card). Not tied to card opacity — avoids collapsing the layout. */
  const [isAdvancingCard, setIsAdvancingCard] = useState(false);
  const advanceFetchDepthRef = useRef(0);
  /** Delayed advance after star rating — cleared if user uses Next or queue before it fires. */
  const advanceAfterRatingTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [mediaType, setMediaType] = useState<"both" | "movie" | "tv">(() => loadSetting("mediaType", "both" as const));
  const [displayMode, setDisplayMode] = useState<"trailers" | "posters">(() => loadSetting("displayMode", "trailers" as const));
  const [llm, setLlm] = useState<string>(() => loadSetting("llm", "deepseek"));
  const [fetchError, setFetchError] = useState<string | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const prefetchRef = useRef<CurrentMovie[]>([]);
  const [prefetchQueueUi, setPrefetchQueueUi] = useState<CurrentMovie[]>([]);
  const replenishGenRef = useRef(0);
  const savedPrefetchChannelRef = useRef<string | null>(null);
  const replenishInFlight = useRef(0);
  const batchYieldRef = useRef<number[]>([]); // rolling yield fractions (fresh / requested)

  const tasteSummaryRef = useRef(tasteSummary);
  const [userRequest, setUserRequest] = useState<string>(() => loadSetting("userRequest", ""));
  const userRequestRef = useRef("");
  userRequestRef.current = userRequest;
  /** Set after first userRequest effect — used so we only flush prefetch on real edits, not mount/import. */
  const prevUserRequestForFlushRef = useRef<string | undefined>(undefined);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [channelPendingDelete, setChannelPendingDelete] = useState<Channel | null>(null);
  const channelsRef = useRef<Channel[]>([]);
  const [activeChannelId, setActiveChannelId] = useState<string>("");
  const activeChannelIdRef = useRef<string>("");
  activeChannelIdRef.current = activeChannelId;
  channelsRef.current = channels;
  const replenishOptsRef = useRef<{ mediaType: string; llm: string }>({ mediaType: "both", llm: "deepseek" });
  const zeroYieldStreakRef = useRef(0); // consecutive batches with 0 fresh items — stop daisy-chaining when high
  const lensIndexRef = useRef(0);       // rotates through DIVERSITY_LENSES so each batch explores a different area
  tasteSummaryRef.current = tasteSummary;

  const loadPrefetchIntoRefForChannel = useCallback((channelId: string) => {
    const k = prefetchQueueStorageKey(channelId);
    let raw = localStorage.getItem(k);
    if (!raw) {
      raw = localStorage.getItem(LEGACY_PREFETCH_QUEUE_KEY);
      if (raw) {
        try {
          localStorage.setItem(k, raw);
          localStorage.removeItem(LEGACY_PREFETCH_QUEUE_KEY);
        } catch {
          /* ignore */
        }
      }
    }
    if (!raw) {
      prefetchRef.current = [];
      return;
    }
    try {
      const q = JSON.parse(raw) as CurrentMovie[];
      if (Array.isArray(q) && q.every((m) => m && typeof m.title === "string")) {
        prefetchRef.current = q;
      } else {
        prefetchRef.current = [];
      }
    } catch {
      prefetchRef.current = [];
    }
  }, []);

  const persistPrefetchQueue = useCallback(() => {
    const ch = activeChannelIdRef.current?.trim() || "all";
    try {
      localStorage.setItem(prefetchQueueStorageKey(ch), JSON.stringify(prefetchRef.current));
    } catch {
      /* ignore quota */
    }
    setPrefetchQueueUi([...prefetchRef.current]);
  }, []);

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
      if (stored) {
        historyRef.current = (JSON.parse(stored) as RatingEntry[]).map(migrateRatingEntry);
      }
      const storedSkipped = localStorage.getItem(SKIPPED_KEY);
      if (storedSkipped) skippedRef.current = JSON.parse(storedSkipped);
      const storedPassed = localStorage.getItem(PASSED_KEY);
      if (storedPassed) passedRef.current = JSON.parse(storedPassed);
      const storedWatchlist = localStorage.getItem(WATCHLIST_KEY);
      if (storedWatchlist) watchlistRef.current = JSON.parse(storedWatchlist);
      const storedNotSeen = localStorage.getItem(NOTSEEN_KEY);
      if (storedNotSeen) notSeenRef.current = JSON.parse(storedNotSeen);
      const storedNotInterested = localStorage.getItem(NOT_INTERESTED_KEY);
      if (storedNotInterested) notInterestedRef.current = JSON.parse(storedNotInterested);
      const storedTasteSummary = localStorage.getItem(TASTE_SUMMARY_KEY);
      if (storedTasteSummary) { setTasteSummary(storedTasteSummary); tasteSummaryRef.current = storedTasteSummary; }
      if (hasNoChannelsPersisted()) {
        applyFactoryBootstrap();
      }
      let loadedChannels: Channel[] = [];
      const storedChannels = localStorage.getItem(CHANNELS_KEY);
      if (storedChannels) {
        loadedChannels = (JSON.parse(storedChannels) as Channel[]).map(normalizeChannel);
        // Seed All channel if missing
        if (!loadedChannels.find((c) => c.id === "all")) {
          loadedChannels = [ALL_CHANNEL, ...loadedChannels];
          localStorage.setItem(CHANNELS_KEY, JSON.stringify(loadedChannels));
        }
        setChannels(loadedChannels);
        // Before the next useEffect runs fetchNext, React state is still stale — sync ref now so /api/next-movie gets activeChannel.
        channelsRef.current = loadedChannels;
      }
      const storedActiveChannel = localStorage.getItem(ACTIVE_CHANNEL_KEY);
      const defaultChannelId = loadedChannels.length > 0 ? loadedChannels[0].id : "all";
      const activeId = storedActiveChannel || defaultChannelId;
      setActiveChannelId(activeId);
      activeChannelIdRef.current = activeId;
    } catch {}
  }, []);

  const saveHistory = (h: RatingEntry[]) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(h));
    historyRef.current = h;
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
            userRequest: userRequestRef.current.trim() || undefined,
            activeChannel: (() => {
              const id = activeChannelIdRef.current?.trim();
              if (!id) return undefined;
              let ch = channelsRef.current.find((c) => c.id === id);
              if (!ch) {
                try {
                  const raw = localStorage.getItem(CHANNELS_KEY);
                  if (raw) {
                    ch = (JSON.parse(raw) as Channel[])
                      .map(normalizeChannel)
                      .find((c) => c.id === id);
                  }
                } catch {
                  /* ignore */
                }
              }
              return ch;
            })(),
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

    const genAtStart = replenishGenRef.current;
    replenishInFlight.current++;
    lensIndexRef.current++; // advance lens so concurrent batches each explore a different area
    const seenThisBatch = new Set<string>();

    try {
      const skippedForApi = [
        ...skippedRef.current,
        ...passedRef.current,
        ...extraRetrySkips,
        ...prefetchRef.current.map((m) => m.title),
      ];

      const movies = await fetchMovieBatch({
        mediaType: opts.mediaType,
        llm: opts.llm,
        skipped: skippedForApi,
      });

      if (genAtStart !== replenishGenRef.current) return seenThisBatch;

      let freshCount = 0;

      if (movies) {
        // After await, re-check against latest refs — avoids a slower in-flight request
        // re-adding a title the user just rated while another replenish was in flight.
        const excluded = new Set<string>();
        for (const h of historyRef.current) excluded.add(canonicalTitleKey(h.title));
        for (const s of skippedRef.current) excluded.add(canonicalTitleKey(s));
        for (const p of passedRef.current) excluded.add(canonicalTitleKey(p));
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
      persistPrefetchQueue();
    } finally {
      replenishInFlight.current--;
      // Daisy-chain: keep filling until high-water mark, but stop if recent batches are all dupes.
      // zeroYieldStreak >= 3 means the LLM is stuck — no point hammering it further.
      if (
        genAtStart === replenishGenRef.current &&
        prefetchRef.current.length < HIGH_WATER_MARK &&
        replenishInFlight.current < MAX_REPLENISH_IN_FLIGHT &&
        zeroYieldStreakRef.current < 3
      ) {
        replenish(replenishOptsRef.current);
      }
    }

    return seenThisBatch;
  }, [fetchMovieBatch, persistPrefetchQueue]);

  // Pop instantly from prefetch queue; if empty, wait for replenish first
  const fetchNext = useCallback(async (
    opts: { mediaType: string; llm: string },
    isFirst = false
  ) => {
    setFetchError(null);
    if (!isFirst) {
      advanceFetchDepthRef.current += 1;
      setIsAdvancingCard(true);
    }
    try {
      // Drain the queue, skipping any title the user already decided on (guards against stale prefetch entries).
      while (prefetchRef.current.length > 0) {
        const [next, ...rest] = prefetchRef.current;
        prefetchRef.current = rest;
        const excluded = new Set<string>();
        for (const h of historyRef.current) excluded.add(canonicalTitleKey(h.title));
        for (const s of skippedRef.current) excluded.add(canonicalTitleKey(s));
        for (const p of passedRef.current) excluded.add(canonicalTitleKey(p));
        for (const w of watchlistRef.current) excluded.add(canonicalTitleKey(w.title));
        if (excluded.has(canonicalTitleKey(next.title))) continue; // already seen — discard silently
        persistPrefetchQueue();
        setCurrent(next);
        setInitialLoading(false);
        // Always keep MAX_REPLENISH_IN_FLIGHT batches running so the queue never drains while waiting.
        if (replenishInFlight.current < MAX_REPLENISH_IN_FLIGHT) replenish(opts);
        return;
      }
      persistPrefetchQueue();

      // Queue empty — wait for whatever is already in-flight, or start a fresh batch.
      try {
        zeroYieldStreakRef.current = 0; // reset so the daisy-chain can run
        if (replenishInFlight.current === 0) replenish(opts); // nothing running — kick one off
        const deadline = Date.now() + 90_000;
        while (prefetchRef.current.length === 0 && replenishInFlight.current > 0 && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 200));
        }
        const next = prefetchRef.current.shift();
        persistPrefetchQueue();
        if (!next) {
          setInitialLoading(false);
          setFetchError("Couldn't find a new title. Try again.");
          return;
        }
        setCurrent(next);
        setInitialLoading(false);
        setFetchError(null);
      } catch (e) {
        console.error("fetchNext failed:", e);
        setInitialLoading(false);
        setFetchError("Something went wrong. Try again.");
      }
    } finally {
      if (!isFirst) {
        advanceFetchDepthRef.current -= 1;
        if (advanceFetchDepthRef.current === 0) setIsAdvancingCard(false);
      }
    }
  }, [replenish, persistPrefetchQueue]);

  const clearAdvanceAfterRating = useCallback(() => {
    const t = advanceAfterRatingTimeoutRef.current;
    if (t != null) {
      clearTimeout(t);
      advanceAfterRatingTimeoutRef.current = null;
    }
  }, []);

  const scheduleAdvanceAfterRating = useCallback(() => {
    clearAdvanceAfterRating();
    advanceAfterRatingTimeoutRef.current = setTimeout(() => {
      advanceAfterRatingTimeoutRef.current = null;
      void fetchNext({ mediaType, llm });
    }, 500);
  }, [clearAdvanceAfterRating, fetchNext, mediaType, llm]);

  useEffect(() => () => clearAdvanceAfterRating(), [clearAdvanceAfterRating]);

  const removeFromPrefetchQueue = useCallback(
    (index: number) => {
      const q = prefetchRef.current;
      if (index < 0 || index >= q.length) return;
      prefetchRef.current = q.filter((_, i) => i !== index);
      persistPrefetchQueue();
      if (
        prefetchRef.current.length < HIGH_WATER_MARK &&
        replenishInFlight.current < MAX_REPLENISH_IN_FLIGHT &&
        zeroYieldStreakRef.current < 3
      ) {
        replenish({ mediaType, llm });
      }
    },
    [mediaType, llm, replenish, persistPrefetchQueue]
  );

  const playPrefetchAtIndex = useCallback(
    (index: number) => {
      const q = prefetchRef.current;
      if (index < 0 || index >= q.length) return;
      const movie = q[index];
      if (current && canonicalTitleKey(movie.title) === canonicalTitleKey(current.title)) return;
      clearAdvanceAfterRating();
      replenishGenRef.current += 1;
      prefetchRef.current = q.filter((_, i) => i !== index);
      persistPrefetchQueue();
      setCurrent(movie);
      setInitialLoading(false);
      setFetchError(null);
      zeroYieldStreakRef.current = 0;
      if (
        prefetchRef.current.length < HIGH_WATER_MARK &&
        replenishInFlight.current < MAX_REPLENISH_IN_FLIGHT &&
        zeroYieldStreakRef.current < 3
      ) {
        replenish({ mediaType, llm });
      }
    },
    [mediaType, llm, replenish, persistPrefetchQueue, current]
  );

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const hist: RatingEntry[] = stored ? (JSON.parse(stored) as RatingEntry[]).map(migrateRatingEntry) : [];
    const storedSkipped = localStorage.getItem(SKIPPED_KEY);
    const skip: string[] = storedSkipped ? JSON.parse(storedSkipped) : [];
    const storedWl = localStorage.getItem(WATCHLIST_KEY);
    const wl: WatchlistEntry[] = storedWl ? JSON.parse(storedWl) : [];
    const storedNi = localStorage.getItem(NOT_INTERESTED_KEY);
    const ni: { title: string; rtScore?: string | null }[] = storedNi ? JSON.parse(storedNi) : [];
    const storedNotSeen = localStorage.getItem(NOTSEEN_KEY);
    notSeenRef.current = storedNotSeen ? (JSON.parse(storedNotSeen) as NotSeenEvent[]) : [];
    historyRef.current = hist;
    skippedRef.current = skip;
    const storedPassed = localStorage.getItem(PASSED_KEY);
    const passedList: string[] = storedPassed ? JSON.parse(storedPassed) : [];
    passedRef.current = passedList;

    watchlistRef.current = wl;
    notInterestedRef.current = ni;

    let chs: Channel[] = [];
    try {
      const cRaw = localStorage.getItem(CHANNELS_KEY);
      if (cRaw) {
        chs = (JSON.parse(cRaw) as Channel[]).map(normalizeChannel);
        if (!chs.find((c) => c.id === "all")) {
          chs = [ALL_CHANNEL, ...chs];
        }
      }
    } catch {
      /* ignore */
    }
    const defaultCh = chs.length > 0 ? chs[0].id : "all";
    const storedActive = localStorage.getItem(ACTIVE_CHANNEL_KEY);
    const activeForPrefetch = storedActive || defaultCh;
    activeChannelIdRef.current = activeForPrefetch;
    if (chs.length > 0) {
      channelsRef.current = chs;
    }
    loadPrefetchIntoRefForChannel(activeForPrefetch);
    persistPrefetchQueue();

    // Check if the Ratings page asked us to reconsider a title
    const pendingReconsider = localStorage.getItem(RECONSIDER_KEY);
    if (pendingReconsider) {
      localStorage.removeItem(RECONSIDER_KEY);
      try {
        const m = JSON.parse(pendingReconsider);
        const movie: CurrentMovie = {
          title: m.title,
          type: m.type ?? "movie",
          year: m.year ?? null,
          director: m.director ?? null,
          predictedRating: migrateRatingValue(typeof m.predictedRating === "number" ? m.predictedRating : 3),
          actors: m.actors ?? [],
          plot: m.plot ?? "",
          posterUrl: m.posterUrl ?? null,
          trailerKey: m.trailerKey ?? null,
          rtScore: m.rtScore ?? null,
        };
        setCurrent(movie);
        setInitialLoading(false);
        replenish({ mediaType, llm });
        return;
      } catch {}
    }

    fetchNext({ mediaType, llm }, true);
    // Mount-only hydrate; mediaType / llm / replenish changes are handled by other effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchNext, loadPrefetchIntoRefForChannel, persistPrefetchQueue]);


  // On mobile, nudge the card into view when a new title loads — only if needed; avoid smooth scroll (feels like a jump on tap)
  const isFirstCard = useRef(true);
  useEffect(() => {
    if (!current?.title) return;
    if (isFirstCard.current) {
      isFirstCard.current = false;
      return;
    }
    if (window.innerWidth >= 640) return;
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vh = window.innerHeight;
    if (rect.top >= 0 && rect.bottom <= vh) return;
    el.scrollIntoView({ behavior: "auto", block: "nearest" });
  }, [current?.title]);

  // When mediaType changes, replace the current card if it doesn't match
  useEffect(() => {
    if (!current) return;
    if (mediaType !== "both" && current.type !== mediaType) {
      replenishGenRef.current += 1;
      prefetchRef.current = [];
      persistPrefetchQueue();
      batchYieldRef.current = [];
      fetchNext({ mediaType, llm });
    }
  }, [mediaType]); // eslint-disable-line react-hooks/exhaustive-deps

  // When userRequest changes (debounced 600ms), flush the prefetch queue so
  // upcoming cards reflect the new request rather than stale pre-fetched batches.
  // Do not run on initial mount — that would clear an imported queue ~600ms after load.
  useEffect(() => {
    const prev = prevUserRequestForFlushRef.current;
    if (prev === undefined) {
      prevUserRequestForFlushRef.current = userRequest;
      return;
    }
    if (prev === userRequest) return;
    prevUserRequestForFlushRef.current = userRequest;
    const t = setTimeout(() => {
      replenishGenRef.current += 1;
      prefetchRef.current = [];
      persistPrefetchQueue();
      batchYieldRef.current = [];
      zeroYieldStreakRef.current = 0;
    }, 600);
    return () => clearTimeout(t);
  }, [userRequest, persistPrefetchQueue]);

  // When active channel changes: save the previous channel's queue, load the new channel's queue.
  useEffect(() => {
    if (!activeChannelId) return;
    localStorage.setItem(ACTIVE_CHANNEL_KEY, activeChannelId);

    const prev = savedPrefetchChannelRef.current;
    if (prev !== null && prev !== activeChannelId) {
      replenishGenRef.current += 1;
      try {
        localStorage.setItem(prefetchQueueStorageKey(prev), JSON.stringify(prefetchRef.current));
      } catch {
        /* ignore */
      }
      loadPrefetchIntoRefForChannel(activeChannelId);
      persistPrefetchQueue();
      batchYieldRef.current = [];
      zeroYieldStreakRef.current = 0;
      savedPrefetchChannelRef.current = activeChannelId;
      // Show the first saved title for this channel (or wait / fetch if the queue is empty).
      const hasQueued = prefetchRef.current.length > 0;
      void fetchNext({ mediaType, llm }, hasQueued);
      return;
    }
    savedPrefetchChannelRef.current = activeChannelId;
  }, [activeChannelId, mediaType, llm, fetchNext, loadPrefetchIntoRefForChannel, persistPrefetchQueue]);

  const confirmDeleteChannelFromHome = useCallback(() => {
    const ch = channelPendingDelete;
    if (!ch || ch.id === "all") {
      setChannelPendingDelete(null);
      return;
    }
    const id = ch.id;
    const next = channels.filter((c) => c.id !== id);
    try {
      localStorage.removeItem(prefetchQueueStorageKey(id));
    } catch {
      /* ignore */
    }
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(next));
    setChannels(next);

    if (activeChannelId === id) {
      const fallback = next[0]?.id ?? "all";
      replenishGenRef.current += 1;
      savedPrefetchChannelRef.current = fallback;
      loadPrefetchIntoRefForChannel(fallback);
      persistPrefetchQueue();
      batchYieldRef.current = [];
      zeroYieldStreakRef.current = 0;
      localStorage.setItem(ACTIVE_CHANNEL_KEY, fallback);
      setActiveChannelId(fallback);
      activeChannelIdRef.current = fallback;
      void fetchNext({ mediaType, llm }, prefetchRef.current.length > 0);
    }
    setChannelPendingDelete(null);
  }, [
    channelPendingDelete,
    channels,
    activeChannelId,
    mediaType,
    llm,
    loadPrefetchIntoRefForChannel,
    persistPrefetchQueue,
    fetchNext,
  ]);

  const loadStarterChannelsFromFactory = useCallback(() => {
    mergeFactoryChannelsAndQueues();
    try {
      const raw = localStorage.getItem(CHANNELS_KEY);
      let next: Channel[] = raw ? (JSON.parse(raw) as Channel[]).map(normalizeChannel) : [];
      if (!next.some((c) => c.id === "all")) {
        next = [ALL_CHANNEL, ...next];
        localStorage.setItem(CHANNELS_KEY, JSON.stringify(next));
      }
      setChannels(next);
      const preferred = localStorage.getItem(ACTIVE_CHANNEL_KEY);
      const active =
        preferred && next.some((c) => c.id === preferred) ? preferred : (next[0]?.id ?? "all");
      activeChannelIdRef.current = active;
      setActiveChannelId(active);
      replenishGenRef.current += 1;
      savedPrefetchChannelRef.current = active;
      loadPrefetchIntoRefForChannel(active);
      persistPrefetchQueue();
      batchYieldRef.current = [];
      zeroYieldStreakRef.current = 0;
      void fetchNext({ mediaType, llm }, prefetchRef.current.length > 0);
    } catch {
      /* ignore */
    }
  }, [loadPrefetchIntoRefForChannel, persistPrefetchQueue, fetchNext, mediaType, llm]);

  const handleRate = (rating: number) => {
    rating = clampStarRating(rating);
    if (!current) return;
    const predicted = migrateRatingValue(current.predictedRating);
    const error = Math.abs(rating - predicted);
    const channelId = activeChannelIdRef.current || undefined;
    const entry: RatingEntry = {
      title: current.title,
      type: current.type,
      userRating: rating,
      predictedRating: predicted,
      error,
      rtScore: current.rtScore,
      channelId,
      posterUrl: current.posterUrl,
    };
    const newHistory = [...historyRef.current, entry];
    saveHistory(newHistory);
    zeroYieldStreakRef.current = 0; // new exclusion may unblock the LLM
    // Update taste profile after 1st rating, then every 5 (1, 5, 10, 15 …)
    const n = newHistory.length;
    if (n === 1 || n % 5 === 0) updateTasteSummary(newHistory, llm);
    replenish({ mediaType, llm });
    scheduleAdvanceAfterRating();
  };

  /** Single entry point for all star clicks. Red = seen (goes to history). Blue = unseen (4-5 → watchlist, 1-3 → not-interested). */
  const submitRating = (stars: number, mode: "seen" | "unseen") => {
    if (mode === "seen") {
      handleRate(stars);
    } else {
      recordNotSeen(stars >= 4 ? "want" : "skip", stars);
    }
  };

  /** Advance without a rating — title is excluded from future picks but not counted as not interested. */
  const passCurrentCard = () => {
    if (!current) return;
    clearAdvanceAfterRating();
    const t = current.title;
    const newPassed = [...passedRef.current, t];
    localStorage.setItem(PASSED_KEY, JSON.stringify(newPassed));
    passedRef.current = newPassed;
    zeroYieldStreakRef.current = 0;
    fetchNext({ mediaType, llm });
  };

  const recordNotSeen = (kind: "want" | "skip", interestStars: number) => {
    if (!current) return;
    const snapshot = current;
    const chId = activeChannelIdRef.current?.trim() || "all";
    const starsNorm = migrateRatingValue(interestStars);

    let newWatchlist = watchlistRef.current;
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
      newWatchlist = [entry, ...watchlistRef.current.filter((w) => w.title !== snapshot.title)];
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(newWatchlist));
      watchlistRef.current = newWatchlist;

      // Patch streaming in the background
      fetch("/api/streaming", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: snapshot.title, year: snapshot.year, llm }),
      }).then(r => r.ok ? r.json() : { services: [] })
        .then(({ services }: { services: string[] }) => {
          if (!services.length) return;
          const updated = watchlistRef.current.map((w) =>
            w.title === snapshot.title ? { ...w, streaming: services } : w);
          watchlistRef.current = updated;
          localStorage.setItem(WATCHLIST_KEY, JSON.stringify(updated));
        })
        .catch(() => {});
    }

    const nsEvent: NotSeenEvent = { afterRating: historyRef.current.length, kind };
    const newNotSeen = [...notSeenRef.current, nsEvent];
    notSeenRef.current = newNotSeen;
    localStorage.setItem(NOTSEEN_KEY, JSON.stringify(newNotSeen));

    const logRow: UnseenInterestEntry = {
      title: snapshot.title,
      type: snapshot.type,
      year: snapshot.year,
      director: snapshot.director,
      actors: snapshot.actors,
      plot: snapshot.plot,
      posterUrl: snapshot.posterUrl,
      rtScore: snapshot.rtScore,
      interestStars: starsNorm,
      kind,
      channelId: chId,
      at: new Date().toISOString(),
    };
    pushUnseenInterestEntry(logRow);

    const newSkipped = [...skippedRef.current, snapshot.title];
    localStorage.setItem(SKIPPED_KEY, JSON.stringify(newSkipped));
    skippedRef.current = newSkipped;

    // For "not interested" items, store with RT score so the server can surface high-RT dismissals
    // as a taste signal (user diverges from critical consensus).
    let newNotInterested = notInterestedRef.current;
    if (kind === "skip") {
      newNotInterested = [...notInterestedRef.current, { title: snapshot.title, rtScore: snapshot.rtScore }];
      localStorage.setItem(NOT_INTERESTED_KEY, JSON.stringify(newNotInterested));
      notInterestedRef.current = newNotInterested;
    }

    watchlistRef.current = newWatchlist;
    zeroYieldStreakRef.current = 0; // new exclusion may unblock the LLM
    replenish({ mediaType, llm });
    scheduleAdvanceAfterRating();
  };

  const submitRatingRef = useRef(submitRating);
  submitRatingRef.current = submitRating;
  const rateSeenStable = useCallback((n: number) => {
    submitRatingRef.current(n, "seen");
  }, []);
  const rateUnseenStable = useCallback((n: number) => {
    submitRatingRef.current(n, "unseen");
  }, []);

  const passCurrentCardRef = useRef(passCurrentCard);
  passCurrentCardRef.current = passCurrentCard;
  const passCurrentCardStable = useCallback(() => {
    passCurrentCardRef.current();
  }, []);

  const openPosterLightbox = useCallback((url: string) => {
    setLightboxUrl(url);
  }, []);

  const selectChannel = useCallback((id: string) => {
    setActiveChannelId(id);
  }, []);

  const requestDeleteChannel = useCallback((ch: Channel) => {
    setChannelPendingDelete(ch);
  }, []);

  return (
    <div className="flex min-h-screen w-full flex-col items-center bg-zinc-50 px-4 py-6 sm:py-10">
      <div className="w-full max-w-3xl space-y-4 sm:space-y-6">
        <HomeHero />

        <ChannelsToolbar
          channels={channels}
          activeChannelId={activeChannelId}
          onLoadStarter={loadStarterChannelsFromFactory}
          onSelectChannel={selectChannel}
          onRequestDeleteChannel={requestDeleteChannel}
        />

        {/* Movie card */}
        <div
          ref={cardRef}
          className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden scroll-mt-4 sm:scroll-mt-8 md:scroll-mt-14"
        >
          {initialLoading ? (
            <MovieCardSkeleton mode={displayMode} />
          ) : current ? (
            <div>
              {current.trailerKey && displayMode === "trailers" ? (
                /* ── TRAILER LAYOUT ── */
                <div className="flex flex-col gap-4 p-4 sm:p-6">
                  <TrailerPlayer videoId={current.trailerKey} />

                  <TrailerMetadata movie={current} />

                  <MovieRatingBlock
                    passCurrentCardStable={passCurrentCardStable}
                    rateSeenStable={rateSeenStable}
                    rateUnseenStable={rateUnseenStable}
                    movieTitle={current.title}
                    starKeyPrefix="tr"
                  />
                  <PrefetchQueuePanel
                    prefetchQueueUi={prefetchQueueUi}
                    channels={channels}
                    activeChannelId={activeChannelId}
                    onPlayAtIndex={playPrefetchAtIndex}
                    onRemoveAtIndex={removeFromPrefetchQueue}
                  />
                </div>
              ) : (
                /* ── POSTER LAYOUT (no trailer) ── */
                <div className="flex flex-col gap-4 p-4 sm:p-6">
                  <PosterMovieTop movie={current} onOpenPoster={openPosterLightbox} />

                  <MovieRatingBlock
                    passCurrentCardStable={passCurrentCardStable}
                    rateSeenStable={rateSeenStable}
                    rateUnseenStable={rateUnseenStable}
                    movieTitle={current.title}
                    starKeyPrefix="po"
                  />
                  <PrefetchQueuePanel
                    prefetchQueueUi={prefetchQueueUi}
                    channels={channels}
                    activeChannelId={activeChannelId}
                    onPlayAtIndex={playPrefetchAtIndex}
                    onRemoveAtIndex={removeFromPrefetchQueue}
                  />
                </div>
              )}
            </div>
          ) : null}
        </div>

        {/* Taste profile card */}
        {tasteSummary && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-4">
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-2">AI&apos;s model of your taste</p>
            <p className="text-sm text-zinc-700 leading-relaxed" style={{ borderLeft: "3px solid #a78bfa", paddingLeft: "12px" }}>
              {tasteSummary}
            </p>
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
      <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-zinc-900 text-white text-sm shadow-lg transition-all duration-300 ${isAdvancingCard ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}`}>
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

      <ConfirmDialog
        open={channelPendingDelete !== null}
        title="Delete channel"
        tone="danger"
        confirmLabel="Delete"
        cancelLabel="Cancel"
        onCancel={() => setChannelPendingDelete(null)}
        onConfirm={confirmDeleteChannelFromHome}
      >
        {channelPendingDelete ? (
          <>
            Delete <span className="font-medium text-zinc-800">&quot;{channelPendingDelete.name}&quot;</span>? This
            cannot be undone.
          </>
        ) : null}
      </ConfirmDialog>
    </div>
  );
}
