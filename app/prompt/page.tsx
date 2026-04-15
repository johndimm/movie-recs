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
Request body:
- sessionId / historySync / history / baseLength / historyAppend — server-side session cache
  (historySync: "full" | "delta" | "reuse"; avoids resending full history every request)
- skipped: string[] — all titles the user has decided on (rated + watchlist + not-interested)
- watchlistTitles: { title, rtScore }[] — want-to-watch entries with RT score
- notInterestedItems: { title, rtScore }[] — not-interested entries with RT score
- tasteSummary?: string — the running taste profile (used as primary signal context)
- diversityLens?: string — e.g. "films from the 1970s" or "South Korean cinema"
- userRequest?: string — free-text user request appended to system prompt as a hard steer
- mediaType: "movie" | "tv" | "both"
- llm: "deepseek" | "claude" | "gpt-4o" | "gemini"
- count?: number (default 5, max 8)

RatingEntry stores { title, type, userRating, predictedRating, error, rtScore? }.

Token-efficient user message: rated history is truncated to the top ~32 entries by
|user−RT| divergence (fallback |user−AI| if RT missing), blended with the most recent
entries for freshness. Want-to-watch lists only low-RT saves (<60%). Not-interested lists
only high-RT dismissals (≥70%). Full exclusion title lists are NOT sent — counts only.
The client dedupes returned titles against its own excluded set.

Diversity lens: each batch carries a hard constraint ("DIVERSITY LENS FOR THIS BATCH: …")
that forces the LLM to explore a specific corner of cinema — a decade, world region, or
genre. 24 lenses rotate across batches so concurrent requests explore different areas.
This prevents the LLM from defaulting to the same ~300 popular titles.

User request: if userRequest is non-empty, replace the diversity lens entirely with:
"USER REQUEST — HARD CONSTRAINT: The user has asked for '<request>'. Every single
item you return MUST match this request. Do not return anything outside this category."
When userRequest is empty, the diversity lens is used as normal.
When userRequest changes on the client, flush the prefetch queue (debounced 600ms).

The model returns ONLY valid JSON:
{ "items": [ { title, type, year, director, predicted_rating, actors[], plot, rt_score }, ... ] }
type must be "movie" or "tv". rt_score is the Tomatometer % or null.
All string values must be on one line (no newlines inside JSON strings).

Parse JSON with fallbacks (top-level array, legacy single-object, brace-depth walker).
Response body: { movies: CurrentMovie[] } — one entry per accepted item (posters attached).

Fetch posters AND trailer keys via TMDB (TMDB_API_KEY):
- Search for the title to get its TMDB id and poster_path.
- Call /movie/{id}/videos (or /tv/{id}/videos) and pick the first YouTube result
  with type "Trailer" or "Teaser". Return its key as trailerKey.
- Fall back to Serper Images API (SERPER_API_KEY) for poster only when TMDB absent.
Upgrade http:// poster URLs to https:// before returning.
CurrentMovie interface includes trailerKey: string | null.

## Taste summary  POST /api/taste-summary
Separate lightweight endpoint. Request: { history, watchlistSignals, notInterestedSignals,
existingSummary, llm }. Returns { tasteSummary: string | null }.
Generates a 2–4 sentence profile of the user's taste written in second person
("You tend to prefer…"). max_tokens: 256. Called by the client in the background after
the 1st rating and every 5 ratings thereafter (1, 5, 10, 15 …). Stored in localStorage
under movie-recs-taste-summary. Displayed as a card with a purple left border below the
accuracy chart. The existing summary is sent back as context each call so it refines
incrementally rather than starting from scratch.

## Prefetch queue with daisy-chain replenishment
Maintain a client-side prefetch queue (ref, not state) of pre-fetched CurrentMovie objects.
LLM_BATCH_SIZE = 5. MAX_REPLENISH_IN_FLIGHT = 3. HIGH_WATER_MARK = 12.

