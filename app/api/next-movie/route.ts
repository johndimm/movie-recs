export interface RatingEntry {
  title: string;
  type: "movie" | "tv";
  userRating: number;
  predictedRating: number;
}

export interface NextMovieResponse {
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

async function fetchPoster(title: string, type: "movie" | "tv", year: number | null): Promise<string | null> {
  const yearStr = year ? ` ${year}` : "";
  const query = `${title}${yearStr} ${type === "tv" ? "TV series" : "film"} official poster`;
  try {
    const res = await fetch("https://google.serper.dev/images", {
      method: "POST",
      headers: {
        "X-API-KEY": process.env.SERPER_API_KEY!,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ q: query, num: 3 }),
    });
    const data = await res.json() as { images?: { imageUrl: string; width?: number; height?: number }[] };
    const images = data.images ?? [];
    const portrait = images.find((img) => !img.width || !img.height || img.height >= img.width);
    const url = (portrait ?? images[0])?.imageUrl ?? null;
    // Upgrade http → https to avoid mixed-content blocks on HTTPS deployments
    return url ? url.replace(/^http:\/\//i, "https://") : null;
  } catch {
    return null;
  }
}

import { callLLM } from "./llm";

export async function POST(request: Request) {
  const {
    history,
    skipped = [],
    mediaType = "both",
    llm = "deepseek",
  }: { history: RatingEntry[]; skipped: string[]; mediaType: "movie" | "tv" | "both"; llm: string } = await request.json();

  const ratedTitles = history.map((h) => h.title);
  const allExcluded = [...ratedTitles, ...skipped];

  const historyText =
    history.length === 0
      ? "No ratings yet."
      : history
          .map((h) => `- "${h.title}" (${h.type}): user rated ${h.userRating}/100`)
          .join("\n");

  const seenText =
    allExcluded.length === 0
      ? "None yet."
      : allExcluded.map((t) => `"${t}"`).join(", ");

  const mediaConstraint =
    mediaType === "movie" ? "\nIMPORTANT: Pick only movies (not TV series). The \"type\" field must be \"movie\"." :
    mediaType === "tv"    ? "\nIMPORTANT: Pick only TV series (not movies). The \"type\" field must be \"tv\"." :
    "";

  // Stable instructions → system prompt (cacheable).
  // Session-specific data (history + excluded list) → user message.
  const systemPrompt = `You are calibrating a movie/TV recommendation system to a specific user's taste.

Your job each turn:
1. Pick a title the user has NOT already seen
2. Predict the rating they would give it (0-100) based on their history
3. Return title, year, director, top 3-4 actors, a 1-2 sentence plot summary, and the Rotten Tomatoes Tomatometer score
4. Respond with ONLY valid JSON — no markdown, no explanation:
{"title": "...", "type": "movie", "year": 1994, "director": "Frank Darabont", "predicted_rating": 75, "actors": ["Actor One", "Actor Two", "Actor Three"], "plot": "Brief summary.", "rt_score": "94%"}

Rules:
- "type" must be exactly "movie" or "tv"
- "year" is a number; "director" is the creator/showrunner for TV
- "rt_score" is the Tomatometer percentage (e.g. "94%") or null if unknown
- All string values must be on a single line — no newline characters inside strings
- Predict honestly based on taste patterns — don't always guess 70
- Vary picks across genres, eras, and types to calibrate faster${mediaConstraint}`;

  const userMessage = `User's rating history:
${historyText}

Titles already seen — DO NOT pick any of these:
${seenText}

${history.length === 0
  ? "No history yet — pick a well-known, widely-seen film to start learning preferences."
  : "Analyze the patterns above and pick a title that will either confirm or usefully challenge your model of their taste."}`;

  let text: string;
  try {
    text = await callLLM(llm, systemPrompt, userMessage);
  } catch (err) {
    console.error("LLM call failed:", err);
    return Response.json({ error: String(err) }, { status: 500 });
  }

  // Strip markdown fences
  let jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();

  // Walk brace depth to collect all top-level JSON objects; take the last one
  const candidates: string[] = [];
  let depth = 0, start = -1;
  for (let i = 0; i < jsonText.length; i++) {
    const ch = jsonText[i];
    if (ch === "{") { if (depth === 0) start = i; depth++; }
    else if (ch === "}") { depth--; if (depth === 0 && start !== -1) { candidates.push(jsonText.slice(start, i + 1)); start = -1; } }
  }
  if (candidates.length > 0) jsonText = candidates[candidates.length - 1];

  // Replace literal newlines inside strings (invalid JSON)
  jsonText = jsonText.replace(/[\r\n]+/g, " ");

  let raw: {
    title: string;
    type: "movie" | "tv";
    year: number | null;
    director: string | null;
    predicted_rating: number;
    actors: string[];
    plot: string;
    rt_score: string | null;
  };

  try {
    raw = JSON.parse(jsonText);
  } catch {
    console.error("Failed to parse LLM response:", text);
    return Response.json({ error: "Failed to parse response", raw: text }, { status: 500 });
  }

  if (!raw.title || !raw.type) {
    console.error("LLM response missing required fields:", raw);
    return Response.json({ error: "Missing required fields", raw }, { status: 500 });
  }

  const posterUrl = await fetchPoster(raw.title, raw.type, raw.year ?? null);

  const result: NextMovieResponse = {
    title: raw.title,
    type: raw.type,
    year: raw.year ?? null,
    director: raw.director ?? null,
    predictedRating: raw.predicted_rating,
    actors: raw.actors ?? [],
    plot: raw.plot ?? "",
    posterUrl,
    rtScore: raw.rt_score ?? null,
  };

  return Response.json(result);
}
