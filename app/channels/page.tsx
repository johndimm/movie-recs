"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { applyFactoryBootstrap, hasNoChannelsPersisted } from "../lib/factoryChannels";
import { ConfirmDialog } from "../components/ConfirmDialog";

/** What kinds of titles this channel should surface (empty = no extra format filter beyond app settings). */
export type ChannelMedium = "movie" | "tv";

const VALID_MEDIUMS = new Set<ChannelMedium>(["movie", "tv"]);

export interface Channel {
  id: string;
  name: string;
  /** Feature films and/or episodic TV. Empty = any format. */
  mediums: ChannelMedium[];
  genres: string[];
  timePeriods: string[];
  language: string;
  artists: string;
  freeText: string;
  popularity: number;
}

/** Ensure persisted channels (pre–mediums field) get a valid `mediums` array; drop legacy `region`. */
export function normalizeChannel(c: Channel & { region?: string }): Channel {
  const { region: _r, ...rest } = c;
  const raw = (c as { mediums?: unknown }).mediums;
  const mediums = Array.isArray(raw)
    ? raw.filter((x): x is ChannelMedium => typeof x === "string" && VALID_MEDIUMS.has(x as ChannelMedium))
    : [];
  return { ...rest, mediums };
}

export function channelToFormInitial(ch: Channel): Omit<Channel, "id"> {
  const { id: _id, ...rest } = normalizeChannel(ch);
  return rest;
}

export const CHANNELS_KEY = "movie-recs-channels";
export const ACTIVE_CHANNEL_KEY = "movie-recs-active-channel";

const SETTINGS_KEY = "movie-recs-settings";
function readLlmFromLocalSettings(): string {
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    if (!s) return "deepseek";
    const o = JSON.parse(s) as { llm?: string };
    return o.llm ?? "deepseek";
  } catch {
    return "deepseek";
  }
}

/** Cache LLM artist suggestions by filter signature (same tab + reload via sessionStorage). */
const ARTIST_SUGGEST_CACHE_STORAGE = "movie-recs-artist-suggestions-v1";
const artistSuggestMemCache = new Map<string, string[]>();

function stableArtistSuggestKey(
  genres: string[],
  timePeriods: string[],
  language: string,
  freeText: string,
  llm: string,
): string {
  return JSON.stringify({
    g: [...genres].sort(),
    t: [...timePeriods].sort(),
    l: language.trim(),
    f: freeText.trim(),
    m: llm,
  });
}

function getArtistSuggestCached(key: string): string[] | undefined {
  if (artistSuggestMemCache.has(key)) return artistSuggestMemCache.get(key)!;
  try {
    const raw = sessionStorage.getItem(ARTIST_SUGGEST_CACHE_STORAGE);
    if (!raw) return undefined;
    const all = JSON.parse(raw) as Record<string, string[]>;
    if (!Object.prototype.hasOwnProperty.call(all, key)) return undefined;
    const arr = all[key];
    if (!Array.isArray(arr)) return undefined;
    artistSuggestMemCache.set(key, arr);
    return arr;
  } catch {
    return undefined;
  }
}

function setArtistSuggestCached(key: string, artists: string[]) {
  artistSuggestMemCache.set(key, artists);
  try {
    const raw = sessionStorage.getItem(ARTIST_SUGGEST_CACHE_STORAGE);
    const all = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    all[key] = artists;
    sessionStorage.setItem(ARTIST_SUGGEST_CACHE_STORAGE, JSON.stringify(all));
  } catch {
    /* quota */
  }
}

export const ALL_CHANNEL: Channel = {
  id: "all",
  name: "All",
  mediums: [],
  genres: [],
  timePeriods: [],
  language: "",
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
  { id: "tv", label: "TV series", hint: "Episodic / ongoing TV series" },
];

const LANGUAGE_OPTIONS = [
  "English", "French", "Italian", "Spanish", "German", "Japanese",
  "Korean", "Mandarin", "Cantonese", "Hindi", "Portuguese", "Russian",
  "Arabic", "Persian", "Swedish", "Danish", "Norwegian", "Finnish",
  "Polish", "Greek", "Turkish", "Hebrew",
];

function csvToArray(csv: string): string[] {
  return csv.split(",").map((s) => s.trim()).filter(Boolean);
}

function toggleCsv(csv: string, val: string): string {
  const items = csvToArray(csv);
  return items.includes(val)
    ? items.filter((x) => x !== val).join(", ")
    : [...items, val].join(", ");
}

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
  artists: "",
  freeText: "",
  popularity: 50,
};

