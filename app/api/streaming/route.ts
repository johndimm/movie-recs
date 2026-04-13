import { callLLM } from "../next-movie/llm";

export async function POST(request: Request) {
  const { title, year, llm = "deepseek" }: { title: string; year: number | null; llm: string } = await request.json();

  const yearStr = year ? ` (${year})` : "";
  const systemPrompt = `You answer questions about streaming availability in the US. Respond with ONLY a JSON array of service names — no explanation, no markdown. Use well-known short names: Netflix, Max, Hulu, Disney+, Apple TV+, Amazon Prime Video, Peacock, Paramount+, Tubi, Pluto TV. Return [] if the title is not on any major streaming service or if you are unsure.`;
  const userMessage = `What streaming services currently have "${title}"${yearStr} available to watch in the US?`;

  try {
    const text = await callLLM(llm, systemPrompt, userMessage);
    const clean = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
    const match = clean.match(/\[[\s\S]*\]/);
    const services: string[] = match ? JSON.parse(match[0]) : [];
    return Response.json({ services });
  } catch (err) {
    console.error("Streaming lookup failed:", err);
    return Response.json({ services: [] });
  }
}
