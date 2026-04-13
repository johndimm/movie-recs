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
    return (portrait ?? images[0])?.imageUrl ?? null;
  } catch {
    return null;
  }
}

async function callLLM(llm: string, prompt: string): Promise<string> {
  if (llm === "deepseek") {
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({ model: "deepseek-chat", max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(e)}`); }
    const d = await res.json() as { choices: { message: { content: string } }[] };
    return d.choices?.[0]?.message?.content?.trim() ?? "";
  }

  if (llm === "claude") {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({ model: "claude-opus-4-6", max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`Claude ${res.status}: ${JSON.stringify(e)}`); }
    const d = await res.json() as { content: { type: string; text: string }[] };
    return d.content?.[0]?.text?.trim() ?? "";
  }

  if (llm === "gpt-4o") {
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({ model: "gpt-4o", max_tokens: 1024, messages: [{ role: "user", content: prompt }] }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`OpenAI ${res.status}: ${JSON.stringify(e)}`); }
    const d = await res.json() as { choices: { message: { content: string } }[] };
    return d.choices?.[0]?.message?.content?.trim() ?? "";
  }

  if (llm === "gemini") {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`Gemini ${res.status}: ${JSON.stringify(e)}`); }
    const d = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] };
    return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  }

  throw new Error(`Unknown LLM: ${llm}`);
}

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

  const prompt = `You are helping calibrate a movie/TV recommendation system. Your job is to:
1. Select a movie or TV series title that the user has NOT already rated
2. Predict what rating the user would give it on a 0-100 scale based on their taste
3. Provide a brief plot summary and the top 3-4 main actors/cast members
4. Include the Rotten Tomatoes Tomatometer score if you know it (e.g. "94%"), or null if unsure

User's rating history:
${historyText}

Titles already seen (DO NOT pick any of these):
${seenText}

Instructions:
- If no history, pick a well-known, widely-seen film to start learning preferences
- If there is history, analyze the patterns and pick something that will either confirm or challenge your model of their taste
- Predict the rating honestly based on the pattern — don't just guess 70 every time
- Vary your picks across genres, eras, and types (movie vs TV) to learn preferences faster${mediaConstraint}

Respond with ONLY valid JSON, no markdown, no explanation:
{"title": "...", "type": "movie", "year": 1994, "director": "Frank Darabont", "predicted_rating": 75, "actors": ["Actor One", "Actor Two", "Actor Three"], "plot": "A brief 1-2 sentence plot summary.", "rt_score": "94%"}

The "type" field must be exactly "movie" or "tv". "year" is the release year as a number. For TV series, "director" is the creator/showrunner. Set "rt_score" to null if you don't know it. All string values must be on a single line with no newline characters.`;

  let text: string;
  try {
    text = await callLLM(llm, prompt);
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
