"use client";

import { useState, useEffect, useMemo } from "react";
import { useRouter } from "next/navigation";
import type { RatingEntry } from "../page";
import { StaticStars } from "../components/Stars";
import { migrateRatingValue } from "../lib/ratingScale";
import { starDelta, formatStarDelta } from "../lib/ratingDelta";
import { Channel, normalizeChannel, CHANNELS_KEY } from "../channels/page";

const STORAGE_KEY = "movie-recs-history";
const RECONSIDER_KEY = "movie-recs-reconsider";

type SortField = "order" | "rating" | "title" | "channel";
type SortDir = "asc" | "desc";

export default function HistoryPage() {
  const router = useRouter();
  const [history, setHistory] = useState<RatingEntry[]>([]);
  const [channels, setChannels] = useState<Channel[]>([]);
  const [sortField, setSortField] = useState<SortField>("order");
  const [sortDir, setSortDir] = useState<SortDir>("desc");

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
        const ch = localStorage.getItem(CHANNELS_KEY);
        if (ch) setChannels((JSON.parse(ch) as Channel[]).map(normalizeChannel));
      } catch {}
    });
  }, []);

  const channelMap = useMemo(() => {
    const m = new Map<string, string>();
    for (const ch of channels) m.set(ch.id, ch.name);
    return m;
  }, [channels]);

  const sorted = useMemo(() => {
    const copy = history.map((e, i) => ({ ...e, _index: i }));
    copy.sort((a, b) => {
      let cmp = 0;
      if (sortField === "order") {
        cmp = a._index - b._index;
      } else if (sortField === "rating") {
        cmp = a.userRating - b.userRating;
      } else if (sortField === "title") {
        cmp = a.title.localeCompare(b.title);
      } else {
        const ca = channelMap.get(a.channelId ?? "") ?? "";
        const cb = channelMap.get(b.channelId ?? "") ?? "";
        cmp = ca.localeCompare(cb);
      }
      return sortDir === "asc" ? cmp : -cmp;
    });
    return copy;
  }, [history, sortField, sortDir, channelMap]);

  const toggleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDir(field === "order" || field === "rating" ? "desc" : "asc");
    }
  };

  const reconsider = (e: RatingEntry) => {
    const newHistory = history.filter((h) => h.title !== e.title);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(newHistory));
    localStorage.setItem(
      RECONSIDER_KEY,
      JSON.stringify({
        title: e.title, type: e.type, year: null, director: null,
        predictedRating: e.predictedRating, actors: [], plot: "",
        posterUrl: e.posterUrl ?? null, trailerKey: null, rtScore: e.rtScore ?? null,
      })
    );
    router.push("/");
  };

  const SortBtn = ({ field, label }: { field: SortField; label: string }) => {
    const active = sortField === field;
    return (
      <button
        type="button"
        onClick={() => toggleSort(field)}
        className={`flex items-center gap-1 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
          active
            ? "bg-zinc-900 text-white"
            : "text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
        }`}
      >
        {label}
        {active && (
          <span className="text-xs opacity-80">{sortDir === "asc" ? "↑" : "↓"}</span>
        )}
      </button>
    );
  };

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-6 sm:py-10 px-4">
      <div className="w-full max-w-3xl space-y-4">

        <div className="flex items-baseline justify-between">
          <h1 className="text-xl font-bold text-zinc-900">History</h1>
          {history.length > 0 && (
            <span className="text-sm text-zinc-400">{history.length} title{history.length === 1 ? "" : "s"}</span>
          )}
        </div>

        {history.length === 0 ? (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-8 text-center text-zinc-400 text-sm">
            No ratings yet. Rate some movies on the Player page.
          </div>
        ) : (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
            {/* Sort toolbar */}
            <div className="flex flex-wrap items-center gap-1.5 px-4 py-3 border-b border-zinc-100 bg-zinc-50/80">
              <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mr-1">Sort</span>
              <SortBtn field="order" label="Order" />
              <SortBtn field="rating" label="Rating" />
              <SortBtn field="title" label="Title" />
              <SortBtn field="channel" label="Channel" />
            </div>

            <ul className="divide-y divide-zinc-50">
              {sorted.map((e, i) => {
                const d = starDelta(e.userRating, e.predictedRating);
                const chName = e.channelId ? channelMap.get(e.channelId) : undefined;
                return (
                  <li
                    key={`${e.title}-${i}`}
                    onClick={() => reconsider(e)}
                    className="px-4 py-2.5 flex items-center gap-3 text-sm min-w-0 cursor-pointer hover:bg-zinc-50 active:bg-zinc-100 transition-colors"
                    title="Click to re-rate"
                  >
                    {e.posterUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={e.posterUrl}
                        alt={e.title}
                        referrerPolicy="no-referrer"
                        className="w-7 h-10 rounded object-cover flex-shrink-0"
                      />
                    ) : (
                      <div className="w-7 h-10 rounded bg-zinc-100 flex-shrink-0" />
                    )}
                    <div className="flex-1 min-w-0">
                      <span className="font-medium text-zinc-800 truncate block">{e.title}</span>
                      <div className="flex items-center gap-2 text-xs text-zinc-400 flex-wrap">
                        <span>{e.type === "tv" ? "TV" : "Film"}</span>
                        {chName && <span className="text-zinc-500">· {chName}</span>}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span
                        className={`w-12 text-right tabular-nums text-sm font-semibold ${
                          d > 0 ? "text-emerald-700" : d < 0 ? "text-rose-700" : "text-zinc-500"
                        }`}
                        title="Your rating minus predicted"
                      >
                        {formatStarDelta(d)}
                      </span>
                      <div className="w-20 flex justify-end">
                        <StaticStars rating={e.userRating} color="red" />
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
