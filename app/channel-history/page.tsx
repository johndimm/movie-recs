"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import type { RatingEntry, WatchlistEntry } from "../page";
import { StaticStars } from "../components/Stars";
import { migrateRatingValue } from "../lib/ratingScale";
import { starDelta, formatStarDelta } from "../lib/ratingDelta";
import {
  canonicalTitleKey,
  entryMatchesChannel,
  loadUnseenInterestLog,
  type UnseenInterestEntry,
} from "../lib/unseenInterestLog";
import {
  Channel,
  normalizeChannel,
  ALL_CHANNEL,
  CHANNELS_KEY,
  ACTIVE_CHANNEL_KEY,
} from "../channels/page";

const STORAGE_KEY = "movie-recs-history";
const RECONSIDER_KEY = "movie-recs-reconsider";
const WATCHLIST_KEY = "movie-recs-watchlist";
const SKIPPED_KEY = "movie-recs-skipped";
const NOT_INTERESTED_KEY = "movie-recs-not-interested";
const SETTINGS_KEY = "movie-recs-settings";

function readLlm(): string {
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    if (!s) return "deepseek";
    const o = JSON.parse(s) as { llm?: string };
    return typeof o.llm === "string" && o.llm ? o.llm : "deepseek";
  } catch {
    return "deepseek";
  }
}

