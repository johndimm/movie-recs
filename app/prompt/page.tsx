"use client";

import { useState } from "react";

const NATURAL_PROMPT = `Build a web app for discovering movies and TV shows I'll love.

TikTok doesn't ask you what you like — it watches how you react and figures it out.
I want something like that for movies. Show me a title; I rate with half-star red (seen)
or blue (unseen interest) stars, and you reveal how close your prediction was. Over many
rounds the AI should get better at knowing my taste.

The real goal isn't rating films I've already seen — it's finding films I haven't seen
but will love. The global watchlist is the actual product. Rating seen films is the
training signal to get there.

Each round: poster or trailer, director, cast, plot, Rotten Tomatoes when available.
If I've seen it, one tap on the red stars submits. If I haven't, I tap "Not yet", then
blue stars for interest — high stars add to my watchlist, low stars mean not interested.
I can hit Next to skip without saving. Dismissed titles stay excluded from future picks.

After I submit, load the next title automatically. Show accuracy in a chart — rolling
window over recent decisions, not a lifetime average.

When something lands on my watchlist, look up streaming services (US) when possible.

Filter movies / TV / both. Pick an LLM (DeepSeek, Claude, GPT-4o, Gemini) if I have keys.

Multiple taste channels with per-channel prefetch queues — same title can have different
ratings per channel. A starter pack can merge example channels without wiping my data.

Nav includes a dedicated Watchlist page (global list) plus Channels, Settings, Help.
Ratings page: Seen (signed delta vs AI), Watchlist, Not interested.

Keep all data in localStorage — no accounts, no server database.`;

