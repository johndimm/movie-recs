"use client";

import { useState, useEffect } from "react";
import type { WatchlistEntry } from "../page";
import RTBadge from "../components/RTBadge";

const WATCHLIST_KEY = "movie-recs-watchlist";
const SKIPPED_KEY = "movie-recs-skipped";
const NOT_INTERESTED_KEY = "movie-recs-not-interested";

export default function WatchlistPage() {
  const [watchlist, setWatchlist] = useState<WatchlistEntry[]>([]);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(WATCHLIST_KEY);
      if (stored) setWatchlist(JSON.parse(stored));
    } catch {}
  }, []);

  const moveToNotInterested = (entry: WatchlistEntry) => {
    // Remove from watchlist
    const updated = watchlist.filter((e) => e.title !== entry.title);
    localStorage.setItem(WATCHLIST_KEY, JSON.stringify(updated));
    setWatchlist(updated);

    // Add to not-interested
    try {
      const stored = localStorage.getItem(NOT_INTERESTED_KEY);
      const ni: { title: string; rtScore?: string | null }[] = stored ? JSON.parse(stored) : [];
      if (!ni.some((n) => n.title === entry.title)) {
        ni.push({ title: entry.title, rtScore: entry.rtScore });
        localStorage.setItem(NOT_INTERESTED_KEY, JSON.stringify(ni));
      }
    } catch {}

    // Add to skipped
    try {
      const stored = localStorage.getItem(SKIPPED_KEY);
      const skipped: string[] = stored ? JSON.parse(stored) : [];
      if (!skipped.includes(entry.title)) {
        skipped.push(entry.title);
        localStorage.setItem(SKIPPED_KEY, JSON.stringify(skipped));
      }
    } catch {}
  };


  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-10 px-4">
      <div className="w-full max-w-2xl space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold text-zinc-900">Watchlist</h1>
          <p className="text-sm text-zinc-500">
            {watchlist.length} title{watchlist.length !== 1 ? "s" : ""} to watch — one global list; any channel can add
            titles here.
          </p>
        </div>

        {watchlist.length === 0 ? (
          <div className="bg-white rounded-2xl border border-zinc-200 p-12 text-center shadow-sm">
            <p className="text-zinc-400 text-sm">
              No titles yet. Save from the app with blue 4–5★ (or use &ldquo;Add to watchlist&rdquo; on Channels for
              high-interest passes).
            </p>
          </div>
        ) : (
          <>


            <div className="space-y-4">
              {watchlist.map((entry) => (
                <div key={entry.title} className="bg-white rounded-2xl border border-zinc-200 shadow-sm overflow-hidden">
                  <div className="flex gap-4 p-4">
                    {entry.posterUrl && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={entry.posterUrl}
                        alt={`${entry.title} poster`}
                        className="w-24 flex-shrink-0 rounded-xl object-cover self-start shadow-sm"
                      />
                    )}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                              {entry.type === "tv" ? "TV Series" : "Movie"}
                              {entry.year && <span className="ml-1 font-normal">· {entry.year}</span>}
                            </span>
                            {entry.rtScore && <RTBadge score={entry.rtScore} />}
                          </div>
                          <h2 className="text-lg font-bold text-zinc-900 mt-0.5 leading-tight">{entry.title}</h2>
                        </div>
                        <button
                          onClick={() => moveToNotInterested(entry)}
                          className="text-zinc-300 hover:text-red-400 transition-colors flex-shrink-0 text-lg leading-none"
                          title="Remove and mark as not interested"
                        >
                          ×
                        </button>
                      </div>
                      {entry.director && (
                        <p className="mt-1 text-sm text-zinc-500">
                          <span className="text-zinc-400">{entry.type === "tv" ? "Created by" : "Dir."}</span> {entry.director}
                        </p>
                      )}
                      {entry.actors.length > 0 && (
                        <p className="mt-0.5 text-sm text-zinc-500">{entry.actors.join(" · ")}</p>
                      )}
                      {entry.plot && (
                        <p className="mt-2 text-sm text-zinc-600 leading-relaxed">{entry.plot}</p>
                      )}
                      {entry.streaming && entry.streaming.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {entry.streaming.map((s) => (
                            <span key={s} className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700 border border-blue-100">
                              {s}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

      </div>
    </div>
  );
}
