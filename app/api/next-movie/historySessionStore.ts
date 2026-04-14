/** Same shape as RatingEntry in route.ts — kept here to avoid circular imports */
export interface SessionRatingEntry {
  title: string;
  type: "movie" | "tv";
  userRating: number;
  predictedRating: number;
  error?: number;
  rtScore?: string | null;
}

type SessionData = { history: SessionRatingEntry[]; updatedAt: number };

const TTL_MS = 24 * 60 * 60 * 1000;
const MAX_SESSIONS = 2000;

function sessions(): Map<string, SessionData> {
  const g = globalThis as unknown as { __movieRecsRatingSessions?: Map<string, SessionData> };
  if (!g.__movieRecsRatingSessions) g.__movieRecsRatingSessions = new Map();
  return g.__movieRecsRatingSessions;
}

function prune(now: number) {
  const map = sessions();
  for (const [id, v] of map) {
    if (now - v.updatedAt > TTL_MS) map.delete(id);
  }
  if (map.size <= MAX_SESSIONS) return;
  const entries = [...map.entries()].sort((a, b) => a[1].updatedAt - b[1].updatedAt);
  while (map.size > MAX_SESSIONS && entries.length) {
    const [id] = entries.shift()!;
    map.delete(id);
  }
}

export function getSessionHistory(sessionId: string): SessionRatingEntry[] | null {
  const map = sessions();
  const d = map.get(sessionId);
  if (!d) return null;
  if (Date.now() - d.updatedAt > TTL_MS) {
    map.delete(sessionId);
    return null;
  }
  return d.history;
}

function saveSession(sessionId: string, history: SessionRatingEntry[]) {
  const now = Date.now();
  prune(now);
  sessions().set(sessionId, { history, updatedAt: now });
}

export type MergeResult =
  | { ok: true; history: SessionRatingEntry[] }
  | { ok: false; reason: "unknown_session" | "base_mismatch" };

/** Applies history sync from the client into a full rating list for the LLM. */
export function resolveHistoryForPrompt(
  sessionId: string | undefined,
  sync: "full" | "delta" | "reuse" | undefined,
  body: {
    history?: SessionRatingEntry[];
    baseLength?: number;
    historyAppend?: SessionRatingEntry[];
  }
): MergeResult {
  const mode = sync ?? "full";

  if (!sessionId || mode === "full") {
    const history = body.history ?? [];
    if (sessionId) saveSession(sessionId, history);
    return { ok: true, history };
  }

  const prev = getSessionHistory(sessionId);
  if (!prev) return { ok: false, reason: "unknown_session" };

  if (mode === "reuse") {
    if (body.baseLength !== prev.length) return { ok: false, reason: "base_mismatch" };
    saveSession(sessionId, prev);
    return { ok: true, history: prev };
  }

  /* delta */
  if (body.baseLength !== prev.length || !body.historyAppend) {
    return { ok: false, reason: "base_mismatch" };
  }

  const next = [...prev, ...body.historyAppend];
  saveSession(sessionId, next);
  return { ok: true, history: next };
}
