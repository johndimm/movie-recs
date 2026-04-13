"use client";

import { useState } from "react";

const PROMPT = `# Movie Recs — full spec

Build a Next.js 16 (App Router) web app called Movie Recs.
Use Tailwind CSS v4 for styling. All persistence in localStorage. No database.

## Core concept
TikTok-style taste calibration for movies and TV. The real goal is to surface
films the user has NOT seen but will love. Rating seen films is the training
signal; the watchlist of unseen-but-wanted titles is the actual product.

Each round:
1. The LLM picks a movie or TV title the user has not seen before, predicts
   the user's 0-100 rating, returns metadata as JSON.
2. The user rates it 0-100 with a slider (or marks it as unseen).
3. A reveal modal pops up showing: your score / AI score / error.
4. The next title loads automatically — no Next button.

## LLM API route  POST /api/next-movie
Request body: { history, skipped, mediaType, llm }
- history: array of { title, type, userRating, predictedRating, error }
- skipped: array of title strings (rated + unseen-marked)
- mediaType: "movie" | "tv" | "both"
- llm: "deepseek" | "claude" | "gpt-4o" | "gemini"

The LLM prompt instructs the model to return ONLY valid JSON:
{ title, type, year, director, predicted_rating, actors[], plot, rt_score }
type must be "movie" or "tv". rt_score is the Rotten Tomatoes % or null.
All string values must be on one line (no newlines inside JSON strings).

After getting the LLM response, parse it with a brace-depth walker that
collects all top-level JSON objects and takes the LAST one (some LLMs emit
reasoning text followed by a corrected JSON object). Sanitise literal newlines.

Fetch a poster via the Serper Images API:
  POST https://google.serper.dev/images
  query: "{title} {year} film official poster"  (include year to avoid wrong version)
Prefer portrait images. Upgrade http:// URLs to https:// before returning.

## Client-side duplicate prevention
Build an excluded Set from all rated titles + all skipped titles (lowercase).
After each LLM response, check client-side. If the title is in the excluded set,
retry — passing the duplicate back as an extra skip. Retry up to 8 times total.
Never show a title unless it is confirmed non-duplicate.
On failure, show a friendly error with a Retry button rather than crashing.

## Unseen titles — two kinds
"Want to watch" (green button):
- Accuracy score: 85/100 (LLM correctly found something appealing)
- Saves to watchlist with full metadata
- Triggers a streaming lookup (see below)
- Adds to skipped list (never shown again)

"Not interested" (neutral button):
- Accuracy score: 20/100 (LLM missed entirely)
- Does NOT save to watchlist
- Adds to skipped list

## Accuracy chart
Hand-rolled SVG, no library. Shows accuracy (100 - error) so up is always good.
- Blue vertical bars for rated titles
- Green diamonds at y=85 for "want to watch" events
- Red diamonds at y=20 for "not interested" events
- Indigo line = rolling average of last 5 decisions (NOT cumulative)
- Dashed reference lines at y=85 and y=20
- Label: "How well the AI knows your taste"

## Reveal modal
Immediately after submitting a rating, show a centered fixed modal (scale-in
animation, backdrop blur) with: Your score / AI score / Error in large type.
Auto-dismiss when the next card loads (or Escape / tap outside to close early).
If error === 0: gold gradient border, target emoji, random congratulatory message.

## Main card UI
Left side: poster (w-72, click to open full-screen lightbox, Escape to close).
Right side: type + year badge, RT badge (tomato if >=60%, skull otherwise), title,
director, cast, plot.

Below the info, two clearly labelled sections:
  Box 1 — "I've seen it — rate it": slider 0-100, large live number, Submit button.
  Box 2 — "Haven't seen it": "Want to watch" (green) | "Not interested" (grey).

While the LLM is fetching: dim the card to 45% opacity. Show a fixed pill at
bottom-center of the viewport: "LLM is thinking..." with bouncing dots.
On response: fade card to 0, swap content, fade back to 1.

Page max-width: max-w-3xl.

## Navigation
Shared sticky nav bar at the top of every page (via layout.tsx):
App | Watchlist (count badge) | Journal | Prompt
Active page is highlighted. All navigation stays in the same tab.

## Controls (below nav, above card)
Segmented control: Movies & TV | Movies | TV Series
When type changes, if the current card doesn't match, re-fetch immediately.

Segmented control for LLM: populated from GET /api/config which checks which
of DEEPSEEK_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY exist
in env and returns { llms: [{ id, label }] }. Only show if >1 key configured.

## Watchlist page  /watchlist
Shows all "want to watch" entries: poster (w-24), type+year, RT badge, title,
director, cast, plot, streaming pills (blue).
Remove button (x) per entry.

## Streaming lookup  POST /api/streaming
Request: { title, year, llm }
Prompt: "What streaming services currently have {title} ({year}) in the US?
Return ONLY a JSON array: ["Netflix", "Max", ...]. Return [] if unsure."
Called when "Want to watch" is clicked; result stored in the watchlist entry.

## Shared LLM caller  app/api/next-movie/llm.ts
export async function callLLM(llm, systemPrompt, userMessage): Promise<string>
Handles: deepseek (deepseek-chat), claude (claude-opus-4-6, anthropic-version header),
gpt-4o (openai), gemini (gemini-2.0-flash, key in query string).

Split the prompt into a stable systemPrompt (instructions, format rules, media constraint)
and a per-request userMessage (rating history + excluded titles list). This enables
Anthropic prompt caching: add header "anthropic-beta: prompt-caching-2024-07-31" and
wrap the system prompt as { type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }.
OpenAI automatically caches prompt prefixes ≥1024 tokens. Gemini uses the systemInstruction
field. DeepSeek uses the standard system/user message array.

## localStorage keys
movie-recs-history    — RatingEntry[]
movie-recs-skipped    — string[] (all excluded titles)
movie-recs-watchlist  — WatchlistEntry[]
movie-recs-notseen    — NotSeenEvent[] (for chart plotting)

## Required env vars
SERPER_API_KEY         — Serper Images API
DEEPSEEK_API_KEY       — DeepSeek (default LLM)
ANTHROPIC_API_KEY      — Claude (optional)
OPENAI_API_KEY         — GPT-4o (optional)
GEMINI_API_KEY         — Gemini (optional)`;

