export async function GET() {
  const llms: { id: string; label: string }[] = [];

  if (process.env.DEEPSEEK_API_KEY)   llms.push({ id: "deepseek",   label: "DeepSeek" });
  if (process.env.ANTHROPIC_API_KEY)  llms.push({ id: "claude",     label: "Claude (Anthropic)" });
  if (process.env.OPENAI_API_KEY)     llms.push({ id: "gpt-4o",     label: "GPT-4o (OpenAI)" });
  if (process.env.GEMINI_API_KEY)     llms.push({ id: "gemini",     label: "Gemini (Google)" });

  return Response.json({ llms });
}
