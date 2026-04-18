"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { WatchlistEntry } from "../page";
import { StaticStars } from "../components/Stars";
import RTBadge from "../components/RTBadge";
import { migrateRatingValue } from "../lib/ratingScale";
import { starDelta, formatStarDelta } from "../lib/ratingDelta";

const STORAGE_KEY = "movie-recs-history";
const SKIPPED_KEY = "movie-recs-skipped";
const WATCHLIST_KEY = "movie-recs-watchlist";
const NOT_INTERESTED_KEY = "movie-recs-not-interested";
const RECONSIDER_KEY = "movie-recs-reconsider";

interface RatingEntry {
  title: string;
  type: "movie" | "tv";
  userRating: number;
  predictedRating: number;
  error: number;
  rtScore?: string | null;
}

function canonicalTitleKey(title: string): string {
  const s = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  if (s === "se7en" || s === "seven") return "seven";
  return s;
}

type Tab = "seen" | "watchlist" | "not-interested";
type SeenSort = "user" | "delta";

export default function RatingsPage() {
  const router = useRouter();
  const [history, setHistory] = useState<RatingEntry[]>([]);
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);
  const [skipped, setSkipped] = useState<string[]>([]);
  const [notInterested, setNotInterested] = useState<{ title: string; rtScore?: string | null }[]>([]);
  const [tab, setTab] = useState<Tab>("seen");
  const [seenSort, setSeenSort] = useState<SeenSort>("user");

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const h = localStorage.getItem(STORAGE_KEY);
        if (h) {
          const parsed = JSON.parse(h) as RatingEntry[];
          setHistory(
            parsed.map((e) => {
              const u = migrateRatingValue(e.userRating);
              const p = migrateRatingValue(e.predictedRating);
              return { ...e, userRating: u, predictedRating: p, error: Math.abs(u - p) };
            })
          );
        }
        const wl = localStorage.getItem(WATCHLIST_KEY);
        if (wl) setWatchlist(JSON.parse(wl));
        const sk = localStorage.getItem(SKIPPED_KEY);
        if (sk) setSkipped(JSON.parse(sk));
        const ni = localStorage.getItem(NOT_INTERESTED_KEY);
        if (ni) setNotInterested(JSON.parse(ni));
      } catch {}
    });
  }, []);

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
      out.push({ title: s, rtScore: rtByKey.has(k) ? rtByKey.get(k) : null });
    }
    return out;
  }, [skipped, watchlist, notInterested]);

  const reconsiderHistory = (entry: RatingEntry) => {
    const newHistory = history.filter((h) => h.title !== entry.title);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newHistory));
    const movie = {
      title: entry.title, type: entry.type, year: null, director: null,
      predictedRating: entry.predictedRating, actors: [], plot: "",
      posterUrl: null, trailerKey: null, rtScore: entry.rtScore ?? null,
    };
    localStorage.setItem(RECONSIDER_KEY, JSON.stringify(movie));
    router.push("/");
  };

  const reconsiderWatchlist = (entry: WatchlistEntry) => {
    const newWatchlist = watchlist.filter((w) => w.title !== entry.title);
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(newWatchlist));
    const movie = {
      title: entry.title, type: entry.type, year: entry.year, director: entry.director,
      predictedRating: 3, actors: entry.actors, plot: entry.plot,
      posterUrl: entry.posterUrl, trailerKey: null, rtScore: entry.rtScore ?? null,
    };
    localStorage.setItem(RECONSIDER_KEY, JSON.stringify(movie));
    router.push("/");
  };

  const deleteFromWatchlist = (entry: WatchlistEntry) => {
    const newWatchlist = watchlist.filter((w) => w.title !== entry.title);
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(newWatchlist));
    setWatchlist(newWatchlist);
  };

  const reconsiderNotInterested = (item: { title: string; rtScore?: string | null }) => {
    const newSkipped = skipped.filter((s) => s !== item.title);
    localStorage.setItem(SKIPPED_KEY, JSON.stringify(newSkipped));
    const newNotInterested = notInterested.filter((n) => n.title !== item.title);
    localStorage.setItem(NOT_INTERESTED_KEY, JSON.stringify(newNotInterested));
    const movie = {
      title: item.title, type: "movie", year: null, director: null,
      predictedRating: 50, actors: [], plot: "",
      posterUrl: null, trailerKey: null, rtScore: item.rtScore ?? null,
    };
    localStorage.setItem(RECONSIDER_KEY, JSON.stringify(movie));
    router.push("/");
  };

  const hasAny = history.length > 0 || watchlist.length > 0 || dontSeeRows.length > 0;

  const sortedSeen = useMemo(() => {
    const copy = [...history];
    if (seenSort === "user") {
      copy.sort((a, b) => migrateRatingValue(b.userRating) - migrateRatingValue(a.userRating));
    } else {
      copy.sort((a, b) => starDelta(b.userRating, b.predictedRating) - starDelta(a.userRating, a.predictedRating));
    }
    return copy;
  }, [history, seenSort]);

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-6 sm:py-10 px-4">
      <div className="w-full max-w-3xl space-y-6">

        <h1 className="text-xl font-bold text-zinc-900">Ratings</h1>

        {!hasAny && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-8 text-center text-zinc-400 text-sm">
            No ratings yet. Rate some movies on the main page.
          </div>
        )}

        {/* Tab bar */}
        {hasAny && (
          <div className="flex rounded-xl border border-zinc-200 bg-white overflow-hidden text-sm shadow-sm w-fit">
            {(["seen", "watchlist", "not-interested"] as Tab[]).map((t) => {
              const count = t === "seen" ? history.length : t === "watchlist" ? watchlist.length : dontSeeRows.length;
              return (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-2 font-medium transition-colors flex items-center gap-1.5 ${
                    tab === t ? "bg-zinc-900 text-white" : "text-zinc-500 hover:bg-zinc-50"
                  }`}
                >
                  {t === "seen" ? "Seen" : t === "watchlist" ? "Watchlist" : "Not Interested"}
                  {count > 0 && (
                    <span className={`text-xs font-bold px-1.5 py-0.5 rounded-full ${tab === t ? "bg-white/20 text-white" : "bg-zinc-100 text-zinc-500"}`}>
                      {count}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* Seen tab — rated history */}
        {tab === "seen" && history.length > 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5 border-b border-zinc-100 bg-zinc-50/80">
              <span className="text-xs font-medium text-zinc-500">Sort by</span>
              <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 text-xs font-medium">
                <button
                  type="button"
                  onClick={() => setSeenSort("user")}
                  className={`rounded-md px-2.5 py-1 transition-colors ${
                    seenSort === "user" ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-50"
                  }`}
                >
                  Your stars
                </button>
                <button
                  type="button"
                  onClick={() => setSeenSort("delta")}
                  className={`rounded-md px-2.5 py-1 transition-colors ${
                    seenSort === "delta" ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-50"
                  }`}
                >
                  vs predicted
                </button>
              </div>
            </div>
            <ul className="divide-y divide-zinc-50">
              {sortedSeen.map((e) => {
                const d = starDelta(e.userRating, e.predictedRating);
                const deltaStr = formatStarDelta(d);
                return (
                  <li
                    key={e.title}
                    onClick={() => reconsiderHistory(e)}
                    className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm min-w-0 cursor-pointer hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
                    title="Click to re-rate"
                  >
                    <div className="min-w-0 flex items-baseline gap-1.5">
                      <span className="font-medium text-zinc-800 truncate">{e.title}</span>
                      <span className="text-xs text-zinc-400 flex-shrink-0">{e.type === "tv" ? "TV" : "Film"}</span>
                    </div>
                    <div className="flex items-center justify-end gap-2 flex-shrink-0">
                      <span
                        className={`w-12 shrink-0 text-right tabular-nums text-sm font-semibold ${
                          d > 0 ? "text-emerald-700" : d < 0 ? "text-rose-700" : "text-zinc-500"
                        }`}
                        title="Your rating minus predicted (stars)"
                      >
                        {deltaStr}
                      </span>
                      <div className="w-20 shrink-0 flex justify-end">
                        <StaticStars rating={migrateRatingValue(e.userRating)} color="red" />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {tab === "seen" && history.length === 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6 text-center text-zinc-400 text-sm">
            No seen ratings yet.
          </div>
        )}

        {/* Watchlist tab */}
        {tab === "watchlist" && watchlist.length > 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm">
            <ul className="divide-y divide-zinc-50">
              {watchlist.map((w, i) => (
                <li
                  key={`${w.title}-${i}`}
                  onClick={() => reconsiderWatchlist(w)}
                  className="px-4 py-3 flex items-start gap-3 text-sm min-w-0 cursor-pointer hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
                  title="Click to rate after watching"
                >
                  {w.posterUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={w.posterUrl}
                      alt={w.title}
                      referrerPolicy="no-referrer"
                      className="w-10 h-14 rounded object-cover flex-shrink-0"
                    />
                  )}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium text-zinc-800 truncate">{w.title}</span>
                      {w.rtScore && <RTBadge score={w.rtScore} />}
                    </div>
                    <div className="flex items-center gap-2 flex-wrap mt-0.5 text-xs text-zinc-400">
                      <span>{w.type === "tv" ? "TV Series" : "Movie"}{w.year ? ` · ${w.year}` : ""}</span>
                      {w.director && <span>· {w.director}</span>}
                    </div>
                    {w.streaming.length > 0 && (
                      <div className="flex flex-wrap gap-1 mt-1">
                        {w.streaming.map((s) => (
                          <span key={s} className="text-xs bg-zinc-100 text-zinc-600 px-2 py-0.5 rounded-full">{s}</span>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); deleteFromWatchlist(w); }}
                    className="text-zinc-300 hover:text-red-400 transition-colors flex-shrink-0 text-lg leading-none self-start mt-0.5"
                    title="Remove from watchlist"
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === "watchlist" && watchlist.length === 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6 text-center text-zinc-400 text-sm">
            Nothing on your watchlist yet. Rate movies you haven&apos;t seen with 4–5 blue stars.
          </div>
        )}

        {/* Not Interested tab */}
        {tab === "not-interested" && dontSeeRows.length > 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm">
            <ul className="divide-y divide-zinc-50">
              {dontSeeRows.map((e, i) => (
                <li
                  key={`${e.title}-${i}`}
                  onClick={() => reconsiderNotInterested(e)}
                  className="px-4 py-2.5 flex items-center justify-between gap-3 text-sm min-w-0 cursor-pointer hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
                  title="Click to reconsider"
                >
                  <span className="font-medium text-zinc-800 truncate">{e.title}</span>
                  {e.rtScore != null && e.rtScore !== "" ? (
                    <span className="flex-shrink-0">
                      <RTBadge score={e.rtScore} />
                    </span>
                  ) : (
                    <span className="text-xs text-zinc-400 flex-shrink-0">—</span>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}

        {tab === "not-interested" && dontSeeRows.length === 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-6 text-center text-zinc-400 text-sm">
            No not-interested titles yet.
          </div>
        )}

      </div>
    </div>
  );
}
