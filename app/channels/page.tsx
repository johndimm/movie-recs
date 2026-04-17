"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import type { RatingEntry, WatchlistEntry } from "../page";
import { StaticStars } from "../components/Stars";
import { migrateRatingValue } from "../lib/ratingScale";
import { starDelta, formatStarDelta } from "../lib/ratingDelta";
import { applyFactoryBootstrap, hasNoChannelsPersisted } from "../lib/factoryChannels";
import {
  canonicalTitleKey,
  entryMatchesChannel,
  loadUnseenInterestLog,
  type UnseenInterestEntry,
} from "../lib/unseenInterestLog";
import { ConfirmDialog } from "../components/ConfirmDialog";

/** What kinds of titles this channel should surface (empty = no extra format filter beyond app settings). */
export type ChannelMedium = "movie" | "tv" | "miniseries";

const VALID_MEDIUMS = new Set<ChannelMedium>(["movie", "tv", "miniseries"]);

export interface Channel {
  id: string;
  name: string;
  /** Feature films, episodic TV, and/or limited series / miniseries. Empty = any format. */
  mediums: ChannelMedium[];
  genres: string[];
  timePeriods: string[];
  language: string;
  region: string;
  artists: string;
  freeText: string;
  popularity: number;
}

/** Ensure persisted channels (pre–mediums field) get a valid `mediums` array. */
export function normalizeChannel(c: Channel): Channel {
  const raw = (c as { mediums?: unknown }).mediums;
  const mediums = Array.isArray(raw)
    ? raw.filter((x): x is ChannelMedium => typeof x === "string" && VALID_MEDIUMS.has(x as ChannelMedium))
    : [];
  return { ...c, mediums };
}

export function channelToFormInitial(ch: Channel): Omit<Channel, "id"> {
  const { id: _id, ...rest } = normalizeChannel(ch);
  return rest;
}

export const CHANNELS_KEY = "movie-recs-channels";
export const ACTIVE_CHANNEL_KEY = "movie-recs-active-channel";
const STORAGE_KEY = "movie-recs-history";
const WATCHLIST_KEY = "movie-recs-watchlist";
const SKIPPED_KEY = "movie-recs-skipped";
const NOT_INTERESTED_KEY = "movie-recs-not-interested";
const SETTINGS_KEY = "movie-recs-settings";

function readLlmFromLocalSettings(): string {
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    if (!s) return "deepseek";
    const o = JSON.parse(s) as { llm?: string };
    return typeof o.llm === "string" && o.llm ? o.llm : "deepseek";
  } catch {
    return "deepseek";
  }
}

export const ALL_CHANNEL: Channel = {
  id: "all",
  name: "All",
  mediums: [],
  genres: [],
  timePeriods: [],
  language: "",
  region: "",
  artists: "",
  freeText: "",
  popularity: 50,
};

const GENRE_OPTIONS = [
  "Action", "Adventure", "Animation", "Comedy", "Crime",
  "Documentary", "Drama", "Fantasy", "Horror", "Musical",
  "Mystery", "Romance", "Sci-Fi", "Thriller", "War", "Western",
];

const TIME_OPTIONS = [
  "pre-1940s", "1940s", "1950s", "1960s", "1970s",
  "1980s", "1990s", "2000s", "2010s", "2020s",
];

const MEDIUM_OPTIONS: { id: ChannelMedium; label: string; hint: string }[] = [
  { id: "movie", label: "Movies", hint: "Theatrical feature films" },
  { id: "tv", label: "TV series", hint: "Episodic / ongoing series" },
  { id: "miniseries", label: "Miniseries", hint: "Limited series, anthology seasons" },
];

export function popularityLabel(n: number): string {
  if (n <= 15) return "Hidden gems only";
  if (n <= 35) return "Mostly obscure";
  if (n <= 45) return "Lean obscure";
  if (n <= 55) return "Balanced";
  if (n <= 65) return "Lean mainstream";
  if (n <= 85) return "Mostly mainstream";
  return "Mainstream only";
}