On card pop: show the card instantly; if replenishInFlight < MAX_REPLENISH_IN_FLIGHT, start
a background replenish immediately (don't wait for the queue to run low).

Daisy-chain: when any replenish completes, if queue < HIGH_WATER_MARK and a slot is free,
immediately start another. This keeps MAX_REPLENISH_IN_FLIGHT fetches running continuously
so the queue is always being filled. Stop the chain if zeroYieldStreak >= 3 (3 consecutive
batches with 0 fresh items — LLM is stuck). Reset the streak on any user action.

Pre-display check: before showing a card popped from the queue, verify the title is not
already in the excluded set (race condition: user could rate/skip a title while it was
queued). Silently discard stale entries; drain the queue until a fresh title is found.

Empty-queue fallback: reset zeroYieldStreak, kick off a replenish if nothing is in-flight,
then poll every 200ms until a card arrives or 90s elapse. Show error pill if nothing found.

On failure, show a friendly error pill with a Retry button.

lensIndexRef increments on every replenish call so concurrent batches get different lenses.

## Star rating system
Every card shows two rows of 5 stars. Clicking any star submits immediately and advances.

Red stars — "Seen it" (1–5):
- Treated as an explicit rating. Stored in history. Maps to 0–100: stars × 20.
- Contributes to the accuracy chart as a blue vertical bar.

Blue stars — "Haven't seen it / interest level" (1–5):
- 4–5 stars: adds to watchlist (same as old "Want to watch"), accuracy 85.
- 1–3 stars: logged as not-interested taste signal (same as old "Not interested"), accuracy 20.
- Both add to skipped list (never shown again).

StarRow component:
- Props: filled (number 1–5), color ("red"|"blue"), label (string), onRate(n: number).
- Internal hover state shows a preview as the user moves over stars.
- key prop tied to current movie title forces a full remount on each new card,
  resetting hover state so the previous card's highlight doesn't bleed through.
- touchAction: "manipulation" on each star button for responsive mobile taps.

## Accuracy chart
Hand-rolled SVG, no library. Shows accuracy (100 - error) so up is always good.
- Blue vertical bars for rated titles
- Green diamonds at y=85 for "want to watch" events
- Red diamonds at y=20 for "not interested" events
- Indigo line = rolling average of last 5 decisions (NOT cumulative)
- Dashed reference lines at y=85 and y=20
- Label: "How well the AI knows your taste"

## Trailer card (when trailerKey is present)
Use the YouTube IFrame API to embed and auto-play the trailer.

TrailerPlayer component:
- Declare a global Window.YT type shim (Player constructor + PlayerState enum + isMuted/
  getVolume/setVolume/unMute methods on YTPlayer interface).
- Load the IFrame API script exactly once via a module-level singleton
  (loadYouTubeApi(): Promise<void> backed by _ytApiLoaded / _ytApiReady flags and a
  resolve-queue). Never add the script tag twice.
- In useEffect([videoId]): create a fresh inner mountEl div, append to wrapperRef.
  Pass mountEl (NOT wrapperRef.current) to new window.YT.Player(mountEl, ...).
  YT replaces its argument element with an iframe — passing a React-owned ref directly
  causes a React removeChild crash on unmount. Only the inner element is YT-managed;
  React owns the wrapper.
- playerVars: { autoplay:1, mute:1, controls:1, rel:0, modestbranding:1, playsinline:1 }
  (mute:1 is required for autoplay; unmute in onReady).
- onReady: restore _lastVolume (module-level var) if set, then call unMute().
- Poll getCurrentTime()/getDuration() every 500ms; report watch% via onPctChange.
- onStateChange ENDED: call onPctChange(100) then onEnd() (guarded by endedRef).
- Cleanup: save volume to _lastVolume if !isMuted(), then destroy(). Remove mountEl
  if still connected. This persists volume across cards for the session.
- Return <div ref={wrapperRef} className="w-full aspect-video rounded-xl overflow-hidden bg-black" />.

Trailer layout (card has trailerKey):
- Full-width TrailerPlayer at the top.
- Thin watch-progress bar below it (bg-blue-500, width = watchPct%).
- Metadata (type/year badge, RT badge, title, director, cast, plot) below.
- Two StarRow components in a rounded box:
    red  row — "Seen it"      — filled = trailerStars (live, driven by watch%)
    blue row — "Haven't seen" — filled = trailerStars (same live count)
  Hint text: "Stars fill as you watch · click red = seen, blue = interest"
- Watch-time → stars: pctToStars(pct) = Math.min(5, Math.floor(pct / 20) + 1).
  trailerStars is React state updated via onPctChange every 500ms.
- Video ends → commitTrailerRating() auto-submits as red (seen) at current trailerStars
  (will be 5). Guarded by trailerCommittedRef to prevent double-submit.
- Clicking any star calls submitRating(n, mode) which sets trailerCommittedRef = true.
- Reset trailerWatchPctRef, trailerCommittedRef, trailerStars(1) on each new card.

## Main card UI (poster layout, when trailerKey is null or displayMode = "posters")
On mobile: small portrait thumbnail (w-28 h-[10.5rem]) on the LEFT, metadata on the RIGHT.
  Plot line-clamped to 3 lines on mobile (sm:line-clamp-none).
On sm+: thumbnail widens to w-48 with natural height.
Click poster for full-screen lightbox (Escape to close).
Metadata: type + year badge, RT badge (tomato if >=60%, skull otherwise), title,
director, cast, plot.

Below the info, a single rounded box with two StarRow components:
  red  row — "Seen it"      — filled = 3 (default)
  blue row — "Haven't seen" — filled = 3 (default)
  Hint text: "Click a star to rate and advance · red = seen, blue = interest"
Clicking any star calls submitRating(n, mode) immediately — no separate submit button.

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

Segmented control: Trailers | Posters (displayMode state, default "trailers").
When "posters" is selected, always use the poster layout even if trailerKey is available.

User request text input: full-width input below the segmented controls.
Placeholder: 'Request something specific… e.g. "French cinema" or "slow-burn thrillers"'.
Shows a × clear button when non-empty. Value is read from a ref (userRequestRef) at
fetch time so background replenish calls always use the latest text.
When the value changes, flush the prefetch queue after a 600ms debounce so upcoming
cards come from a batch that knew about the request.

## Re-rate / reconsider
The "All ratings" list and the "Not interested" list below the card are fully clickable rows
(cursor-pointer, hover highlight). Clicking a row loads that title as the current card:
- Rated title: remove the entry from history, reconstruct a CurrentMovie from
  { title, type, predictedRating, rtScore } (year/director/actors/plot/posterUrl all null/empty),
  call setCurrent(movie) and scroll to top.
- Not-interested title: remove from the skipped list and notInterested list in localStorage
  and state, then reconstruct and setCurrent similarly (type defaults to "movie",
  predictedRating defaults to 50).
In both cases the user rates or categorises it using the normal card UI; handleRate() adds
a fresh history entry as usual.

## Watchlist page  /watchlist
Shows all "want to watch" entries: poster (w-24), type+year, RT badge, title,
director, cast, plot, streaming pills (blue).
× button per entry — removes from watchlist AND moves to not-interested:
  writes {title, rtScore} to movie-recs-not-interested and adds title to movie-recs-skipped.

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
movie-recs-history        — RatingEntry[] (includes rtScore per entry)
movie-recs-skipped        — string[] (all excluded titles)
movie-recs-watchlist      — WatchlistEntry[]
movie-recs-notseen        — NotSeenEvent[] (for chart plotting)
movie-recs-not-interested — { title, rtScore }[] (for high-RT taste signal)
movie-recs-taste-summary  — string (LLM-generated taste profile, second person)
movie-recs-llm-session-id — UUID for server-side history session
movie-recs-llm-history-synced — number of ratings confirmed synced to server

## Required env vars
DEEPSEEK_API_KEY       — DeepSeek (default LLM)
ANTHROPIC_API_KEY      — Claude (optional)
OPENAI_API_KEY         — GPT-4o (optional)
GEMINI_API_KEY         — Gemini (optional)
TMDB_API_KEY           — TMDB poster lookup (recommended)
SERPER_API_KEY         — Serper Images fallback for posters (optional)
NEXT_MOVIE_LOG_LLM_PROMPTS — set to "1" to log full prompts to server console (debug only)`;

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