const PROMPT = `# Trailer Vision — full spec

Build a Next.js 16 (App Router) web app called Trailer Vision.
Use Tailwind CSS v4 for styling. All persistence in localStorage. No database.

## Core concept
TikTok-style taste calibration for movies and TV. The real goal is to surface
films the user has NOT seen but will love. Rating seen films is the training
signal; the watchlist of unseen-but-wanted titles is the actual product.

Each round:
1. The next card is served instantly from a prefetch queue (see below).
2. The user rates with half-star stars: red = seen (one tap); if unseen, "Not yet" then blue stars.
3. **Next** skips without saving. After a rating, the next title loads automatically.
4. The last result (accuracy vs prediction) is shown inline in the chart panel.

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
LLM_BATCH_SIZE = 5. MAX_REPLENISH_IN_FLIGHT = 3. HIGH_WATER_MARK = 6 (caps buffered cards so
new ratings affect upcoming picks sooner; smaller than a deep backlog).

On card pop: show the card instantly; if replenishInFlight < MAX_REPLENISH_IN_FLIGHT, start
a background replenish immediately (don't wait for the queue to run low).

Daisy-chain: when any replenish completes, if queue < HIGH_WATER_MARK and a slot is free,
immediately start another. This keeps up to MAX_REPLENISH_IN_FLIGHT fetches running so the
queue refills. Stop the chain if zeroYieldStreak >= 3 (3 consecutive batches with 0 fresh
items — LLM is stuck). Reset the streak on any user action.

Pre-display check: before showing a card popped from the queue, verify the title is not
already in the excluded set (race condition: user could rate/skip a title while it was
queued). Silently discard stale entries; drain the queue until a fresh title is found.

Empty-queue fallback: reset zeroYieldStreak, kick off a replenish if nothing is in-flight,
then poll every 200ms until a card arrives or 90s elapse. Show error pill if nothing found.

On failure, show a friendly error pill with a Retry button.

lensIndexRef increments on every replenish call so concurrent batches get different lenses.

## Star rating system
Half-star precision on 1–5. Trailer and poster layouts use the same interaction model.

Initial state (seen path default):
- One horizontal row: compact StarRow red ("Seen it") + button "Not yet" (sets unseen flow) + **Next** (skip).
- Clicking a red star calls submitRating(n, "seen") immediately — one tap for seen titles.

Unseen flow (after "Not yet"):
- Compact StarRow blue ("Interest") + "I have seen it" (back to red row) + **Next**.
- submitRating(_, "unseen") calls recordNotSeen(kind, interestStars): kind = want if stars≥4 else skip.
- 4–5 stars: add to global watchlist, accuracy chart diamond at 85.
- 1–3 stars: not-interested signal, chart diamond at 20.
- Both add to skipped; every blue submit appends movie-recs-unseen-interest-log for /channels.

StarRow supports optional compact mode (tighter label + smaller stars) for the one-line bar.

Props: filled, color ("red"|"blue"), label, onRate(n), compact?: boolean.
Hover preview, key={title} remount, touchAction: "manipulation" on star buttons.

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
- Global Window.YT shim; load iframe_api script once (singleton).
- useEffect: create inner mountEl, append to wrapperRef; new YT.Player(mountEl, { videoId, playerVars }).
  Never pass React's wrapper directly — YT replaces the node.
- playerVars: autoplay, mute, controls, rel, modestbranding, playsinline, enablejsapi; include
  origin: window.location.origin (http and https) for postMessage with the JS API.
- onReady: unmute; optional loadVideoById when videoId changes; destroy on cleanup.
- Return wrapper div aspect-video; volume can persist session-wide via module var.

Trailer layout: TrailerPlayer on top; metadata; same single-line rating strip as poster
(Seen it / Not yet / Next, then Interest / I have seen it / Next) — no watch-% auto stars
in the current implementation.

## Main card UI (poster layout, when trailerKey is null or displayMode = "posters")
On mobile: small portrait thumbnail (w-28) on the LEFT, metadata on the RIGHT; plot line-clamped.
On sm+: thumbnail w-48. Poster opens lightbox. Metadata: type/year, RT badge, title, director,
cast, plot. Without trailerKey, title links to YouTube search for a trailer.

Below: one rounded box with the compact one-line rating UI (see Star rating system).

While the LLM is fetching: dim the card to 45% opacity. Show a fixed pill at
bottom-center of the viewport: "LLM is thinking..." with bouncing dots.
On response: fade card to 0, swap content, fade back to 1.

Page max-width: max-w-3xl.

## Navigation
Shared sticky nav bar at the top of every page (via layout.tsx):
App | Watchlist | Channels | Settings | Help
/watchlist is the global watchlist (same data as Ratings → Watchlist tab).
Help explains end-user usage and links to Dev Journal (/journal) and Prompt History (/prompt).
Ratings (/ratings) is not in the bar. Active page is highlighted.

## Channels (/channels) and per-channel prefetch
- Channel model: id, name, genres[], timePeriods[], language, region, artists, freeText, popularity.
- Immutable first channel id "all" named "All". CRUD for other channels; export/import includes
  movie-recs-channels and movie-recs-active-channel.
- **Recommendation islands:** Each channel is an independent recommendation context: its own
  prefetch queue, its own activeChannel object sent to POST /api/next-movie, and its own slice of
  seen ratings in history. RatingEntry includes optional channelId (set from the active channel
  when the user rates). The same human-readable title may appear as **multiple** history rows
  with different channelId values and different userRating / predictedRating — e.g. 4★ vs the AI
  in "Korean Horror" and 2★ in "All" — because the user is judging the fit under different taste
  lenses. Per-channel ratings UIs filter by channelId; "All" includes rows with channelId "all"
  or missing channelId (legacy).
- Each channel has its own prefetch queue in localStorage: movie-recs-prefetch-queue:{channelId}
  (legacy key movie-recs-prefetch-queue may be migrated on read). Replenish and card pop use
  the active channel's queue; switching channel persists the previous queue and loads the new one.
- Client dedupe for the *next card* still merges canonical title keys from the **full** history
  plus skipped/watchlist/passed — so in normal browsing a title already decided in one channel
  is not offered again as a fresh pick until that history row is removed (e.g. reconsider flow).
  Islands affect **stored ratings, queues, and LLM channel context**, not a second concurrent offer
  of the same title across channels without clearing history.

## Factory starter channels (factory-channels.json)
Bundled JSON in the same shape as a v1 export (data object with channel list, active channel,
prefetch keys, etc.).
- First visit: if movie-recs-channels has never been written (getItem === null), copy every
  key from data into localStorage once (applyFactoryBootstrap) on home and channels hydrate.
- Settings: "Merge starter channels" appends any bundled non-All channels whose ids are not
  already present; fills prefetch keys only when local key is missing (mergeFactoryChannelsAndQueues).
- Home channel row: if the user has no custom channels (only "All" or empty during hydrate),
  show a "Load starter channels" pill next to the + link that runs the same merge and refreshes
  channels state + prefetch refs + fetchNext.

## Home channel row UI
- flex flex-wrap gap-2: channel pills wrap instead of single-line horizontal scroll.
- Pills: text-sm font-semibold; inactive text-zinc-800; selected bg-zinc-900 text-white.
- Deletable channels: × control on hover (sm+); ConfirmDialog before delete; if active channel
  deleted, fall back to first remaining channel and fix prefetch/active key.

## Ratings (/ratings) and channel history (/channels)
Seen tab on /ratings and the **Seen** block inside /channels **Channel history**:
- Do NOT show RT / Tomatometer badge on these rows (watchlist and not-interested tabs may still show RT).
- Show StaticStars for userRating (red) plus a signed half-star delta = userRating − predictedRating,
  formatted like +1.5 or -2 (tabular-nums; emerald if delta>0, rose if delta<0, zinc if 0).
- Sort bar: "Your stars" (sort descending by user rating) | "vs predicted" (sort descending by delta).
- Helpers in app/lib/ratingDelta.ts: starDelta(), formatStarDelta().
- /channels "All" channel: include history where !channelId OR channelId === "all". Other channels:
  filter channelId === selected.id.

Channel history also lists **Unseen** rows from movie-recs-unseen-interest-log (append on every
blue-star submit in recordNotSeen: title, metadata snapshot, interestStars, kind want|skip, channelId, at).
Each row shows blue StaticStars and pills (Added / Not on list for saves vs Not interested for passes).
**Add to watchlist**: minimum interest (2.5–4.5★), adds titles **not** already on the global watchlist
with interest ≥ threshold — **skip** rows and **want** rows you removed from the watchlist — then
removes promoted skips from skipped + not-interested and POST /api/streaming per new entry.

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

## Ratings page  /ratings
Single page with tabs (Seen | Watchlist | Not interested) when the user has any data in those lists.
- Seen: rated history — signed half-star delta (user − predicted), sort by your stars vs delta,
  no RT badge on rows; click a row to remove from history and load that title on / for re-rate.
- Watchlist: read-only list of movie-recs-watchlist (posters, metadata, RT, streaming pills).
- Not interested: derived skipped titles (same logic as legacy lists below the home card).

## Watchlist page  /watchlist
Linked from the main nav. Same global movie-recs-watchlist as Ratings → Watchlist: poster (w-24),
type+year, RT badge, title, director, cast, plot, streaming pills (blue).
× removes from watchlist AND moves to not-interested (writes movie-recs-not-interested + skipped).

## Streaming lookup  POST /api/streaming
Request: { title, year, llm }
Prompt: "What streaming services currently have {title} ({year}) in the US?
Return ONLY a JSON array: ["Netflix", "Max", ...]. Return [] if unsure."
Called when a title is saved to the watchlist (blue 4–5★ or bulk add from Channels); result stored on the entry.

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
movie-recs-unseen-interest-log — UnseenInterestEntry[] (unseen blue-star events with channelId)
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

  const preClass =
    "rounded-xl border border-zinc-200 bg-zinc-50 p-7 font-mono text-[0.78rem] leading-[1.8] text-zinc-800 whitespace-pre-wrap break-words shadow-sm";

  return (
    <div className="min-h-screen bg-white py-12 px-6">
      <div className="max-w-[780px] mx-auto">

        {/* Natural language prompt */}
        <div className="mb-7">
          <h1 className="text-[1.4rem] font-bold text-zinc-900 tracking-tight">
            Prompt History
          </h1>
          <p className="mt-1.5 text-sm text-zinc-500">
            Original idea in plain English — then the full technical spec used to build the app.
          </p>
        </div>
        <div className="flex justify-end mb-2.5">
          <button
            type="button"
            onClick={copyNatural}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              copiedNatural
                ? "bg-green-700 text-white"
                : "bg-zinc-900 text-white hover:bg-zinc-800"
            }`}
          >
            {copiedNatural ? "Copied!" : "Copy to clipboard"}
          </button>
        </div>
        <pre className={preClass}>{NATURAL_PROMPT}</pre>

        {/* Technical spec */}
        <div className="mt-14 mb-7">
          <h2 className="text-[1.4rem] font-bold text-zinc-900 tracking-tight">
            Full Technical Spec
          </h2>
          <p className="mt-1.5 text-sm text-zinc-500">
            Detailed spec for rebuilding the app from scratch.
          </p>
        </div>
        <div className="flex justify-end mb-2.5">
          <button
            type="button"
            onClick={copySpec}
            className={`rounded-lg px-4 py-1.5 text-sm font-medium transition-colors ${
              copiedSpec ? "bg-green-700 text-white" : "bg-zinc-900 text-white hover:bg-zinc-800"
            }`}
          >
            {copiedSpec ? "Copied!" : "Copy to clipboard"}
          </button>
        </div>
        <pre className={preClass}>
          {PROMPT.split("\n").map((line, i) =>
            line.startsWith("#") ? (
              <span key={i} className="text-zinc-500">{line}{"\n"}</span>
            ) : (
              <span key={i}>{line}{"\n"}</span>
            )
          )}
        </pre>

      </div>
    </div>
  );
}
