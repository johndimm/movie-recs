export const NEW_CHANNEL_PREFILL_KEY = "movie-recs-new-channel-prefill";

/** Channel fields without `id` — same shape as `Omit<Channel, "id">` in `app/channels/page.tsx`. */
export type NewChannelData = {
  name: string;
  mediums: ("movie" | "tv")[];
  genres: string[];
  timePeriods: string[];
  language: string;
  artists: string;
  freeText: string;
  popularity: number;
};

const emptyData = (): NewChannelData => ({
  name: "",
  mediums: [],
  genres: [],
  timePeriods: [],
  language: "",
  artists: "",
  freeText: "",
  popularity: 50,
});

/** Build channel fields from a free-text prompt (first line → short name, full text → “What you want”). */
export function channelDraftFromPrompt(raw: string): NewChannelData {
  const t = raw.trim();
  if (!t) {
    return { ...emptyData(), name: "New channel" };
  }
  const firstLine = t.split("\n").map((s) => s.trim()).find((line) => line.length > 0) ?? t;
  const name = firstLine.length > 56 ? `${firstLine.slice(0, 53).trimEnd()}…` : firstLine;
  return {
    name: name || "New channel",
    mediums: [],
    genres: [],
    timePeriods: [],
    language: "",
    artists: "",
    freeText: t,
    popularity: 50,
  };
}

/** Safe merge for hydrating the new-channel form from sessionStorage. */
export function mergeNewChannelFormPrefill(partial: unknown): NewChannelData {
  if (!partial || typeof partial !== "object") return emptyData();
  const p = partial as Record<string, unknown>;
  const mediums: ("movie" | "tv")[] = [];
  if (Array.isArray(p.mediums)) {
    for (const x of p.mediums) {
      if (x === "movie" || x === "tv") mediums.push(x);
    }
  }
  return {
    ...emptyData(),
    name: typeof p.name === "string" ? p.name : "",
    freeText: typeof p.freeText === "string" ? p.freeText : "",
    genres: Array.isArray(p.genres) ? p.genres.filter((g): g is string => typeof g === "string") : [],
    timePeriods: Array.isArray(p.timePeriods) ? p.timePeriods.filter((g): g is string => typeof g === "string") : [],
    language: typeof p.language === "string" ? p.language : "",
    artists: typeof p.artists === "string" ? p.artists : "",
    mediums,
    popularity:
      typeof p.popularity === "number" && !Number.isNaN(p.popularity) ? p.popularity : 50,
  };
}
