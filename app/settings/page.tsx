"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { ALL_CHANNEL, ACTIVE_CHANNEL_KEY, CHANNELS_KEY } from "../channels/page";
import {
  clearAllPrefetchQueueKeys,
  isPrefetchQueueStorageKey,
  listPrefetchQueueStorageKeys,
} from "../lib/storageKeys";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { mergeFactoryChannelsAndQueues } from "../lib/factoryChannels";

export const SETTINGS_KEY = "movie-recs-settings";

export const CHANNEL_EXPORT_KEYS = [CHANNELS_KEY, ACTIVE_CHANNEL_KEY] as const;

export type TrailerVisionExportV1 = {
  version: 1;
  exportedAt: string;
  /** Which sections were requested when exporting (for your notes). */
  options: { channels: boolean; queue: boolean; history: boolean };
  data: Record<string, unknown>;
};

export interface AppSettings {
  mediaType: "both" | "movie" | "tv";
  displayMode: "trailers" | "posters";
  llm: string;
  userRequest: string;
}

export const DEFAULT_SETTINGS: AppSettings = {
  mediaType: "both",
  displayMode: "trailers",
  llm: "deepseek",
  userRequest: "",
};

export function loadSettings(): AppSettings {
  if (typeof window === "undefined") return DEFAULT_SETTINGS;
  try {
    const s = localStorage.getItem(SETTINGS_KEY);
    return s ? { ...DEFAULT_SETTINGS, ...JSON.parse(s) } : DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

const DATA_KEYS = [
  "movie-recs-history",
  "movie-recs-skipped",
  "movie-recs-passed",
  "movie-recs-notseen",
  "movie-recs-unseen-interest-log",
  "movie-recs-watchlist",
  "movie-recs-not-interested",
  "movie-recs-taste-summary",
  "movie-recs-llm-session-id",
  "movie-recs-llm-history-synced",
];

/** Keys included when "History & related" export is checked. */
export const HISTORY_EXPORT_KEYS = [...DATA_KEYS] as const;

const IMPORT_BASE_KEYS = new Set<string>([
  ...CHANNEL_EXPORT_KEYS,
  ...HISTORY_EXPORT_KEYS,
]);

function importKeyAllowed(k: string): boolean {
  return IMPORT_BASE_KEYS.has(k) || isPrefetchQueueStorageKey(k);
}

export default function SettingsPage() {
  const router = useRouter();
  const importRef = useRef<HTMLInputElement>(null);
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [availableLlms, setAvailableLlms] = useState<{ id: string; label: string }[]>([]);
  const [saved, setSaved] = useState(false);
  const [exportChannels, setExportChannels] = useState(true);
  const [exportQueue, setExportQueue] = useState(true);
  const [exportHistory, setExportHistory] = useState(true);
  const [importAlert, setImportAlert] = useState<string | null>(null);
  const [importConfirm, setImportConfirm] = useState<{
    message: string;
    apply: () => void;
  } | null>(null);
  const [resetOpen, setResetOpen] = useState(false);
  const [factoryMergeNote, setFactoryMergeNote] = useState<string | null>(null);

  useEffect(() => {
    queueMicrotask(() => setSettings(loadSettings()));
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json())
      .then((d: { llms: { id: string; label: string }[] }) => {
        setAvailableLlms(d.llms);
      })
      .catch(() => {});
  }, []);

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const next = { ...settings, [key]: value };
    setSettings(next);
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const runExport = () => {
    const data: Record<string, unknown> = {};
    const keys: string[] = [];
    if (exportChannels) keys.push(...CHANNEL_EXPORT_KEYS);
    if (exportQueue) {
      for (const k of listPrefetchQueueStorageKeys()) {
        if (!keys.includes(k)) keys.push(k);
      }
    }
    if (exportHistory) keys.push(...HISTORY_EXPORT_KEYS);
    for (const k of keys) {
      const raw = localStorage.getItem(k);
      if (raw === null) continue;
      try {
        data[k] = JSON.parse(raw) as unknown;
      } catch {
        data[k] = raw;
      }
    }
    const payload: TrailerVisionExportV1 = {
      version: 1,
      exportedAt: new Date().toISOString(),
      options: { channels: exportChannels, queue: exportQueue, history: exportHistory },
      data,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trailer-vision-export-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const runImport = (file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result as string) as { version?: number; data?: Record<string, unknown> };
        if (parsed.version !== 1 || !parsed.data || typeof parsed.data !== "object") {
          setImportAlert("That file is not a valid Trailer Vision export (expected version 1).");
          return;
        }
        const entries = Object.entries(parsed.data).filter(([k]) => importKeyAllowed(k));
        if (entries.length === 0) {
          setImportAlert("No recognized keys in that file.");
          return;
        }
        const keyList = entries.map(([k]) => k).join(", ");
        setImportConfirm({
          message: `Replace ${entries.length} saved item(s) in this browser?\n\nKeys: ${keyList}`,
          apply: () => {
            for (const [k, v] of entries) {
              if (v === null || v === undefined) {
                localStorage.removeItem(k);
                continue;
              }
              localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
            }
            window.location.href = "/";
          },
        });
      } catch {
        setImportAlert("Could not read that JSON file.");
      }
    };
    reader.readAsText(file);
  };

  return (
    <>
    <ConfirmDialog
      open={importAlert !== null}
      title="Import"
      showCancel={false}
      confirmLabel="OK"
      onConfirm={() => setImportAlert(null)}
      onCancel={() => setImportAlert(null)}
    >
      {importAlert}
    </ConfirmDialog>
    <ConfirmDialog
      open={importConfirm !== null}
      title="Import backup"
      tone="danger"
      confirmLabel="Replace"
      cancelLabel="Cancel"
      onCancel={() => setImportConfirm(null)}
      onConfirm={() => {
        importConfirm?.apply();
      }}
    >
      {importConfirm !== null && (
        <p className="whitespace-pre-wrap break-words text-sm">{importConfirm.message}</p>
      )}
    </ConfirmDialog>
    <ConfirmDialog
      open={resetOpen}
      title="Reset all data"
      tone="danger"
      confirmLabel="Reset everything"
      cancelLabel="Cancel"
      onCancel={() => setResetOpen(false)}
      onConfirm={() => {
        DATA_KEYS.forEach((k) => localStorage.removeItem(k));
        clearAllPrefetchQueueKeys();
        localStorage.setItem(CHANNELS_KEY, JSON.stringify([ALL_CHANNEL]));
        localStorage.setItem(ACTIVE_CHANNEL_KEY, "all");
        setResetOpen(false);
        router.push("/");
      }}
    >
      Clear all ratings, watchlist, taste history, and custom channels? This cannot be undone.
    </ConfirmDialog>
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-6 sm:py-10 px-4">
      <div className="w-full max-w-3xl space-y-6">

        <div className="flex items-center justify-between">
          <h1 className="text-xl font-bold text-zinc-900">Settings</h1>
          {saved && <span className="text-xs text-green-600 font-medium">Saved</span>}
        </div>

        <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm divide-y divide-zinc-100">

          {/* Media type */}
          <div className="px-4 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-zinc-800">Content type</p>
              <p className="text-xs text-zinc-400 mt-0.5">Show movies, TV series, or both</p>
            </div>
            <div className="flex rounded-xl border border-zinc-200 bg-zinc-50 overflow-hidden text-sm">
              {(["both", "movie", "tv"] as const).map((opt) => (
                <button
                  key={opt}
                  onClick={() => update("mediaType", opt)}
                  className={`px-3 py-1.5 font-medium transition-colors ${
                    settings.mediaType === opt
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-500 hover:bg-zinc-100"
                  }`}
                >
                  {opt === "both" ? "Movies & TV" : opt === "movie" ? "Movies" : "TV Series"}
                </button>
              ))}
            </div>
          </div>

          {/* Display mode */}
          <div className="px-4 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-zinc-800">Display mode</p>
              <p className="text-xs text-zinc-400 mt-0.5">Watch trailers or browse posters</p>
            </div>
            <div className="flex rounded-xl border border-zinc-200 bg-zinc-50 overflow-hidden text-sm">
              {(["trailers", "posters"] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={() => update("displayMode", mode)}
                  className={`px-3 py-1.5 font-medium capitalize transition-colors ${
                    settings.displayMode === mode
                      ? "bg-zinc-900 text-white"
                      : "text-zinc-500 hover:bg-zinc-100"
                  }`}
                >
                  {mode}
                </button>
              ))}
            </div>
          </div>

          {/* LLM selector */}
          {availableLlms.length > 1 && (
            <div className="px-4 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
              <div className="flex-1">
                <p className="text-sm font-medium text-zinc-800">AI model</p>
                <p className="text-xs text-zinc-400 mt-0.5">Which LLM generates recommendations</p>
              </div>
              <div className="flex rounded-xl border border-zinc-200 bg-zinc-50 overflow-hidden text-sm">
                {availableLlms.map((l) => (
                  <button
                    key={l.id}
                    onClick={() => update("llm", l.id)}
                    className={`px-3 py-1.5 font-medium transition-colors ${
                      settings.llm === l.id
                        ? "bg-indigo-600 text-white"
                        : "text-zinc-500 hover:bg-zinc-100"
                    }`}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Global request */}
          <div className="px-4 py-4 flex flex-col gap-3">
            <div>
              <p className="text-sm font-medium text-zinc-800">Global request</p>
              <p className="text-xs text-zinc-400 mt-0.5">LLM instructions that apply to all channels. Stacks on top of any active channel&apos;s settings.</p>
            </div>
            <div className="flex items-start gap-2">
              <textarea
                rows={3}
                value={settings.userRequest}
                onChange={(e) => update("userRequest", e.target.value)}
                placeholder='e.g. "Only suggest films I can watch with my kids" or "Prioritize films with strong female leads"'
                className="flex-1 rounded-xl border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700 placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-indigo-300 resize-none"
              />
              {settings.userRequest && (
                <button
                  onClick={() => update("userRequest", "")}
                  className="text-zinc-400 hover:text-zinc-600 text-lg leading-none mt-1"
                  title="Clear"
                >
                  ×
                </button>
              )}
            </div>
            {settings.userRequest && (
              <p className="text-xs text-amber-600">
                Active — applied to every recommendation regardless of channel.
              </p>
            )}
          </div>

        </div>

        {/* Backup */}
        <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-4 space-y-4">
          <div>
            <p className="text-sm font-medium text-zinc-800">Export backup</p>
            <p className="text-xs text-zinc-400 mt-0.5">
              Download a JSON file. Choose which parts to include — uncheck anything you don&apos;t want in the file.
            </p>
          </div>
          <div className="flex flex-col gap-2 text-sm text-zinc-700">
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={exportChannels} onChange={(e) => setExportChannels(e.target.checked)} className="rounded border-zinc-300" />
              Channel definitions + active channel
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={exportQueue} onChange={(e) => setExportQueue(e.target.checked)} className="rounded border-zinc-300" />
              Prefetch queues (pre-loaded title cards per channel from the main page)
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input type="checkbox" checked={exportHistory} onChange={(e) => setExportHistory(e.target.checked)} className="rounded border-zinc-300" />
              History &amp; related (ratings, skipped, passed, chart events, watchlist, not-interested, taste summary, LLM session sync)
            </label>
          </div>
          <button
            type="button"
            onClick={runExport}
            className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-sm font-medium hover:bg-zinc-800 transition-colors w-fit"
          >
            Download JSON
          </button>

          <div className="border-t border-zinc-100 pt-4">
            <p className="text-sm font-medium text-zinc-800">Import backup</p>
            <p className="text-xs text-zinc-400 mt-0.5">
              Import a previously exported JSON file. Each key in the file overwrites the same key in this browser; other keys are left as-is. You will be sent to the home page to reload.
            </p>
            <input ref={importRef} type="file" accept="application/json,.json" className="hidden" onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) runImport(f);
            }} />
            <button
              type="button"
              onClick={() => importRef.current?.click()}
              className="mt-2 px-4 py-2 rounded-lg border border-zinc-200 bg-white text-zinc-800 text-sm font-medium hover:bg-zinc-50 transition-colors"
            >
              Choose file…
            </button>
          </div>

          <div className="border-t border-zinc-100 pt-4">
            <p className="text-sm font-medium text-zinc-800">Starter channel pack</p>
            <p className="text-xs text-zinc-400 mt-0.5">
              Add any bundled example channels you don&apos;t already have (matched by id). Empty prefetch queues are filled from the bundle; existing channels and queues are never removed or overwritten.
            </p>
            {factoryMergeNote && (
              <p className="text-xs text-green-700 font-medium mt-2" role="status">
                {factoryMergeNote}
              </p>
            )}
            <button
              type="button"
              onClick={() => {
                const { addedChannels, filledPrefetchQueues } = mergeFactoryChannelsAndQueues();
                const parts: string[] = [];
                if (addedChannels > 0) parts.push(`Added ${addedChannels} channel${addedChannels === 1 ? "" : "s"}.`);
                else parts.push("No new channels to add (you already have this set).");
                if (filledPrefetchQueues > 0) {
                  parts.push(`Filled ${filledPrefetchQueues} empty prefetch queue${filledPrefetchQueues === 1 ? "" : "s"}.`);
                }
                setFactoryMergeNote(parts.join(" "));
                setTimeout(() => setFactoryMergeNote(null), 8000);
              }}
              className="mt-2 px-4 py-2 rounded-lg border border-zinc-200 bg-white text-zinc-800 text-sm font-medium hover:bg-zinc-50 transition-colors"
            >
              Merge starter channels
            </button>
          </div>
        </div>

        {/* Danger zone */}
        <div className="bg-white rounded-2xl border border-zinc-200 shadow-sm divide-y divide-zinc-100">
          <div className="px-4 py-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <div className="flex-1">
              <p className="text-sm font-medium text-zinc-800">Reset all data</p>
              <p className="text-xs text-zinc-400 mt-0.5">Clears all ratings, watchlist, taste history, and custom channels (keeps &quot;All&quot;). Cannot be undone.</p>
            </div>
            <button
              type="button"
              onClick={() => setResetOpen(true)}
              className="px-4 py-1.5 rounded-lg border border-red-200 text-red-600 text-sm font-medium hover:bg-red-50 transition-colors"
            >
              Reset
            </button>
          </div>
        </div>

        <p className="text-xs text-zinc-400 text-center">Settings are saved instantly and take effect on your next visit to the main page.</p>
      </div>
    </div>
    </>
  );
}
