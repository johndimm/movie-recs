import factoryJson from "../../factory-channels.json";
import { isPrefetchQueueStorageKey } from "./storageKeys";

const CHANNELS_KEY = "movie-recs-channels";

const DEFAULT_ALL = {
  id: "all",
  name: "All",
  mediums: [] as string[],
  genres: [] as string[],
  timePeriods: [] as string[],
  language: "",
  artists: "",
  freeText: "",
  popularity: 50,
};

type ChannelRow = typeof DEFAULT_ALL;

function parseChannels(raw: unknown): ChannelRow[] {
  if (!Array.isArray(raw)) return [];
  return raw as ChannelRow[];
}

function prefetchKeyChannelId(key: string): string | null {
  if (!isPrefetchQueueStorageKey(key)) return null;
  const prefix = "movie-recs-prefetch-queue:";
  if (!key.startsWith(prefix)) return null;
  const id = key.slice(prefix.length).trim();
  return id.length > 0 ? id : null;
}

/** True when this browser has never stored a channel list (first visit). */
export function hasNoChannelsPersisted(): boolean {
  if (typeof window === "undefined") return false;
  return localStorage.getItem(CHANNELS_KEY) === null;
}

/** Apply bundled export (channels, active channel, prefetch queues, etc.). Call only when `hasNoChannelsPersisted()`. */
export function applyFactoryBootstrap(): void {
  const data = factoryJson.data;
  if (!data || typeof data !== "object") return;
  for (const [k, v] of Object.entries(data)) {
    if (v === null || v === undefined) {
      localStorage.removeItem(k);
      continue;
    }
    localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
  }
}

type FactoryMergeResult = { addedChannels: number; filledPrefetchQueues: number };

type FactoryMergePlan = FactoryMergeResult & { merged: ChannelRow[]; data: Record<string, unknown> };

function computeFactoryMergePlan(): FactoryMergePlan | null {
  const data = factoryJson.data;
  if (!data || typeof data !== "object") return null;
  const dataObj = data as Record<string, unknown>;

  const factoryChannels = parseChannels(dataObj[CHANNELS_KEY]);
  const stored = localStorage.getItem(CHANNELS_KEY);
  let existing = stored ? parseChannels(JSON.parse(stored)) : [];
  if (!existing.some((c) => c.id === "all")) {
    existing = [DEFAULT_ALL, ...existing];
  }
  const allRow = existing.find((c) => c.id === "all") ?? DEFAULT_ALL;
  const nonAllExisting = existing.filter((c) => c.id !== "all");
  const existingIds = new Set(nonAllExisting.map((c) => c.id));

  const toAdd = factoryChannels.filter(
    (c) => c.id !== "all" && typeof c.name === "string" && c.name.trim() && !existingIds.has(c.id),
  );

  const merged = [allRow, ...nonAllExisting, ...toAdd];
  const mergedIds = new Set(merged.map((c) => c.id));
  let filledPrefetchQueues = 0;
  for (const [k, v] of Object.entries(dataObj)) {
    if (!isPrefetchQueueStorageKey(k)) continue;
    const chId = prefetchKeyChannelId(k);
    if (chId === null || (chId !== "all" && !mergedIds.has(chId))) continue;
    if (localStorage.getItem(k) !== null) continue;
    if (v === null || v === undefined) continue;
    filledPrefetchQueues++;
  }

  return {
    merged,
    data: dataObj,
    addedChannels: toAdd.length,
    filledPrefetchQueues,
  };
}

/**
 * True when a merge would not add channels or fill any empty prefetch keys (read-only; browser only).
 * Server / no window: treated as “complete” so UI does not show the action.
 */
export function isFactoryStarterPackFullyMerged(): boolean {
  if (typeof window === "undefined") return true;
  const p = computeFactoryMergePlan();
  if (!p) return true;
  return p.addedChannels === 0 && p.filledPrefetchQueues === 0;
}

/**
 * Append any bundled channels (by id) that are not already present; fill empty prefetch queues
 * only for channel ids that exist after merge. Does not remove channels or overwrite non-empty queues.
 */
export function mergeFactoryChannelsAndQueues(): FactoryMergeResult {
  if (typeof window === "undefined") return { addedChannels: 0, filledPrefetchQueues: 0 };
  const plan = computeFactoryMergePlan();
  if (!plan) return { addedChannels: 0, filledPrefetchQueues: 0 };

  localStorage.setItem(CHANNELS_KEY, JSON.stringify(plan.merged));
  const mergedIds = new Set(plan.merged.map((c) => c.id));
  for (const [k, v] of Object.entries(plan.data)) {
    if (!isPrefetchQueueStorageKey(k)) continue;
    const chId = prefetchKeyChannelId(k);
    if (chId === null || (chId !== "all" && !mergedIds.has(chId))) continue;
    if (localStorage.getItem(k) !== null) continue;
    if (v === null || v === undefined) continue;
    localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));
  }

  return { addedChannels: plan.addedChannels, filledPrefetchQueues: plan.filledPrefetchQueues };
}
