export async function callLLM(
  llm: string,
  systemPrompt: string,
  userMessage: string,
  opts?: { maxTokens?: number }
): Promise<string> {
  const maxTokens = opts?.maxTokens ?? 1024;
  if (llm === "deepseek") {
    // API cap: "valid range of max_tokens is [1, 8192]"
    const deepseekMax = Math.min(maxTokens, 8192);
    const res = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        max_tokens: deepseekMax,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userMessage },
        ],
      }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`DeepSeek ${res.status}: ${JSON.stringify(e)}`); }
    const d = await res.json() as { choices: { message: { content: string } }[] };
    return d.choices?.[0]?.message?.content?.trim() ?? "";
  }

  if (llm === "claude") {
    // Use Anthropic's prompt caching on the system prompt — the instructions are
    // stable across requests; only the user message (history + excluded list) changes.
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY!,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "prompt-caching-2024-07-31",
      },
      body: JSON.stringify({
        model: "claude-opus-4-6",
        max_tokens: maxTokens,
        system: [
          {
            type: "text",
            text: systemPrompt,
            cache_control: { type: "ephemeral" },
          },
        ],
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`Claude ${res.status}: ${JSON.stringify(e)}`); }
    const d = await res.json() as { content: { type: string; text: string }[] };
    return d.content?.[0]?.text?.trim() ?? "";
  }

  if (llm === "gpt-4o") {
    // OpenAI automatically caches prompt prefixes ≥1024 tokens; no explicit opt-in needed.
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4o",
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user",   content: userMessage },
        ],
      }),
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
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: "user", parts: [{ text: userMessage }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    });
    if (!res.ok) { const e = await res.json().catch(() => ({})); throw new Error(`Gemini ${res.status}: ${JSON.stringify(e)}`); }
    const d = await res.json() as { candidates: { content: { parts: { text: string }[] } }[] };
    return d.candidates?.[0]?.content?.parts?.[0]?.text?.trim() ?? "";
  }

  throw new Error(`Unknown LLM: ${llm}`);
}
