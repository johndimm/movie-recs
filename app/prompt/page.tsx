"use client";

import { useState } from "react";

const NATURAL_PROMPT = `Build a web app for discovering movies and TV shows I'll love.

TikTok doesn't ask you what you like — it watches how you react and figures it out.
I want something like that for movies. Show me a title, I'll rate it 0–100, and you
reveal what you predicted. Over many rounds the AI should get better at knowing my taste.

The real goal isn't rating films I've already seen — it's finding films I haven't seen
but will love. The watchlist of "want to watch" titles is the actual product. Rating
seen films is just the training signal to get there.

Each round: show me a movie or TV title with its poster, director, cast, plot summary,
and Rotten Tomatoes score. If I've seen it, I rate it with a slider. If I haven't, I
can either save it to my watchlist (which means the AI got it right) or dismiss it
(which means the AI missed). Either way, that title never comes up again.

After I submit a rating, load the next title automatically — no Next button, keep it
moving. Show my score, the AI's prediction, and the error in the chart area.

Show an accuracy chart over time so I can see the AI improving. Rolling window, not
cumulative — I want to see recent performance, not a lifetime average dragged down by
early misses.

When I save something to my watchlist, also look up which streaming services have it
so I know where to watch it.

Let me filter to movies only, TV only, or both. Let me switch between different LLMs
(DeepSeek, Claude, GPT-4o, Gemini) if I have API keys for them, so I can compare how
well each one knows my taste.

Keep all data in localStorage — no accounts, no server database.`;