export default function PromptPage() {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    navigator.clipboard.writeText(PROMPT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <div className="min-h-screen bg-[#0f172a] py-12 px-6">
      <div style={{ maxWidth: 780, margin: "0 auto" }}>

        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.02em" }}>
            Reconstruction Prompt
          </h1>
          <p style={{ marginTop: 6, fontSize: "0.875rem", color: "#64748b" }}>
            Paste into any coding agent to rebuild a near-identical app from scratch.
          </p>
        </div>

        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
          <button
            onClick={copy}
            style={{
              background: copied ? "#166534" : "#334155",
              color: copied ? "#bbf7d0" : "#cbd5e1",
              border: "none",
              borderRadius: 8,
              padding: "6px 16px",
              fontSize: "0.8rem",
              cursor: "pointer",
              transition: "background 0.15s",
            }}
          >
            {copied ? "Copied!" : "Copy to clipboard"}
          </button>
        </div>

        <pre style={{
          background: "#1e293b",
          border: "1px solid #334155",
          borderRadius: 12,
          padding: "28px 32px",
          fontFamily: '"SF Mono","Fira Code",monospace',
          fontSize: "0.78rem",
          lineHeight: 1.8,
          whiteSpace: "pre-wrap",
          wordBreak: "break-word",
          color: "#e2e8f0",
        }}>
          {PROMPT.split("\n").map((line, i) =>
            line.startsWith("#") ? (
              <span key={i} style={{ color: "#64748b" }}>{line}{"\n"}</span>
            ) : (
              <span key={i}>{line}{"\n"}</span>
            )
          )}
        </pre>
      </div>
    </div>
  );
}
