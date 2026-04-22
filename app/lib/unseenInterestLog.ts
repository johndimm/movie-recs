export { canonicalTitleKey } from "./canonicalTitleKey";

export const UNSEEN_INTEREST_LOG_KEY = "movie-recs-unseen-interest-log";

export type UnseenInterestEntry = {
  title: string;
  type: "movie" | "tv";
  year: number | null;
  director: string | null;
  actors: string[];
  plot: string;
  posterUrl: string | null;
  rtScore: string | null;
  interestStars: number;
  kind: "want" | "skip";
  channelId: string;
  at: string;
};

function isValidEntry(x: unknown): x is UnseenInterestEntry {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (typeof o.title !== "string" || !o.title) return false;
  if (o.type !== "movie" && o.type !== "tv") return false;
  if (typeof o.interestStars !== "number" || !Number.isFinite(o.interestStars)) return false;
  if (o.kind !== "want" && o.kind !== "skip") return false;
  if (typeof o.at !== "string") return false;
  if (typeof o.channelId !== "string") return false;
  return true;
}

export function loadUnseenInterestLog(): UnseenInterestEntry[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(UNSEEN_INTEREST_LOG_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isValidEntry);
  } catch {
    return [];
  }
}

export function pushUnseenInterestEntry(entry: UnseenInterestEntry): void {
  const cur = loadUnseenInterestLog();
  cur.push(entry);
  localStorage.setItem(UNSEEN_INTEREST_LOG_KEY, JSON.stringify(cur));
}

export function entryMatchesChannel(entry: UnseenInterestEntry, channelId: string): boolean {
  if (channelId === "all") return !entry.channelId || entry.channelId === "all";
  return entry.channelId === channelId;
}