const EMPTY: Omit<Channel, "id"> = {
  name: "",
  mediums: [],
  genres: [],
  timePeriods: [],
  language: "",
  region: "",
  artists: "",
  freeText: "",
  popularity: 50,
};

// ── Components ─────────────────────────────────────────────────────────────────

function ChannelForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: Omit<Channel, "id">;
  onSave: (data: Omit<Channel, "id">) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);

  const toggleArr = (arr: string[], val: string) =>
    arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];

  const toggleMedium = (arr: ChannelMedium[], val: ChannelMedium) =>
    arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];

  const field = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  return (
    <div className="space-y-4 py-4 border-t border-zinc-100">
      <div>
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Channel name</label>
        <input
          type="text"
          value={form.name}
          onChange={(e) => field("name", e.target.value)}
          placeholder="e.g. French New Wave, 80s Horror, Kubrick"
          className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-300"
        />
      </div>

      <div>
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Medium</label>
        <p className="mt-0.5 text-xs text-zinc-400">
          Leave all off to allow any format (still respects the app&apos;s movie/TV filter). Select one or more to restrict this channel.
        </p>
        <div className="mt-2 flex flex-wrap gap-2">
          {MEDIUM_OPTIONS.map(({ id, label, hint }) => (
            <button
              key={id}
              type="button"
              title={hint}
              onClick={() => field("mediums", toggleMedium(form.mediums, id))}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${form.mediums.includes(id) ? "bg-indigo-600 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Genres</label>
        <div className="mt-2 flex flex-wrap gap-2">
          {GENRE_OPTIONS.map((g) => (
            <button key={g} type="button"
              onClick={() => field("genres", toggleArr(form.genres, g))}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${form.genres.includes(g) ? "bg-indigo-600 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}
            >{g}</button>
          ))}
        </div>
      </div>

      <div>
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Time periods</label>
        <div className="mt-2 flex flex-wrap gap-2">
          {TIME_OPTIONS.map((t) => (
            <button key={t} type="button"
              onClick={() => field("timePeriods", toggleArr(form.timePeriods, t))}
              className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${form.timePeriods.includes(t) ? "bg-indigo-600 text-white" : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"}`}
            >{t}</button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Language</label>
          <input type="text" value={form.language} onChange={(e) => field("language", e.target.value)}
            placeholder="e.g. French, Japanese, any"
            className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-300" />
        </div>
        <div>
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Region / Country</label>
          <input type="text" value={form.region} onChange={(e) => field("region", e.target.value)}
            placeholder="e.g. Iran, Scandinavia, Latin America"
            className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-300" />
        </div>
      </div>

      <div>
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Directors / Actors</label>
        <input type="text" value={form.artists} onChange={(e) => field("artists", e.target.value)}
          placeholder="Comma-separated — e.g. Kubrick, Tarkovsky, Cate Blanchett"
          className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-300" />
      </div>

      <div>
        <div className="flex items-center justify-between mb-1">
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Popularity</label>
          <span className="text-xs text-indigo-600 font-medium">{popularityLabel(form.popularity)}</span>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-zinc-400 w-20 text-right shrink-0">Hidden gems</span>
          <input type="range" min={0} max={100} value={form.popularity}
            onChange={(e) => field("popularity", Number(e.target.value))}
            className="flex-1 accent-indigo-600" />
          <span className="text-xs text-zinc-400 w-20 shrink-0">Mainstream</span>
        </div>
      </div>

      <div>
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Additional hints</label>
        <textarea value={form.freeText} onChange={(e) => field("freeText", e.target.value)}
          placeholder="Any extra instructions for the AI"
          rows={3}
          className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none" />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel}
          className="px-4 py-1.5 rounded-lg border border-zinc-200 text-zinc-600 text-sm font-medium hover:bg-zinc-50 transition-colors">
          Cancel
        </button>
        <button type="button" onClick={() => { if (form.name.trim()) onSave(form); }}
          disabled={!form.name.trim()}
          className="px-4 py-1.5 rounded-lg bg-indigo-600 text-white text-sm font-medium hover:bg-indigo-700 transition-colors disabled:opacity-40">
          Save
        </button>
      </div>
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function ChannelsPage() {
  const [channels, setChannels] = useState<Channel[]>([]);
  const [history, setHistory] = useState<RatingEntry[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [editExpanded, setEditExpanded] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [seenSort, setSeenSort] = useState<"user" | "delta">("user");
  const [unseenLog, setUnseenLog] = useState<UnseenInterestEntry[]>([]);
  const [minPromoteStars, setMinPromoteStars] = useState(3.5);
  const [promoteMessage, setPromoteMessage] = useState<string | null>(null);

  useEffect(() => {
    queueMicrotask(() => {
      try {
        if (hasNoChannelsPersisted()) {
          applyFactoryBootstrap();
        }
        const s = localStorage.getItem(CHANNELS_KEY);
        let chs: Channel[] = s ? (JSON.parse(s) as Channel[]).map(normalizeChannel) : [];
        // Ensure All channel is always present and first
        if (!chs.find((c) => c.id === "all")) {
          chs = [ALL_CHANNEL, ...chs];
          localStorage.setItem(CHANNELS_KEY, JSON.stringify(chs));
        }
        setChannels(chs);
        setSelectedId(chs[0].id);
        const h = localStorage.getItem(STORAGE_KEY);
        if (h) setHistory(JSON.parse(h));
        setUnseenLog(loadUnseenInterestLog());
      } catch {}
    });
  }, []);

  /** Open “new channel” when linked from the main page (`/channels?new=1`). */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const q = new URLSearchParams(window.location.search).get("new");
    if (q !== "1" && q !== "true") return;
    window.history.replaceState({}, "", "/channels");
    queueMicrotask(() => {
      setShowNew(true);
      setEditExpanded(false);
    });
  }, []);

  const saveChannels = (chs: Channel[]) => {
    // All channel is always first and immutable
    const withAll = chs.find((c) => c.id === "all") ? chs : [ALL_CHANNEL, ...chs];
    const normalized = withAll.map(normalizeChannel);
    localStorage.setItem(CHANNELS_KEY, JSON.stringify(normalized));
    setChannels(normalized);
  };

  const createChannel = (data: Omit<Channel, "id">) => {
    const ch: Channel = { ...data, id: crypto.randomUUID() };
    const next = [...channels, ch];
    saveChannels(next);
    setShowNew(false);
    setSelectedId(ch.id);
  };

  const updateChannel = (id: string, data: Omit<Channel, "id">) => {
    saveChannels(channels.map((c) => (c.id === id ? { ...data, id } : c)));
    setEditExpanded(false);
  };

  const confirmDeleteChannel = () => {
    const id = pendingDeleteId;
    if (!id) return;
    const active = localStorage.getItem(ACTIVE_CHANNEL_KEY);
    if (active === id) localStorage.removeItem(ACTIVE_CHANNEL_KEY);
    const next = channels.filter((c) => c.id !== id);
    saveChannels(next);
    setSelectedId(next.length > 0 ? next[0].id : null);
    setEditExpanded(false);
    setPendingDeleteId(null);
  };

  const selected = channels.find((c) => c.id === selectedId) ?? null;
  const pendingDeleteChannel = pendingDeleteId ? channels.find((c) => c.id === pendingDeleteId) : null;

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

  const channelUnseen = useMemo(() => {
    if (!selected) return [];
    return unseenLog
      .filter((e) => entryMatchesChannel(e, selected.id))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
  }, [selected, unseenLog]);

  /** For unseen row pills: "want" rows were saved at rating time and are usually already on the global watchlist. */
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
        // Skips: promote high interest that you dismissed as "not interested" at the time.
        if (e.kind === "skip") return true;
        // Wants (4–5★): should already be on watchlist; count if missing so you can re-add.
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
      const llm = readLlmFromLocalSettings();
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

  // Chips shown in the settings summary row
  const settingChips = selected
    ? [
        ...selected.mediums.map((m) =>
          m === "movie" ? "Movies" : m === "tv" ? "TV series" : "Miniseries"
        ),
        ...selected.genres,
        ...selected.timePeriods,
        ...(selected.language ? [selected.language] : []),
        ...(selected.region ? [selected.region] : []),
        ...(selected.artists ? selected.artists.split(",").map((s) => s.trim()).filter(Boolean) : []),
        popularityLabel(selected.popularity),
      ]
    : [];

  return (
    <>
    <ConfirmDialog
      open={pendingDeleteId !== null}
      title="Delete channel"
      tone="danger"
      confirmLabel="Delete"
      cancelLabel="Cancel"
      onCancel={() => setPendingDeleteId(null)}
      onConfirm={confirmDeleteChannel}
    >
      {pendingDeleteChannel ? (
        <>
          Delete <span className="font-medium text-zinc-800">&quot;{pendingDeleteChannel.name}&quot;</span>? This
          cannot be undone.
        </>
      ) : (
        "Delete this channel? This cannot be undone."
      )}
    </ConfirmDialog>
    <div className="min-h-screen bg-zinc-50">
      <div className="max-w-4xl mx-auto flex h-[calc(100dvh-2.75rem)] sm:h-[calc(100vh-2.75rem)] flex-col sm:flex-row min-h-0">

        {/* Mobile: compact channel picker — full-width select + new (sidebar hidden on small screens) */}
        <div className="shrink-0 border-b border-zinc-200 bg-white sm:hidden">
          {showNew ? (
            <div className="flex items-center gap-3 px-3 py-2.5">
              <button
                type="button"
                onClick={() => setShowNew(false)}
                className="text-sm font-medium text-indigo-600 hover:text-indigo-800"
              >
                ← Back
              </button>
              <span className="text-sm font-semibold text-zinc-800">New channel</span>
            </div>
          ) : (
            <div className="flex items-center gap-2 px-3 py-2.5">
              <label htmlFor="channel-select-mobile" className="sr-only">
                Channel
              </label>
              <select
                id="channel-select-mobile"
                className="min-w-0 flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2.5 text-sm font-medium text-zinc-900 shadow-sm focus:outline-none focus:ring-2 focus:ring-indigo-300 disabled:opacity-50"
                value={selectedId ?? ""}
                disabled={channels.length === 0}
                onChange={(e) => {
                  setSelectedId(e.target.value);
                  setEditExpanded(false);
                  setShowNew(false);
                }}
              >
                {channels.length === 0 ? (
                  <option value="">No channels</option>
                ) : (
                  channels.map((ch) => (
                    <option key={ch.id} value={ch.id}>
                      {ch.name}
                    </option>
                  ))
                )}
              </select>
              <button
                type="button"
                onClick={() => {
                  setShowNew(true);
                  setEditExpanded(false);
                }}
                className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl border border-dashed border-zinc-300 bg-white text-lg font-light leading-none text-zinc-500 transition-colors hover:border-indigo-400 hover:bg-indigo-50 hover:text-indigo-600"
                title="New channel"
                aria-label="New channel"
              >
                +
              </button>
            </div>
          )}
        </div>

        {/* ── Left sidebar: channel list (tablet/desktop only) ── */}
        <div className="hidden w-44 shrink-0 flex-col border-r border-zinc-200 bg-white sm:flex">
          <div className="flex items-center justify-between px-4 py-3 border-b border-zinc-100">
            <span className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Channels</span>
            <button
              onClick={() => { setShowNew(true); setEditExpanded(false); }}
              className="text-zinc-400 hover:text-indigo-600 transition-colors text-lg leading-none"
              title="New channel"
            >+</button>
          </div>
          <div className="flex-1 overflow-y-auto py-1 min-h-0">
            {channels.map((ch) => (
              <button
                key={ch.id}
                onClick={() => { setSelectedId(ch.id); setEditExpanded(false); setShowNew(false); }}
                className={`w-full text-left px-4 py-2.5 text-sm font-medium transition-colors ${
                  selectedId === ch.id
                    ? "bg-zinc-100 text-zinc-900"
                    : "text-zinc-600 hover:bg-zinc-50 hover:text-zinc-900"
                }`}
              >
                {ch.name}
              </button>
            ))}
            {channels.length === 0 && (
              <p className="px-4 py-3 text-xs text-zinc-400">No channels yet.</p>
            )}
          </div>
        </div>

        {/* ── Main panel ── */}
        <div className="min-h-0 flex-1 overflow-y-auto">

          {/* New channel form */}
          {showNew && (
            <div className="p-4 sm:p-6">
              <p className="text-sm font-semibold text-zinc-700 mb-0">New channel</p>
              <ChannelForm
                initial={EMPTY}
                onSave={createChannel}
                onCancel={() => setShowNew(false)}
              />
            </div>
          )}

          {/* Selected channel view */}
          {!showNew && selected && (
            <div className="p-4 sm:p-6 space-y-6">

              {/* Settings summary row */}
              <div>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex flex-wrap gap-1.5">
                    {settingChips.length > 0
                      ? settingChips.map((chip) => (
                          <span key={chip} className="px-2.5 py-0.5 rounded-full text-xs font-medium bg-zinc-100 text-zinc-600">
                            {chip}
                          </span>
                        ))
                      : <span className="text-sm text-zinc-400">No filters set</span>
                    }
                  </div>
                  {selected.id !== "all" && (
                    <div className="flex items-center gap-3 shrink-0">
                      <button
                        onClick={() => setEditExpanded((v) => !v)}
                        className="text-sm text-zinc-500 hover:text-zinc-800 transition-colors whitespace-nowrap flex items-center gap-1"
                      >
                        Edit settings <span className="text-xs">{editExpanded ? "▲" : "▼"}</span>
                      </button>
                      <button
                        onClick={() => setPendingDeleteId(selected.id)}
                        className="text-xs text-zinc-400 hover:text-red-500 transition-colors"
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </div>

                {/* Expandable edit form */}
                {editExpanded && selected.id !== "all" && (
                  <ChannelForm
                    initial={channelToFormInitial(selected)}
                    onSave={(data) => updateChannel(selected.id, data)}
                    onCancel={() => setEditExpanded(false)}
                  />
                )}
              </div>

              {/* Channel history: seen + unseen */}
              <div>
                <div className="flex flex-wrap items-end justify-between gap-3 mb-3">
                  <div>
                    <p className="text-xs font-bold text-zinc-500 uppercase tracking-wider">Channel history</p>
                    <p className="text-sm text-zinc-500 mt-0.5">
                      {channelRatings.length} seen · {channelUnseen.length} unseen
                    </p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <label className="text-xs text-zinc-500 whitespace-nowrap">
                      Min interest for watchlist
                    </label>
                    <select
                      value={String(minPromoteStars)}
                      onChange={(e) => setMinPromoteStars(Number(e.target.value))}
                      className="rounded-lg border border-zinc-200 bg-white px-2 py-1.5 text-sm text-zinc-800"
                    >
                      {[2.5, 3, 3.5, 4, 4.5].map((n) => (
                        <option key={n} value={String(n)}>
                          {n}★
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      onClick={addHighInterestSkipsToWatchlist}
                      disabled={promoteMatchCount === 0}
                      className="rounded-lg bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-40"
                      title="Adds titles that are not on your watchlist yet: high-interest passes (Not interested), or saves you removed from the list. Count excludes titles already on the list (including “Added” rows)."
                    >
                      Add to watchlist ({promoteMatchCount})
                    </button>
                  </div>
                </div>
                {promoteMessage && (
                  <p className="text-xs font-medium text-green-700 mb-2" role="status">
                    {promoteMessage}
                  </p>
                )}

                {channelRatings.length === 0 && channelUnseen.length === 0 ? (
                  <p className="text-sm text-zinc-400">No history in this channel yet.</p>
                ) : (
                  <>
                    {channelRatings.length > 0 && (
                      <div className="rounded-xl border border-zinc-200 bg-white overflow-hidden">
                        <div className="px-3 py-2 border-b border-zinc-100 bg-zinc-50/80">
                          <p className="text-xs font-semibold text-zinc-600 mb-2">Seen</p>
                          <div className="flex flex-wrap items-center justify-between gap-2">
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
                        </div>
                        <div className="divide-y divide-zinc-50">
                          {sortedChannelRatings.map((e) => {
                            const d = starDelta(e.userRating, e.predictedRating);
                            return (
                              <div
                                key={`${e.title}-${e.userRating}-${e.predictedRating}`}
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
                                </div>
                                <div className="flex items-center justify-end gap-2 shrink-0">
                                  <span
                                    className={`w-12 shrink-0 text-right tabular-nums text-sm font-semibold ${
                                      d > 0 ? "text-emerald-700" : d < 0 ? "text-rose-700" : "text-zinc-500"
                                    }`}
                                    title="Your rating minus predicted (stars)"
                                  >
                                    {formatStarDelta(d)}
                                  </span>
                                  <div className="w-20 shrink-0 flex justify-end">
                                    <StaticStars rating={migrateRatingValue(e.userRating)} color="red" />
                                  </div>
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {channelUnseen.length > 0 && (
                      <div
                        className={`rounded-xl border border-zinc-200 bg-white overflow-hidden ${
                          channelRatings.length > 0 ? "mt-5" : ""
                        }`}
                      >
                        <div className="px-3 py-2 border-b border-zinc-100 bg-zinc-50/80">
                          <p className="text-xs font-semibold text-zinc-600">Unseen (blue stars)</p>
                          <p className="text-xs text-zinc-400 mt-0.5">
                            Blue stars when you passed or saved. &ldquo;Added&rdquo; means you chose save when you rated (that title was put on your watchlist then). The button count is only titles <strong className="font-medium text-zinc-500">not</strong> on your watchlist yet, above the min stars—usually high-interest passes, or saves you removed later.
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
                              </div>
                              <div className="flex items-center justify-end gap-2 shrink-0">
                                <span className="w-12 shrink-0 text-right tabular-nums text-sm font-semibold invisible select-none" aria-hidden>
                                  0
                                </span>
                                <div className="w-20 shrink-0 flex justify-end">
                                  <StaticStars rating={migrateRatingValue(e.interestStars)} color="blue" />
                                </div>
                                <span
                                  className={`shrink-0 text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full ${
                                    e.kind === "want"
                                      ? "bg-emerald-100 text-emerald-800"
                                      : "bg-zinc-100 text-zinc-600"
                                  }`}
                                  title={
                                    e.kind === "want"
                                      ? watchlistKeys.has(canonicalTitleKey(e.title))
                                        ? "You saved this title when you rated; it is on your watchlist."
                                        : "You saved when you rated, but this title is not on your watchlist now—the button can add it if stars meet the minimum."
                                      : "You passed with not interested when you rated."
                                  }
                                >
                                  {e.kind === "want"
                                    ? watchlistKeys.has(canonicalTitleKey(e.title))
                                      ? "Added"
                                      : "Not on list"
                                    : "Not interested"}
                                </span>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </>
                )}
              </div>

            </div>
          )}

          {/* No channels at all */}
          {!showNew && !selected && (
            <div className="p-10 text-center text-zinc-400 text-sm">
              Create a channel to get started.
            </div>
          )}

        </div>
      </div>
    </div>
    </>
  );
}
