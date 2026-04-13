"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import Link from "next/link";

interface RatingEntry {
  title: string;
  type: "movie" | "tv";
  userRating: number;
  predictedRating: number;
  error: number;
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
  addedAt: string;
}

const STORAGE_KEY = "movie-recs-history";
const SKIPPED_KEY = "movie-recs-skipped";
const WATCHLIST_KEY = "movie-recs-watchlist";
const NOTSEEN_KEY = "movie-recs-notseen";

const WANT_PENALTY = 25;   // saw it, want to — LLM got taste right, just unseen
const SKIP_PENALTY = 50;   // not interested — LLM missed entirely

interface NotSeenEvent {
  afterRating: number;
  kind: "want" | "skip";
}

type SeqEvent = { kind: "rated"; error: number } | { kind: "not-seen"; penalty: number; want: boolean };

function buildSequence(history: RatingEntry[], notSeen: NotSeenEvent[]): SeqEvent[] {
  const sorted = [...notSeen].sort((a, b) => a.afterRating - b.afterRating);
  const events: SeqEvent[] = [];
  let nsIdx = 0;

  const toSeqEvent = (e: NotSeenEvent): SeqEvent => ({
    kind: "not-seen",
    want: e.kind === "want",
    penalty: e.kind === "want" ? WANT_PENALTY : SKIP_PENALTY,
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

function ErrorChart({ history, notSeen }: { history: RatingEntry[]; notSeen: NotSeenEvent[] }) {
  const seq = buildSequence(history, notSeen);
  if (seq.length === 0) return null;

  const W = 600;
  const H = 130;
  const PAD = { top: 10, right: 20, bottom: 30, left: 40 };
  const chartW = W - PAD.left - PAD.right;
  const chartH = H - PAD.top - PAD.bottom;
  const maxError = 100;
  const n = seq.length;

  const xScale = (i: number) =>
    n === 1 ? PAD.left + chartW / 2 : PAD.left + (i / (n - 1)) * chartW;
  // accuracy = 100 - value; yScale maps 0→bottom, 100→top
  const yScale = (accuracy: number) =>
    PAD.top + chartH - (Math.min(Math.max(accuracy, 0), 100) / 100) * chartH;

  // Accuracy per event (100 - error or 100 - penalty)
  const accuracy = (e: SeqEvent) => 100 - (e.kind === "rated" ? e.error : e.penalty);

  // Rolling average accuracy over last WINDOW decisions
  const WINDOW = 5;
  const combinedAvgs = seq.map((_, i) => {
    const slice = seq.slice(Math.max(0, i - WINDOW + 1), i + 1);
    return slice.reduce((s, e) => s + accuracy(e), 0) / slice.length;
  });

  const avgPath =
    n === 1
      ? ""
      : combinedAvgs
          .map((v, i) => `${i === 0 ? "M" : "L"} ${xScale(i).toFixed(2)} ${yScale(v).toFixed(2)}`)
          .join(" ");

  const currentAvg = combinedAvgs[combinedAvgs.length - 1];
  const ratedCount = seq.filter((e) => e.kind === "rated").length;
  const wantCount = seq.filter((e) => e.kind === "not-seen" && e.want).length;
  const skipCount = seq.filter((e) => e.kind === "not-seen" && !e.want).length;

  // Reference lines in accuracy space
  const WANT_ACC = 100 - WANT_PENALTY;  // 75
  const SKIP_ACC = 100 - SKIP_PENALTY;  // 50

  return (
    <div className="w-full">
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1 mb-2 text-sm text-zinc-500">
        <span><span className="font-semibold text-zinc-800">{ratedCount}</span> rated</span>
        {wantCount > 0 && <span><span className="font-semibold text-yellow-600">{wantCount}</span> want to see <span className="text-zinc-400 text-xs">(acc {WANT_ACC})</span></span>}
        {skipCount > 0 && <span><span className="font-semibold text-red-600">{skipCount}</span> not interested <span className="text-zinc-400 text-xs">(acc {SKIP_ACC})</span></span>}
        <span>Avg accuracy: <span className="font-semibold text-indigo-700">{currentAvg.toFixed(1)}</span></span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ maxHeight: 130 }}>
        {/* Grid lines */}
        {[0, 25, 50, 75, 100].map((v) => (
          <g key={v}>
            <line x1={PAD.left} y1={yScale(v)} x2={PAD.left + chartW} y2={yScale(v)}
              stroke={v === WANT_ACC ? "#fde68a" : v === SKIP_ACC ? "#fca5a5" : "#e4e4e7"}
              strokeWidth={v === WANT_ACC || v === SKIP_ACC ? 1.5 : 1}
              strokeDasharray={v === WANT_ACC || v === SKIP_ACC ? "4 3" : undefined} />
            <text x={PAD.left - 4} y={yScale(v)} textAnchor="end" dominantBaseline="middle" fontSize="9"
              fill={v === WANT_ACC ? "#ca8a04" : v === SKIP_ACC ? "#dc2626" : "#a1a1aa"}>{v}</text>
          </g>
        ))}

        {/* Bars / markers per event */}
        {seq.map((e, i) => {
          const x = xScale(i);
          const acc = accuracy(e);
          if (e.kind === "rated") {
            const barH = (Math.min(Math.max(acc, 0), 100) / 100) * chartH;
            return <rect key={i} x={x - 3} y={yScale(acc)} width={6} height={barH} fill="#93c5fd" opacity={0.7} rx={1} />;
          } else {
            const cy = yScale(acc);
            const r = 5;
            const fill = e.want ? "#ca8a04" : "#dc2626";
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
        <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rotate-45 bg-yellow-600 opacity-85" /> want to see (acc {WANT_ACC})</span>
        <span className="flex items-center gap-1"><span className="inline-block w-2.5 h-2.5 rotate-45 bg-red-600 opacity-85" /> not interested (acc {SKIP_ACC})</span>
        <span className="flex items-center gap-1"><span className="inline-block w-4 h-0.5 bg-indigo-600" /> avg accuracy</span>
      </div>
    </div>
  );
}

const PERFECT_MESSAGES = [
  "The AI read your mind!",
  "Absolute telepathy.",
  "Zero error. Perfection.",
  "The AI knows you better than you know yourself.",
  "Statistically impossible. Yet here we are.",
];

function RevealModal({
  reveal,
  onDismiss,
}: {
  reveal: { title: string; userRating: number; predictedRating: number; error: number };
  onDismiss: () => void;
}) {
  const perfect = reveal.error === 0;
  const great = reveal.error <= 5;
  const msg = perfect ? PERFECT_MESSAGES[Math.floor(Math.random() * PERFECT_MESSAGES.length)] : null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onDismiss}
    >
      <div
        className={`relative mx-4 w-full max-w-sm rounded-3xl shadow-2xl p-8 text-center animate-[fadeScaleIn_0.2s_ease-out] ${
          perfect
            ? "bg-gradient-to-br from-yellow-50 via-amber-50 to-orange-50 border-2 border-amber-300"
            : "bg-white border border-zinc-200"
        }`}
        onClick={(e) => e.stopPropagation()}
        style={{ animationFillMode: "both" }}
      >
        {perfect && (
          <div className="text-4xl mb-3 leading-none select-none">🎯</div>
        )}
        <p className="text-xs font-semibold uppercase tracking-widest text-zinc-400 mb-1">
          {reveal.title}
        </p>
        {perfect && msg && (
          <p className="text-sm font-semibold text-amber-700 mb-4">{msg}</p>
        )}

        <div className="grid grid-cols-3 gap-3 my-4">
          <div className="bg-zinc-50 rounded-2xl py-3">
            <div className="text-xs text-zinc-400 mb-1">You</div>
            <div className="text-3xl font-bold text-zinc-900">{reveal.userRating}</div>
          </div>
          <div className="bg-blue-50 rounded-2xl py-3">
            <div className="text-xs text-zinc-400 mb-1">AI</div>
            <div className="text-3xl font-bold text-blue-600">{reveal.predictedRating}</div>
          </div>
          <div className={`rounded-2xl py-3 ${perfect ? "bg-amber-100" : great ? "bg-green-50" : reveal.error <= 25 ? "bg-yellow-50" : "bg-red-50"}`}>
            <div className="text-xs text-zinc-400 mb-1">Error</div>
            <div className={`text-3xl font-bold ${perfect ? "text-amber-600" : great ? "text-green-700" : reveal.error <= 25 ? "text-yellow-700" : "text-red-700"}`}>
              {reveal.error}
            </div>
          </div>
        </div>

        <button
          onClick={onDismiss}
          className="mt-2 text-xs text-zinc-400 hover:text-zinc-600 transition-colors"
        >
          tap anywhere to dismiss
        </button>
      </div>
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
  const [current, setCurrent] = useState<CurrentMovie | null>(null);
  const [initialLoading, setInitialLoading] = useState(true);
  const [cardOpacity, setCardOpacity] = useState(1);
  const [userRating, setUserRating] = useState("50");
  const [lastResult, setLastResult] = useState<LastResult | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [reveal, setReveal] = useState<{ title: string; userRating: number; predictedRating: number; error: number } | null>(null);
  const [mediaType, setMediaType] = useState<"both" | "movie" | "tv">("both");
  const [llm, setLlm] = useState<string>("deepseek");
  const [availableLlms, setAvailableLlms] = useState<{ id: string; label: string }[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { setLightboxUrl(null); setReveal(null); }
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
    } catch {}
  }, []);

  const saveHistory = (h: RatingEntry[]) => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(h));
    setHistory(h);
  };

  const fetchNext = useCallback(async (hist: RatingEntry[], skip: string[], opts: { mediaType: string; llm: string }, isFirst = false) => {
    if (!isFirst) setCardOpacity(0.45);

    const excluded = new Set([...hist.map((h) => h.title.toLowerCase()), ...skip.map((s) => s.toLowerCase())]);

    const callApi = async (extraSkip: string[] = []): Promise<Response> => {
      return fetch("/api/next-movie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history: hist, skipped: [...skip, ...extraSkip], mediaType: opts.mediaType, llm: opts.llm }),
      });
    };

    try {
      let res = await callApi();
      if (!res.ok) {
        console.error("API error:", res.status, await res.json().catch(() => ({})));
        res = await callApi(); // retry once on 500
        if (!res.ok) throw new Error(`API error ${res.status}`);
      }
      let data = await res.json();

      // If the LLM returned a duplicate, keep retrying (up to 3 extra attempts)
      const extraSkip: string[] = [];
      for (let attempt = 0; attempt < 3 && excluded.has(data.title?.toLowerCase()); attempt++) {
        console.warn(`Duplicate title returned: "${data.title}" — retrying`);
        extraSkip.push(data.title);
        const r2 = await callApi(extraSkip);
        if (r2.ok) data = await r2.json();
      }

      setCardOpacity(0);
      setTimeout(() => { setCurrent(data); setUserRating("50"); setInitialLoading(false); setCardOpacity(1); setReveal(null); }, 150);
    } catch (e) {
      console.error("fetchNext failed:", e);
      setCardOpacity(1);
      setInitialLoading(false);
    }
  }, []);

  useEffect(() => {
    const stored = localStorage.getItem(STORAGE_KEY);
    const hist: RatingEntry[] = stored ? JSON.parse(stored) : [];
    const storedSkipped = localStorage.getItem(SKIPPED_KEY);
    const skip: string[] = storedSkipped ? JSON.parse(storedSkipped) : [];
    fetchNext(hist, skip, { mediaType, llm }, true);
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

  const handleRate = () => {
    const rating = parseInt(userRating, 10) || 50;
    if (!current) return;
    const error = Math.abs(rating - current.predictedRating);
    const entry: RatingEntry = { title: current.title, type: current.type, userRating: rating, predictedRating: current.predictedRating, error };
    setLastResult({ ...entry, actors: current.actors, plot: current.plot, posterUrl: current.posterUrl, rtScore: current.rtScore });
    setReveal({ title: current.title, userRating: rating, predictedRating: current.predictedRating, error });
    const newHistory = [...history, entry];
    saveHistory(newHistory);
    fetchNext(newHistory, skipped, { mediaType, llm });
  };

  const recordNotSeen = (kind: "want" | "skip") => {
    if (!current) return;

    if (kind === "want") {
      const entry: WatchlistEntry = {
        title: current.title,
        type: current.type,
        year: current.year,
        director: current.director,
        actors: current.actors,
        plot: current.plot,
        posterUrl: current.posterUrl,
        rtScore: current.rtScore,
        addedAt: new Date().toISOString(),
      };
      const newWatchlist = [entry, ...watchlist.filter((w) => w.title !== current.title)];
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify(newWatchlist));
      setWatchlist(newWatchlist);
    }

    const nsEvent: NotSeenEvent = { afterRating: history.length, kind };
    const newNotSeen = [...notSeen, nsEvent];
    localStorage.setItem(NOTSEEN_KEY, JSON.stringify(newNotSeen));
    setNotSeen(newNotSeen);

    const newSkipped = [...skipped, current.title];
    localStorage.setItem(SKIPPED_KEY, JSON.stringify(newSkipped));
    setSkipped(newSkipped);
    fetchNext(history, newSkipped, { mediaType, llm });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") handleRate();
  };

  const handleReset = () => {
    if (confirm("Clear all ratings and start over?")) {
      saveHistory([]);
      localStorage.removeItem(SKIPPED_KEY);
      localStorage.removeItem(NOTSEEN_KEY);
      setSkipped([]);
      setNotSeen([]);
      fetchNext([], [], { mediaType, llm });
    }
  };

  const ratingNum = parseInt(userRating, 10);

  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-10 px-4">
      <div className="w-full max-w-3xl space-y-6">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-zinc-900">Movie Recs</h1>
            <p className="text-sm text-zinc-500">Rate titles. The AI learns your taste.</p>
          </div>
          <div className="flex items-center gap-4">
            <Link href="/watchlist" className="text-sm font-medium text-blue-600 hover:text-blue-800 transition-colors">
              Watchlist {watchlist.length > 0 && <span className="ml-1 bg-blue-100 text-blue-700 text-xs font-bold px-1.5 py-0.5 rounded-full">{watchlist.length}</span>}
            </Link>
            <a href="/journal.html" target="_blank" rel="noopener noreferrer" className="text-sm font-medium text-zinc-400 hover:text-zinc-700 transition-colors">
              Journal
            </a>
            {history.length > 0 && (
              <button onClick={handleReset} className="text-xs text-zinc-400 hover:text-red-500 transition-colors">
                Reset
              </button>
            )}
          </div>
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
            <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Prediction Accuracy Over Time</p>
            <ErrorChart history={history} notSeen={notSeen} />

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
              className="flex gap-4 p-6"
              style={{ opacity: cardOpacity, transition: "opacity 150ms ease" }}
            >
              {current.posterUrl && (
                <button
                  onClick={() => setLightboxUrl(current.posterUrl)}
                  className="flex-shrink-0 self-start rounded-xl overflow-hidden shadow-sm hover:shadow-md transition-shadow cursor-zoom-in"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={current.posterUrl} alt={`${current.title} poster`} className="w-72 object-cover" />
                </button>
              )}
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

                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <label className="text-sm font-medium text-zinc-600">Your rating</label>
                    <span className="text-3xl font-bold text-zinc-900 w-14 text-right tabular-nums">{ratingNum || 50}</span>
                  </div>
                  <input
                    ref={inputRef}
                    type="range"
                    min={0}
                    max={100}
                    value={ratingNum || 50}
                    onChange={(e) => setUserRating(e.target.value)}
                    onKeyDown={handleKeyDown}
                    className="w-full h-2 rounded-full appearance-none cursor-pointer accent-blue-600 bg-zinc-200"
                  />
                  <div className="flex justify-between text-xs text-zinc-400 px-0.5">
                    <span>0</span><span>25</span><span>50</span><span>75</span><span>100</span>
                  </div>
                  <button onClick={handleRate} className="w-full py-2.5 rounded-xl bg-blue-600 text-white font-semibold hover:bg-blue-700 transition-colors">
                    Submit Rating
                  </button>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      onClick={() => recordNotSeen("want")}
                      className="py-2 rounded-xl border border-zinc-200 text-sm text-zinc-500 hover:bg-zinc-50 transition-colors"
                    >
                      Want to watch
                    </button>
                    <button
                      onClick={() => recordNotSeen("skip")}
                      className="py-2 rounded-xl border border-zinc-200 text-sm text-zinc-500 hover:bg-zinc-50 transition-colors"
                    >
                      Not interested
                    </button>
                  </div>
                </div>
              </div>
            </div>
          ) : null}
        </div>

        {/* Recent history */}
        {history.length > 0 && (
          <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm">
            <div className="px-4 py-3 border-b border-zinc-100">
              <p className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">Recent Ratings</p>
            </div>
            <ul className="divide-y divide-zinc-50">
              {[...history].reverse().slice(0, 10).map((e, i) => (
                <li key={i} className="px-4 py-2.5 flex items-center justify-between text-sm">
                  <div>
                    <span className="font-medium text-zinc-800">{e.title}</span>
                    <span className="ml-2 text-xs text-zinc-400">{e.type === "tv" ? "TV" : "Film"}</span>
                  </div>
                  <div className="flex items-center gap-3 text-xs">
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

      </div>

      {/* Thinking indicator — fixed so it's always visible */}
      <div className={`fixed bottom-6 left-1/2 -translate-x-1/2 flex items-center gap-2.5 px-4 py-2.5 rounded-full bg-zinc-900 text-white text-sm shadow-lg transition-all duration-300 ${cardOpacity < 1 ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4 pointer-events-none"}`}>
        <div className="flex gap-1">
          {[0,1,2].map(i => (
            <div key={i} className="w-1.5 h-1.5 bg-white rounded-full animate-bounce" style={{ animationDelay: `${i * 0.15}s` }} />
          ))}
        </div>
        LLM is thinking…
      </div>

      {/* Reveal modal */}
      {reveal && <RevealModal reveal={reveal} onDismiss={() => setReveal(null)} />}

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