export default function ChannelHistoryPage() {
  const router = useRouter();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [history, setHistory] = useState<RatingEntry[]>([]);
  const [unseenLog, setUnseenLog] = useState<UnseenInterestEntry[]>([]);
  const [seenSort, setSeenSort] = useState<"user" | "delta">("user");
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [minPromoteStars, setMinPromoteStars] = useState(3.5);
  const [promoteMessage, setPromoteMessage] = useState<string | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        const raw = localStorage.getItem(CHANNELS_KEY);
        let chs: Channel[] = raw ? (JSON.parse(raw) as Channel[]).map(normalizeChannel) : [];
        if (!chs.find((c) => c.id === "all")) {
          chs = [ALL_CHANNEL, ...chs];
        }
        setChannels(chs);

        // Prefer URL param, then localStorage active channel
        const urlParam = new URLSearchParams(window.location.search).get("channel");
        const stored = localStorage.getItem(ACTIVE_CHANNEL_KEY);
        const id = (urlParam && chs.find((c) => c.id === urlParam)) ? urlParam
          : (stored && chs.find((c) => c.id === stored)) ? stored
          : chs[0]?.id ?? null;
        setSelectedId(id);

        const h = localStorage.getItem(STORAGE_KEY);
        if (h) setHistory(JSON.parse(h));
        setUnseenLog(loadUnseenInterestLog());
      } catch {}
    });
  }, []);

  const selected = channels.find((c) => c.id === selectedId) ?? null;

  const channelRatings = useMemo(() => {
    if (!selected) return [];
    if (selected.id === "all") {
      return history.filter((h) => !h.channelId || h.channelId === "all");
    }
    return history.filter((h) => h.channelId === selected.id);
  }, [history, selected]);

  const sortedChannelRatings = useMemo(() => {
    const copy = [...channelRatings];
    if (seenSort === "user") {
      copy.sort((a, b) => migrateRatingValue(b.userRating) - migrateRatingValue(a.userRating));
    } else {
      copy.sort((a, b) => starDelta(b.userRating, b.predictedRating) - starDelta(a.userRating, a.predictedRating));
    }
    return copy;
  }, [channelRatings, seenSort]);

  const historyIndicesForSorted = useMemo(() => {
    const usedSet = new Set<number>();
    return sortedChannelRatings.map((entry) => {
      const idx = history.findIndex(
        (h, i) =>
          !usedSet.has(i) &&
          h.title === entry.title &&
          h.userRating === entry.userRating &&
          h.predictedRating === entry.predictedRating &&
          (h.channelId ?? null) === (entry.channelId ?? null)
      );
      if (idx >= 0) usedSet.add(idx);
      return idx;
    });
  }, [sortedChannelRatings, history]);

  const deleteHistoryEntries = useCallback((rowIndices: number[]) => {
    const toRemove = new Set(rowIndices.map((r) => historyIndicesForSorted[r]).filter((i) => i >= 0));
    const next = history.filter((_, i) => !toRemove.has(i));
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    setHistory(next);
    setSelectedRows((prev) => {
      const updated = new Set(prev);
      rowIndices.forEach((r) => updated.delete(r));
      return updated;
    });
  }, [history, historyIndicesForSorted]);

  const channelUnseen = useMemo(() => {
    if (!selected) return [];
    return unseenLog
      .filter((e) => entryMatchesChannel(e, selected.id))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [selected, unseenLog]);

  const watchlistKeys = useMemo(() => {
    try {
      const wlRaw = localStorage.getItem(WATCHLIST_KEY);
      const wl: { title: string }[] = wlRaw ? JSON.parse(wlRaw) : [];
      return new Set(wl.map((w) => canonicalTitleKey(w.title)));
    } catch {
      return new Set<string>();
    }
  }, [unseenLog]);

  const promoteMatchCount = useMemo(() => {
    if (!selected) return 0;
    try {
      const wlRaw = localStorage.getItem(WATCHLIST_KEY);
      const wl: { title: string }[] = wlRaw ? JSON.parse(wlRaw) : [];
      const keys = new Set(wl.map((w) => canonicalTitleKey(w.title)));
      return unseenLog.filter((e) => {
        if (!entryMatchesChannel(e, selected.id)) return false;
        if (keys.has(canonicalTitleKey(e.title))) return false;
        if (e.interestStars < minPromoteStars) return false;
        if (e.kind === "skip") return true;
        return e.kind === "want";
      }).length;
    } catch {
      return 0;
    }
  }, [selected, unseenLog, minPromoteStars]);

  const addHighInterestSkipsToWatchlist = useCallback(() => {
    if (!selected) return;
    try {
      const wlRaw = localStorage.getItem(WATCHLIST_KEY);
      let wl: WatchlistEntry[] = wlRaw ? JSON.parse(wlRaw) : [];
      const wlKeys = new Set(wl.map((w) => canonicalTitleKey(w.title)));
      const candidates = unseenLog.filter((e) => {
        if (!entryMatchesChannel(e, selected.id)) return false;
        if (wlKeys.has(canonicalTitleKey(e.title))) return false;
        if (e.interestStars < minPromoteStars) return false;
        if (e.kind === "skip") return true;
        return e.kind === "want";
      });
      if (candidates.length === 0) {
        setPromoteMessage("No matching titles to add (already on watchlist or below threshold).");
        setTimeout(() => setPromoteMessage(null), 5000);
        return;
      }
      const llm = readLlm();
      const now = new Date().toISOString();
      for (const e of candidates) {
        const entry: WatchlistEntry = {
          title: e.title,
          type: e.type,
          year: e.year,
          director: e.director,
          actors: e.actors,
          plot: e.plot,
          posterUrl: e.posterUrl,
          rtScore: e.rtScore,
          streaming: [],
          addedAt: now,
        };
        wl = [entry, ...wl.filter((w) => w.title !== e.title)];
        wlKeys.add(canonicalTitleKey(e.title));
      }
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(wl));

      const skipOnly = candidates.filter((c) => c.kind === "skip");
      if (skipOnly.length > 0) {
        const skRaw = localStorage.getItem(SKIPPED_KEY);
        let skippedList: string[] = skRaw ? JSON.parse(skRaw) : [];
        const removeKeys = new Set(skipOnly.map((c) => canonicalTitleKey(c.title)));
        skippedList = skippedList.filter((t) => !removeKeys.has(canonicalTitleKey(t)));
        localStorage.setItem(SKIPPED_KEY, JSON.stringify(skippedList));

        const niRaw = localStorage.getItem(NOT_INTERESTED_KEY);
        let ni: { title: string; rtScore?: string | null }[] = niRaw ? JSON.parse(niRaw) : [];
        ni = ni.filter((x) => !removeKeys.has(canonicalTitleKey(x.title)));
        localStorage.setItem(NOT_INTERESTED_KEY, JSON.stringify(ni));
      }

      setPromoteMessage(
        `Added ${candidates.length} title${candidates.length === 1 ? "" : "s"} to your watchlist (min ${minPromoteStars}★).`,
      );
      setTimeout(() => setPromoteMessage(null), 8000);
      setUnseenLog(loadUnseenInterestLog());

      for (const e of candidates) {
        void fetch("/api/streaming", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ title: e.title, year: e.year, llm }),
        })
          .then((r) => (r.ok ? r.json() : { services: [] }))
          .then(({ services }: { services: string[] }) => {
            if (!services.length) return;
            const raw2 = localStorage.getItem(WATCHLIST_KEY);
            let w2: WatchlistEntry[] = raw2 ? JSON.parse(raw2) : [];
            w2 = w2.map((w) => (w.title === e.title ? { ...w, streaming: services } : w));
            localStorage.setItem(WATCHLIST_KEY, JSON.stringify(w2));
          })
          .catch(() => {});
      }
    } catch {
      setPromoteMessage("Could not update watchlist.");
      setTimeout(() => setPromoteMessage(null), 5000);
    }
  }, [selected, unseenLog, minPromoteStars]);

  return (
    <div className="min-h-screen bg-zinc-50">
      <div className="max-w-3xl mx-auto px-4 py-6 space-y-5">

        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <Link href="/" className="text-sm text-zinc-500 hover:text-zinc-800 transition-colors">← Player</Link>
            <h1 className="text-lg font-bold text-zinc-800">Channel History</h1>
            {channels.length > 1 && (
              <select
                value={selectedId ?? ""}
                onChange={(e) => setSelectedId(e.target.value)}
                className="rounded-lg border border-zinc-200 bg-white px-2.5 py-1.5 text-sm font-medium text-zinc-800 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-300"
              >
                {channels.map((ch) => (
                  <option key={ch.id} value={ch.id}>{ch.name}</option>
                ))}
              </select>
            )}
          </div>
          {selected && selected.id !== "all" && (
            <Link
              href={`/channels?select=${selected.id}`}
              className="text-sm font-medium text-indigo-600 hover:text-indigo-800 transition-colors"
            >
              Edit channel →
            </Link>
          )}
        </div>

        {/* History section */}
        {selected ? (
          <div className="space-y-4">
            <div className="flex flex-wrap items-end justify-between gap-3">
              <p className="text-sm text-zinc-500">
                <span className="font-semibold text-zinc-700">{selected.name}</span>
                {" · "}{channelRatings.length} seen · {channelUnseen.length} unseen
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-xs text-zinc-500 whitespace-nowrap">Min interest for watchlist</label>
                <select
                  value={String(minPromoteStars)}
                  onChange={(e) => setMinPromoteStars(Number(e.target.value))}
                  className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-800"
                >
                  {[2.5, 3, 3.5, 4, 4.5].map((n) => (
                    <option key={n} value={String(n)}>{n}★</option>
                  ))}
                </select>
                <button
                  type="button"
                  onClick={addHighInterestSkipsToWatchlist}
                  disabled={promoteMatchCount === 0}
                  className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                  title="Adds high-interest titles not already on your watchlist."
                >
                  Add to watchlist ({promoteMatchCount})
                </button>
              </div>
            </div>

            {promoteMessage && (
              <p className="text-xs font-medium text-green-700" role="status">{promoteMessage}</p>
            )}

            {channelRatings.length === 0 && channelUnseen.length === 0 ? (
              <p className="text-sm text-zinc-400">No activity in this channel yet.</p>
            ) : (
              <>
                {channelRatings.length > 0 && (
                  <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
                    <div className="px-3 py-2 border-b border-zinc-100 bg-zinc-50/80">
                      <div className="flex flex-wrap items-center justify-between gap-2 mb-2">
                        <div className="flex items-center gap-2">
                          <input
                            type="checkbox"
                            aria-label="Select all"
                            checked={selectedRows.size === sortedChannelRatings.length && sortedChannelRatings.length > 0}
                            onChange={(ev) => {
                              if (ev.target.checked) {
                                setSelectedRows(new Set(sortedChannelRatings.map((_, i) => i)));
                              } else {
                                setSelectedRows(new Set());
                              }
                            }}
                            className="accent-indigo-600"
                          />
                          <p className="text-xs font-semibold text-zinc-600">Seen</p>
                        </div>
                        {selectedRows.size > 0 && (
                          <button
                            type="button"
                            onClick={() => deleteHistoryEntries([...selectedRows])}
                            className="text-xs font-semibold text-rose-600 hover:text-rose-800 transition-colors"
                          >
                            Delete selected ({selectedRows.size})
                          </button>
                        )}
                      </div>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-xs font-medium text-zinc-500">Sort by</span>
                        <div className="flex rounded-lg border border-zinc-200 bg-white p-0.5 text-xs font-medium">
                          <button
                            type="button"
                            onClick={() => setSeenSort("user")}
                            className={`rounded-md px-2.5 py-1 transition-colors ${seenSort === "user" ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-50"}`}
                          >
                            Your stars
                          </button>
                          <button
                            type="button"
                            onClick={() => setSeenSort("delta")}
                            className={`rounded-md px-2.5 py-1 transition-colors ${seenSort === "delta" ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-50"}`}
                          >
                            vs audience
                          </button>
                        </div>
                      </div>
                    </div>
                    <div className="divide-y divide-zinc-50">
                      {sortedChannelRatings.map((e, i) => {
                        const d = starDelta(e.userRating, e.predictedRating);
                        return (
                          <div
                            key={`${e.title}-${e.userRating}-${e.predictedRating}-${i}`}
                            className={`flex items-center gap-3 py-2 px-3 transition-colors ${selectedRows.has(i) ? "bg-indigo-50" : "hover:bg-zinc-50"}`}
                          >
                            <input
                              type="checkbox"
                              checked={selectedRows.has(i)}
                              onChange={(ev) => {
                                setSelectedRows((prev) => {
                                  const next = new Set(prev);
                                  ev.target.checked ? next.add(i) : next.delete(i);
                                  return next;
                                });
                              }}
                              className="accent-indigo-600 shrink-0"
                            />
                            {e.posterUrl ? (
                              // eslint-disable-next-line @next/next/no-img-element
                              <img
                                src={e.posterUrl}
                                alt={e.title}
                                referrerPolicy="no-referrer"
                                className="w-8 h-12 rounded object-cover flex-shrink-0"
                              />
                            ) : (
                              <div className="w-8 h-12 rounded bg-zinc-100 flex-shrink-0" />
                            )}
                            <div className="flex-1 min-w-0">
                              <button
                                type="button"
                                onClick={() => {
                                  localStorage.setItem(RECONSIDER_KEY, JSON.stringify({
                                    title: e.title, type: e.type, year: null, director: null,
                                    predictedRating: e.predictedRating, actors: [], plot: "",
                                    posterUrl: e.posterUrl ?? null, trailerKey: null, rtScore: e.rtScore ?? null,
                                  }));
                                  router.push("/");
                                }}
                                className="font-medium text-zinc-800 text-sm hover:text-indigo-600 transition-colors text-left"
                              >
                                {e.title}
                              </button>
                              <span className="ml-2 text-xs text-zinc-400">{e.type === "tv" ? "TV" : "Film"}</span>
                            </div>
                            <div className="flex items-center justify-end gap-2 shrink-0">
                              <span
                                className={`w-12 shrink-0 text-right tabular-nums text-sm font-semibold ${d > 0 ? "text-emerald-700" : d < 0 ? "text-rose-700" : "text-zinc-500"}`}
                                title="Your rating minus audience rating (stars)"
                              >
                                {formatStarDelta(d)}
                              </span>
                              <div className="w-20 shrink-0 flex justify-end">
                                <StaticStars rating={migrateRatingValue(e.userRating)} color="red" />
                              </div>
                              <button
                                type="button"
                                onClick={() => deleteHistoryEntries([i])}
                                className="ml-1 text-zinc-300 hover:text-rose-500 transition-colors text-base leading-none shrink-0"
                                title="Delete this entry"
                                aria-label="Delete"
                              >
                                ×
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {channelUnseen.length > 0 && (
                  <div className={`rounded-xl border border-zinc-200 bg-white overflow-hidden ${channelRatings.length > 0 ? "mt-5" : ""}`}>
                    <div className="px-3 py-2 border-b border-zinc-100 bg-zinc-50/80">
                      <p className="text-xs font-semibold text-zinc-600">Unseen (blue stars)</p>
                      <p className="text-xs text-zinc-400 mt-0.5">
                        Blue stars when you passed or saved. &ldquo;Added&rdquo; means you chose save when you rated. The button count is only titles <strong className="font-medium text-zinc-500">not</strong> on your watchlist yet, above the min stars.
                      </p>
                    </div>
                    <div className="divide-y divide-zinc-50">
                      {channelUnseen.map((e) => (
                        <div
                          key={`${e.title}-${e.at}-${e.kind}`}
                          className="flex items-center gap-3 py-2 px-3 hover:bg-zinc-50 transition-colors"
                        >
                          {e.posterUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={e.posterUrl}
                              alt={e.title}
                              referrerPolicy="no-referrer"
                              className="w-8 h-12 rounded object-cover flex-shrink-0"
                            />
                          ) : (
                            <div className="w-8 h-12 rounded bg-zinc-100 flex-shrink-0" />
                          )}
                          <div className="flex-1 min-w-0">
                            <span className="font-medium text-zinc-800 text-sm">{e.title}</span>
                            <span className="ml-2 text-xs text-zinc-400">{e.type === "tv" ? "TV" : "Film"}</span>
                            <span
                              className={`ml-2 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                                e.kind === "want"
                                  ? "bg-emerald-100 text-emerald-800"
                                  : "bg-zinc-100 text-zinc-600"
                              }`}
                            >
                              {e.kind === "want"
                                ? watchlistKeys.has(canonicalTitleKey(e.title)) ? "Added" : "Not on list"
                                : "Not interested"}
                            </span>
                          </div>
                          <div className="flex items-center justify-end gap-2 shrink-0">
                            <span className="w-12 shrink-0 text-right tabular-nums text-sm font-semibold invisible select-none" aria-hidden>0</span>
                            <div className="w-20 shrink-0 flex justify-end">
                              <StaticStars rating={migrateRatingValue(e.interestStars)} color="blue" />
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        ) : (
          <p className="text-sm text-zinc-400">No channel selected.</p>
        )}
      </div>
    </div>
  );
}