const PROMPT = `# Movie Recs — full spec

Build a Next.js 16 (App Router) web app called Movie Recs.
Use Tailwind CSS v4 for styling. All persistence in localStorage. No database.

## Core concept
TikTok-style taste calibration for movies and TV. The real goal is to surface
films the user has NOT seen but will love. Rating seen films is the training
signal; the watchlist of unseen-but-wanted titles is the actual product.

Each round:
1. The next card is served instantly from a prefetch queue (see below).
2. The user rates it 0-100 with a slider (or marks it as unseen).
3. The next title loads automatically — no Next button.
4. The last result (your score / AI score / error) is shown inline in the chart panel.

## LLM API route  POST /api/next-movie
Request body includes skipped, watchlistTitles, notInterestedItems, mediaType, llm, count? — always.

Rating history (server keeps a full copy in memory per sessionId so the client does not resend it every time):
- sessionId: UUID from localStorage; identifies an in-memory session on the server (TTL ~24h; lost on cold start)
- historySync: "full" | "delta" | "reuse"
  - full + history[]: replace session (first load, after reset, or resync after 409)
  - delta + baseLength + historyAppend: append when the user added ratings since last successful sync
  - reuse + baseLength: no new ratings; server uses stored list (skipped/watchlist still updated every request)
- Legacy: omit session fields and send history[] only — treated as full sync

Skipped: title strings from unseen flow (both "want to watch" and "not interested" append here)
watchlistTitles: array of { title, rtScore } (and notInterestedItems for high-RT dismissals) — unioned with rated titles and skipped for exclusion on the server.
- mediaType: "movie" | "tv" | "both"
- llm: "deepseek" | "claude" | "gpt-4o" | "gemini"
- count: optional number of titles to request in one generation (default ~24, max 28; limited so JSON fits model output caps)

The LLM user message is intentionally small: rated history is truncated to the highest |user−RT| divergence lines (fallback |user−AI| if no RT); want-to-watch lists only low-RT saves; not-interested lists only high-RT dismissals. Full exclusion title lists are not sent — counts only; the client dedupes.

One HTTP request asks the LLM for many titles at once. The model returns ONLY valid JSON:
{ "items": [ { title, type, year, director, predicted_rating, actors[], plot, rt_score }, ... ] }
type must be "movie" or "tv" on each item. rt_score is the Rotten Tomatoes % or null.
All string values must be on one line (no newlines inside JSON strings).

After the LLM responds, parse JSON (with fallbacks: top-level array, or legacy single-object).
Sanitise literal newlines in string fields when needed.

Response body: { movies: CurrentMovie[] } — one entry per accepted item (posters attached).

Fetch posters via the Serper Images API (one image request per item, in parallel):
  POST https://google.serper.dev/images
  query: "{title} {year} film official poster"  (include year to avoid wrong version)
Prefer portrait images. Upgrade http:// URLs to https:// before returning.

## Prefetch queue
Maintain a client-side prefetch queue (ref, not state) of pre-fetched CurrentMovie objects.
On advance, pop instantly from the queue; trigger a background replenish when remaining cards are at or below half the nominal LLM batch (~ceil(LLM_BATCH_SIZE/2)), so the next LLM request overlaps the user's pace. Up to two replenishes may run concurrently.
If the queue is empty, await the replenish before showing the next card.

Replenish issues a single POST /api/next-movie (LLM_BATCH_SIZE titles per call). The client
retries the POST once on failure. Titles returned by the model that are already excluded
(history + skipped + prefetch queue) are dropped; yield = freshAdded / LLM_BATCH_SIZE is
kept in a rolling window for diagnostics.

Limit to two in-flight replenishes (incrementing a counter); if both slots are busy, additional
replenish callers spin briefly until a slot frees so the empty-queue path never dead-locks.

On failure after all retries, show a friendly error pill with a Retry button.

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

## Main card UI
On mobile (< sm): poster stacks above metadata as a full-width banner (h-52, object-cover).
On sm+: poster (w-56) sits to the left of the metadata. Click poster for full-screen lightbox (Escape to close).
Right/below: type + year badge, RT badge (tomato if >=60%, skull otherwise), title,
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
  const [copiedNatural, setCopiedNatural] = useState(false);
  const [copiedSpec, setCopiedSpec] = useState(false);

  const copyNatural = () => {
    navigator.clipboard.writeText(NATURAL_PROMPT).then(() => {
      setCopiedNatural(true);
      setTimeout(() => setCopiedNatural(false), 2000);
    });
  };

  const copySpec = () => {
    navigator.clipboard.writeText(PROMPT).then(() => {
      setCopiedSpec(true);
      setTimeout(() => setCopiedSpec(false), 2000);
    });
  };

  const preStyle: React.CSSProperties = {
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
  };

  return (
    <div className="min-h-screen bg-[#0f172a] py-12 px-6">
      <div style={{ maxWidth: 780, margin: "0 auto" }}>

        {/* Natural language prompt */}
        <div style={{ marginBottom: 28 }}>
          <h1 style={{ fontSize: "1.4rem", fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.02em" }}>
            Idea Prompt
          </h1>
          <p style={{ marginTop: 6, fontSize: "0.875rem", color: "#64748b" }}>
            The original concept in plain English — no implementation details.
          </p>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
          <button onClick={copyNatural} style={{ background: copiedNatural ? "#166534" : "#334155", color: copiedNatural ? "#bbf7d0" : "#cbd5e1", border: "none", borderRadius: 8, padding: "6px 16px", fontSize: "0.8rem", cursor: "pointer", transition: "background 0.15s" }}>
            {copiedNatural ? "Copied!" : "Copy to clipboard"}
          </button>
        </div>
        <pre style={preStyle}>{NATURAL_PROMPT}</pre>

        {/* Technical spec */}
        <div style={{ marginTop: 56, marginBottom: 28 }}>
          <h2 style={{ fontSize: "1.4rem", fontWeight: 700, color: "#f1f5f9", letterSpacing: "-0.02em" }}>
            Full Technical Spec
          </h2>
          <p style={{ marginTop: 6, fontSize: "0.875rem", color: "#64748b" }}>
            Detailed spec for rebuilding the app from scratch.
          </p>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 10 }}>
          <button onClick={copySpec} style={{ background: copiedSpec ? "#166534" : "#334155", color: copiedSpec ? "#bbf7d0" : "#cbd5e1", border: "none", borderRadius: 8, padding: "6px 16px", fontSize: "0.8rem", cursor: "pointer", transition: "background 0.15s" }}>
            {copiedSpec ? "Copied!" : "Copy to clipboard"}
          </button>
        </div>
        <pre style={preStyle}>
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
