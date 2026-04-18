import { callLLM } from "../next-movie/llm";

export async function POST(request: Request) {
  const body = await request.json() as {
    genres?: string[];
    timePeriods?: string[];
    language?: string;
    freeText?: string;
    llm?: string;
  };

  const { genres = [], timePeriods = [], language = "", freeText = "", llm = "deepseek" } = body;

  const active = [
    genres.length > 0 && `genres: ${genres.join(", ")}`,
    timePeriods.length > 0 && `time periods: ${timePeriods.join(", ")}`,
    language && `language(s): ${language}`,
    freeText.trim() && `additional context: "${freeText.trim()}"`,
  ].filter(Boolean);

  if (active.length === 0) return Response.json({ artists: [] });

  const systemPrompt = `You are a film expert. Return ONLY valid JSON — no markdown, no explanation.`;

  const userMessage = `The user is building a film channel. Their current selections are: ${active.join("; ")}.

Suggest up to 20 notable directors and/or actors whose work fits this overall theme.

Return JSON: {"artists":["Name",...]}`;

  try {
    const text = await callLLM(llm, systemPrompt, userMessage, { maxTokens: 400 });
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return Response.json({ artists: [] });
    const parsed = JSON.parse(match[0]) as { artists?: unknown };
    const artists = Array.isArray(parsed.artists)
      ? parsed.artists.filter((a): a is string => typeof a === "string" && a.trim().length > 0)
      : [];
    return Response.json({ artists });
  } catch (e) {
    console.error("[suggest-artists] error:", e);
    return Response.json({ artists: [] }, { status: 500 });
  }
}