// ── Components ─────────────────────────────────────────────────────────────────

function ChipRow({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: string[];
  onToggle: (val: string) => void;
}) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onToggle(opt)}
          className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${
            selected.includes(opt)
              ? "bg-indigo-600 text-white"
              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

type Suggestions = { artists: string[] };

const EMPTY_SUGGESTIONS: Suggestions = { artists: [] };

function ChannelForm({
  initial,
  onSave,
  onCancel,
}: {
  initial: Omit<Channel, "id">;
  onSave: (data: Omit<Channel, "id">) => void;
  onCancel?: () => void;
}) {
  const [form, setForm] = useState(initial);
  const formRef = useRef(form);
  formRef.current = form;
  const [suggestions, setSuggestions] = useState<Suggestions>(EMPTY_SUGGESTIONS);
  const [loadingSuggestions, setLoadingSuggestions] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const toggleArr = (arr: string[], val: string) =>
    arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];

  const toggleMedium = (arr: ChannelMedium[], val: ChannelMedium) =>
    arr.includes(val) ? arr.filter((x) => x !== val) : [...arr, val];

  const field = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const hasSelections =
    form.genres.length > 0 ||
    form.timePeriods.length > 0 ||
    form.language.trim() !== "" ||
    form.freeText.trim() !== "";

  const llmChoice = readLlmFromLocalSettings();
  const artistSuggestKey = useMemo(
    () =>
      stableArtistSuggestKey(
        form.genres,
        form.timePeriods,
        form.language,
        form.freeText,
        llmChoice,
      ),
    [form.genres.join(","), form.timePeriods.join(","), form.language, form.freeText, llmChoice],
  );

  useEffect(() => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    abortRef.current?.abort();

    if (!hasSelections) {
      setSuggestions(EMPTY_SUGGESTIONS);
      setLoadingSuggestions(false);
      return;
    }

    const cached = getArtistSuggestCached(artistSuggestKey);
    if (cached !== undefined) {
      setSuggestions({ artists: cached });
      setLoadingSuggestions(false);
      return;
    }

    const scheduleKey = artistSuggestKey;
    debounceRef.current = setTimeout(async () => {
      const f = formRef.current;
      const llm = readLlmFromLocalSettings();
      const bodyKey = stableArtistSuggestKey(
        f.genres,
        f.timePeriods,
        f.language,
        f.freeText,
        llm,
      );
      if (bodyKey !== scheduleKey) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoadingSuggestions(true);
      try {
        const res = await fetch("/api/suggest-artists", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            genres: f.genres,
            timePeriods: f.timePeriods,
            language: f.language,
            freeText: f.freeText,
            llm,
          }),
          signal: controller.signal,
        });
        if (controller.signal.aborted) return;
        const after = stableArtistSuggestKey(
          formRef.current.genres,
          formRef.current.timePeriods,
          formRef.current.language,
          formRef.current.freeText,
          readLlmFromLocalSettings(),
        );
        if (after !== bodyKey) return;
        if (res.ok) {
          const data = (await res.json()) as Suggestions;
          const artists = Array.isArray(data.artists) ? data.artists : [];
          setArtistSuggestCached(bodyKey, artists);
          setSuggestions({ artists });
        }
      } catch (e) {
        if ((e as { name?: string }).name !== "AbortError") console.error("[suggest-artists]", e);
      }
      if (!controller.signal.aborted) setLoadingSuggestions(false);
    }, 600);

    return () => {
      if (debounceRef.current) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    };
  }, [hasSelections, artistSuggestKey]);

  const artistOptions = hasSelections && suggestions.artists.length > 0
    ? [...new Set([...suggestions.artists, ...csvToArray(form.artists)])]
    : csvToArray(form.artists);

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
        <ChipRow options={GENRE_OPTIONS} selected={form.genres} onToggle={(g) => field("genres", toggleArr(form.genres, g))} />
      </div>

      <div>
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Time periods</label>
        <ChipRow options={TIME_OPTIONS} selected={form.timePeriods} onToggle={(t) => field("timePeriods", toggleArr(form.timePeriods, t))} />
      </div>

      <div>
        <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Language</label>
        <ChipRow options={LANGUAGE_OPTIONS} selected={csvToArray(form.language)} onToggle={(l) => field("language", toggleCsv(form.language, l))} />
      </div>

      <div>
        <div className="flex items-center gap-2 mb-1">
          <label className="text-xs font-semibold text-zinc-500 uppercase tracking-wider">Directors / Actors</label>
          {loadingSuggestions && <span className="text-xs text-zinc-400">updating…</span>}
        </div>
        {artistOptions.length > 0
          ? <ChipRow options={artistOptions} selected={csvToArray(form.artists)} onToggle={(a) => field("artists", toggleCsv(form.artists, a))} />
          : <p className="mt-1 text-xs text-zinc-400">{hasSelections ? "No suggestions yet — select genres, time period, or language first." : "Select at least one filter above to see suggestions."}</p>
        }
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
          placeholder="Any extra instructions for the AI — names not in the list above, specific films, vibes, etc."
          rows={3}
          className="mt-1 w-full rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-800 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none" />
      </div>

      <div className="flex justify-end gap-2 pt-1">
        {onCancel && (
          <button type="button" onClick={onCancel}
            className="px-4 py-1.5 rounded-lg border border-zinc-200 text-zinc-600 text-sm font-medium hover:bg-zinc-50 transition-colors">
            Cancel
          </button>
        )}
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
  const router = useRouter();
  const [channels, setChannels] = useState<Channel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [showNew, setShowNew] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);

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
        const activeId = localStorage.getItem(ACTIVE_CHANNEL_KEY);
        const initialId = activeId && chs.find((c) => c.id === activeId) ? activeId : chs[0].id;
        setSelectedId(initialId);
      } catch {}
    });
  }, []);

  /** Open "new channel" when linked from the main page (`/channels?new=1`).
   *  Pre-select a channel when linked with `?select=<id>`. */
  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    const newParam = params.get("new");
    const selectParam = params.get("select");
    window.history.replaceState({}, "", "/channels");
    if (newParam === "1" || newParam === "true") {
      queueMicrotask(() => setShowNew(true));
    } else if (selectParam) {
      queueMicrotask(() => {
        setSelectedId(selectParam);
        setShowNew(false);
      });
    }
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
    localStorage.setItem(ACTIVE_CHANNEL_KEY, ch.id);
    router.push("/");
  };

  const updateChannel = (id: string, data: Omit<Channel, "id">) => {
    saveChannels(channels.map((c) => (c.id === id ? { ...data, id } : c)));
    localStorage.setItem(ACTIVE_CHANNEL_KEY, id);
    router.push("/");
  };

  const confirmDeleteChannel = () => {
    const id = pendingDeleteId;
    if (!id) return;
    const active = localStorage.getItem(ACTIVE_CHANNEL_KEY);
    if (active === id) localStorage.removeItem(ACTIVE_CHANNEL_KEY);
    const next = channels.filter((c) => c.id !== id);
    saveChannels(next);
    setSelectedId(next.length > 0 ? next[0].id : null);
    setPendingDeleteId(null);
  };

  /** Sidebar / picker: switch channel + keep app active channel in sync with the player. */
  const selectChannel = (id: string) => {
    setSelectedId(id);
    setShowNew(false);
    try {
      localStorage.setItem(ACTIVE_CHANNEL_KEY, id);
    } catch {
      /* ignore */
    }
  };

  const selected = channels.find((c) => c.id === selectedId) ?? null;
  const pendingDeleteChannel = pendingDeleteId ? channels.find((c) => c.id === pendingDeleteId) : null;

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
                  selectChannel(e.target.value);
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
              onClick={() => { setShowNew(true); }}
              className="text-zinc-400 hover:text-indigo-600 transition-colors text-lg leading-none"
              title="New channel"
            >+</button>
          </div>
          <div className="flex-1 overflow-y-auto py-1 min-h-0">
            {channels.map((ch) => (
              <button
                key={ch.id}
                type="button"
                onClick={() => selectChannel(ch.id)}
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
                key="new-channel"
                initial={EMPTY}
                onSave={createChannel}
                onCancel={() => setShowNew(false)}
              />
            </div>
          )}

          {/* Selected channel view */}
          {!showNew && selected && (
            <div className="p-4 sm:p-6 space-y-6">

              {/* Edit form */}
              {selected.id !== "all" && (
                <div>
                  <div className="flex justify-end mb-2">
                    <button
                      onClick={() => setPendingDeleteId(selected.id)}
                      className="text-xs text-zinc-400 hover:text-red-500 transition-colors"
                    >
                      Delete channel
                    </button>
                  </div>
                  <ChannelForm
                    key={selected.id}
                    initial={channelToFormInitial(selected)}
                    onSave={(data) => updateChannel(selected.id, data)}
                  />
                </div>
              )}

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
