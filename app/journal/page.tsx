export default function JournalPage() {
  return (
    <div className="min-h-screen bg-[#f8f8f7] py-12 px-6">
      <style>{`
        .j-section { margin-bottom: 40px; }
        .j-section h2 { font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.1em; color: #aaa; margin-bottom: 16px; padding-bottom: 8px; border-bottom: 1px solid #e8e8e6; }
        .j-card { background: #fff; border: 1px solid #e8e8e6; border-radius: 14px; padding: 20px 24px; margin-bottom: 12px; }
        .j-card h3 { font-size: 1rem; font-weight: 600; margin-bottom: 6px; color: #1a1a1a; }
        .j-card p, .j-card li { font-size: 0.875rem; color: #555; line-height: 1.6; }
        .j-card ul { padding-left: 1.2em; margin-top: 6px; }
        .j-card li { margin-bottom: 4px; }
        .j-tag { display: inline-block; font-size: 0.7rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px; border-radius: 99px; margin-bottom: 10px; }
        .j-tag.concept { background: #e0f2fe; color: #0369a1; }
        .j-tag.ux      { background: #fef9c3; color: #854d0e; }
        .j-tag.feature { background: #dcfce7; color: #166534; }
        .j-tag.fix     { background: #fee2e2; color: #991b1b; }
        .j-tag.prompt  { background: #f3e8ff; color: #7e22ce; }
        .j-insight { background: #fafaf9; border-left: 3px solid #a78bfa; border-radius: 0 10px 10px 0; padding: 14px 18px; margin-bottom: 12px; font-size: 0.875rem; color: #444; line-height: 1.6; }
        .j-insight strong { color: #1a1a1a; }
        .j-file-list { list-style: none; display: flex; flex-direction: column; gap: 6px; }
        .j-file-list li { font-size: 0.8rem; font-family: "SF Mono","Fira Code",monospace; background: #fff; border: 1px solid #e8e8e6; border-radius: 8px; padding: 8px 14px; color: #2563eb; }
        .j-file-list li span { float: right; color: #aaa; font-family: -apple-system,sans-serif; font-size: 0.75rem; }
      `}</style>
      <div style={{ maxWidth: 720, margin: "0 auto" }}>

        <div style={{ marginBottom: 40 }}>
          <h1 style={{ fontSize: "2rem", fontWeight: 700, letterSpacing: "-0.03em", color: "#1a1a1a" }}>Movie Recs</h1>
          <p style={{ marginTop: 6, fontSize: "0.875rem", color: "#888" }}>Dev Journal &mdash; Monday, April 13, 2026 (updated April 14–15)</p>
        </div>

        {/* THE IDEA */}
        <div className="j-section">
          <h2>The Idea</h2>
          <div className="j-insight">
            <strong>Starting prompt (yours):</strong> TikTok doesn&apos;t ask you what you like &mdash;
            it watches how you react. Apply the same idea to movies: an LLM picks a title, predicts
            your rating, you rate it 0&ndash;100, and the error is revealed. Over time the AI gets
            better. The goal is to minimize error.
          </div>
          <div className="j-insight">
            <strong>Deeper insight (yours, later):</strong> The real aim of the app is to surface films
            you have <em>not</em> seen but will love. Rating movies you&apos;ve already seen is the
            training signal &mdash; the accuracy chart shows the work the AI is doing to get there.
            The watchlist is the point; everything else is calibration.
          </div>
          <div className="j-card">
            <span className="j-tag concept">Concept</span>
            <h3>Core mechanic</h3>
            <p>Each round: LLM selects a movie/TV title and makes a hidden prediction.
            User rates 0&ndash;100. Prediction is revealed alongside the error.
            A rolling-window accuracy chart (last 5 decisions) tracks improvement over time.
            No title is ever shown twice &mdash; enforced both in the prompt and client-side.</p>
          </div>
        </div>

        {/* DESIGN DECISIONS */}
        <div className="j-section">
          <h2>Your Design Decisions</h2>
          {[
            { tag: "ux", title: "Slider instead of number input", body: "The original number input felt like filling out a form. You asked for a slider, which turned out to feel much more like a judgment — drag to where it feels right, hit Submit. The live large-number display next to the label replaced the need for any typed value." },
            { tag: "ux", title: "Remove the Next button — auto-advance after rating", body: "After submitting a rating, the original design paused to show a result screen with a Next button. You pointed out the extra click was friction: show the result info below the chart instead, and immediately load the next movie. This made the loop feel like a card swipe rather than a form submission." },
            { tag: "ux", title: "Clear labeling of \"seen\" vs \"not seen\" sections", body: "After watching someone use the app, it was clear the two halves of the card were ambiguous. The rating slider is now inside a box labeled \"I've seen it — rate it\" and the two skip buttons are in a separate box labeled \"Haven't seen it\". \"Want to watch\" is green-tinted to signal it's a save action." },
            { tag: "feature", title: "Movie details: poster, cast, plot, director, year", body: "You asked for the main actors, a plot summary, director, release year, and a poster on each card. The LLM returns all metadata as structured JSON; the Serper image search API fetches a poster (year included in the query to avoid getting a different version). The card became a proper movie entry rather than a bare title." },
            { tag: "feature", title: "Rotten Tomatoes score", body: "You wanted a professional rating to show alongside yours after the reveal. The LLM returns the RT Tomatometer from its training knowledge (e.g. \"91%\"). A 🍅 / 💀 badge renders on the card, giving immediate external context for how your taste compares to critics." },
            { tag: "feature", title: "Two kinds of \"haven't seen it\"", body: "You identified two distinct signals: films you want to see (LLM got your taste right — a positive outcome, score 85/100) vs films you have no interest in (LLM missed entirely — score 20/100). \"Want to watch\" adds to the watchlist. \"Not interested\" is discarded. Both are excluded from future picks." },
            { tag: "feature", title: "Watchlist with streaming info", body: "Titles marked \"Want to watch\" are saved to a persistent watchlist with full metadata. On save, the selected LLM is asked which streaming services carry the title in the US; results appear as blue pills on the watchlist page." },
            { tag: "feature", title: "Shared navigation bar", body: "A sticky nav bar at the top of every page (rendered in app/layout.tsx) links to App, Watchlist, Journal, and Prompt. The watchlist link shows a live count badge read from localStorage. The active page is highlighted. All navigation stays in the same tab — no target=_blank needed." },
            { tag: "feature", title: "System/user prompt split with Anthropic caching", body: "callLLM() was refactored from a single prompt argument to (systemPrompt, userMessage). The stable instruction block goes in the system prompt with cache_control: { type: 'ephemeral' } and the anthropic-beta: prompt-caching-2024-07-31 header — Anthropic only re-bills the system prompt on cache miss. OpenAI caches prefixes ≥1024 tokens automatically. Gemini uses the systemInstruction field. The split also makes the per-request payload smaller." },
            { tag: "feature", title: "Prefetch queue with adaptive batch sizing", body: "The app pre-fetches the next 5 titles in parallel so advancing to the next card is nearly instant. A background replenish fires whenever the queue drops below a low-water mark. Batch size adapts automatically: after each replenish, the yield fraction (valid results / requested) is recorded. If recent batches return fewer valid results — which happens as the exclusion list grows long — the next batch requests proportionally more. The formula is ceil(TARGET_FRESH / avgYield), capped at 20 parallel requests." },
            { tag: "feature", title: "Smooth transitions + \"LLM is thinking\" indicator", body: "While the next title loads, the current card dims to 45% opacity so the layout doesn't jump. A fixed pill at the bottom reads \"LLM is thinking…\" with bouncing dots, visible regardless of scroll position. When the response arrives, the card fades out, content swaps, then fades back in. With the prefetch queue in place, the indicator almost never appears after the first load." },
            { tag: "ux", title: "Removed reveal popup", body: "After adding the prefetch queue, advancing to the next card became nearly instant — the modal that showed your score / AI score / error flashed for only a few milliseconds before disappearing, which felt worse than nothing. Removed it. The last result is still shown inline in the chart panel." },
            { tag: "ux", title: "Mobile-responsive layout", body: "On small screens the movie card now stacks vertically: the poster becomes a full-width banner image (cropped to a fixed height) above the metadata and rating controls. The nav bar hides the brand name on xs to give the four links room. Long movie titles in the recent ratings list truncate with ellipsis rather than overflowing." },
            { tag: "feature", title: "Media type filter and LLM selector", body: "A segmented control restricts picks to Movies, TV Series, or both. If the current card doesn't match a newly selected type, a fresh fetch fires immediately. A second control lists every LLM whose API key is present in .env (DeepSeek, Claude, GPT-4o, Gemini); the selection is live." },
            { tag: "feature", title: "Poster lightbox", body: "The poster renders at w-72 on the card. Clicking it opens a full-screen lightbox (black overlay, Escape to close). Page max-width is max-w-3xl to give the poster room without making the text too wide." },
            { tag: "feature", title: "Scaling: informative history selection", body: "As ratings accumulate, sending the full history to the LLM overflows the context budget. Instead, the server selects the most informative subset: ratings where |user score − RT score| is largest (divergence from critic consensus reveals the most about taste per token), plus the most recent entries for freshness. The LLM still receives the full exclusion count but not the full title lists." },
            { tag: "feature", title: "RT-divergence taste signals", body: "RatingEntry now stores rtScore. The server curates two extra taste signals beyond raw ratings: want-to-watch items with low RT scores (user liked what critics didn't), and not-interested items with high RT scores (user dismissed what critics loved). Both are stored in localStorage and sent with each request. These are the most informative signals the LLM can receive about how this user's taste differs from the mainstream." },
            { tag: "feature", title: "Taste profile card (second person)", body: "A separate /api/taste-summary endpoint generates a 2–4 sentence taste profile addressed directly to the viewer in second person ('You tend to prefer…'). It runs in the background after the first rating and every 5 thereafter — decoupled from the movie batch so it doesn't slow down recommendations. The profile is stored in localStorage and displayed as a card with a purple left border between the accuracy chart and the movie card." },
            { tag: "feature", title: "Diversity lenses — the key to scaling", body: "Without explicit direction the LLM defaults to the same ~300 culturally visible titles. The fix: each batch request carries a rotating 'diversity lens' — a hard constraint like 'films from the 1970s' or 'South Korean cinema' or 'overlooked gems with low name recognition'. 24 lenses cycle through decades, world regions, and genres. With 3 concurrent batches running, three different corners of cinema are explored simultaneously. This unlocked the full breadth of the LLM's knowledge." },
            { tag: "feature", title: "Daisy-chain replenishment — always filling", body: "The old approach triggered replenishment only when the queue dropped below a threshold. If LLM latency spiked or yield was low, the queue drained to empty and the user waited. The new approach daisy-chains: each completed batch immediately starts another if the queue is below the high-water mark (12 items) and a slot is free. Up to 3 concurrent fetches run continuously. A zero-yield streak counter (resets on any user action) stops the chain after 3 consecutive zero-yield batches to avoid an infinite loop when the LLM is stuck." },
            { tag: "fix", title: "Pre-display exclusion check", body: "A race condition could allow a title to sit in the prefetch queue and then be rated or skipped before it was displayed. The fetchNext pop loop now checks each candidate against the live excluded set (history + skipped + watchlist) and silently discards any stale entry before showing it." },
            { tag: "fix", title: "Custom slider — iOS range input unusable", body: "The native <input type='range'> on iOS is nearly unusable: the thumb is tiny, and any horizontal swipe is interpreted as a page scroll rather than a drag. Replaced with a custom RatingSlider component built on pointer events. setPointerCapture() locks the drag to the element even when the finger strays outside, and touch-action: none prevents iOS from hijacking the gesture. The hit target is 44px tall with a 28px thumb — comfortable for any finger size." },
            { tag: "ux", title: "Unseen-title button order matches slider polarity", body: "The two haven't-seen buttons were ordered Want to watch (left) / Not interested (right). Flipped to Not interested (left) / Want to watch (right) so the polarity matches the rating slider where left = low/bad and right = high/good. Spatial consistency reduces accidental taps." },
            { tag: "feature", title: "Re-rate and reconsider from history lists", body: "Any row in the All Ratings list or the Not Interested list is now clickable. Clicking a rated title removes it from history and loads it as the current card so you can change your score. Clicking a not-interested title removes it from the skipped and not-interested lists and loads it as the current card — you can then rate it or add it to the watchlist. Deleting a title from the Watchlist page now also moves it to Not Interested (adds to skipped + not-interested) instead of just discarding it." },
            { tag: "feature", title: "Trailer-based rating — TikTok for movies", body: "When TMDB returns a YouTube trailer key for a title, the card shows the trailer instead of the poster. Watch time becomes the implicit rating: 0% watched = 0, 100% watched = 95. The trailer autoplays (muted at first, then immediately unmuted). Three buttons appear below: Not interested | Next → | Want to watch. A collapsible 'I've seen it' section still lets you override with an explicit slider rating. A progress bar at the bottom of the player reflects your current watch percentage. When the trailer ends, the rating is committed automatically." },
            { tag: "ux", title: "Trailer volume persists across cards", body: "Each new YouTube player is initialised muted (required by browsers for autoplay), then immediately unmuted in onReady. When a card is destroyed, the player's current volume is saved to a module-level variable. The next card restores that volume before unmuting. Volume is not persisted across page reloads — session only." },
            { tag: "feature", title: "User request field", body: "A free-text input below the media-type and LLM controls lets you steer the recommendations in plain language — 'French cinema', 'slow-burn thrillers', '90s Hong Kong action'. The text is sent to the LLM as a USER REQUEST instruction that overrides the diversity lens but still respects your taste profile. When the request changes, the prefetch queue is flushed (debounced 600ms) so the very next card comes from a batch that knew about the request. A × button clears it." },
          ].map(({ tag, title, body }) => (
            <div className="j-card" key={title}>
              <span className={`j-tag ${tag}`}>{tag === "ux" ? "UX" : "Feature"}</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>

        {/* BUGS */}
        <div className="j-section">
          <h2>Bugs Fixed</h2>
          {[
            { title: "SVG NaN errors in the chart", body: "On first render the chart produced NaN for SVG attributes. Root causes: dividing by zero on a single data point, and stale localStorage entries with no error field. Fixed by filtering invalid entries, centering the single-point case, and rendering a <circle> for one data point." },
            { title: "Same title shown twice", body: "LLMs occasionally ignore the exclusion list. The client now maintains a definitive excluded set (all rated + all skipped, case-insensitive) and retries up to 8 times, accumulating each duplicate into extraSkip. The card is never set unless a non-duplicate is confirmed." },
            { title: "AI Predicted blank / Error NaN", body: "The LLM returned predicted_rating (snake_case) but the TypeScript interface expected predictedRating (camelCase). A type assertion silently accepted the wrong shape. Fixed by explicitly mapping the raw field after parsing." },
            { title: "Poster showed wrong version (e.g. 1930 instead of 1993)", body: "The Serper image search query did not include the year, so for remade titles the wrong version's poster appeared. Fixed by appending the release year to the query." },
            { title: "No poster on Vercel (works on localhost)", body: "Serper occasionally returns http:// image URLs. Browsers block mixed content on HTTPS pages. Fixed by upgrading all poster URLs to https:// before returning them. A missing SERPER_API_KEY env var on Vercel was also a factor." },
            { title: "LLM response contained two JSON objects", body: "Claude sometimes thinks out loud and emits reasoning text between two JSON objects. A greedy regex captured the reasoning. Fixed with a brace-depth walker that collects every complete top-level object and takes the last one." },
          ].map(({ title, body }) => (
            <div className="j-card" key={title}>
              <span className="j-tag fix">Fix</span>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>

        {/* CHART */}
        <div className="j-section">
          <h2>Chart Design</h2>
          <div className="j-card">
            <span className="j-tag ux">UX</span>
            <h3>Accuracy, up is good, rolling window</h3>
            <p>Shows accuracy (100 &minus; error) so up is always better.
            Rated titles = blue bars. &ldquo;Want to watch&rdquo; = green diamonds at y=85.
            &ldquo;Not interested&rdquo; = red diamonds at y=20. Indigo line = rolling average
            over last 5 decisions (not cumulative). Reference lines mark the two thresholds.
            Hand-rolled SVG, no library.</p>
          </div>
        </div>

        {/* FILES */}
        <div className="j-section">
          <h2>Files</h2>
          <ul className="j-file-list">
            {[
              ["app/page.tsx", "main UI — card, chart, prefetch queue, controls"],
              ["app/layout.tsx", "root layout — renders shared NavBar above all pages"],
              ["app/components/NavBar.tsx", "sticky nav bar with live watchlist count"],
              ["app/watchlist/page.tsx", "watchlist — poster, metadata, streaming pills, remove"],
              ["app/journal/page.tsx", "this page"],
              ["app/prompt/page.tsx", "reconstruction prompt with copy button"],
              ["app/api/next-movie/route.ts", "batch LLM pick + diversity lens + poster fetches"],
              ["app/api/next-movie/llm.ts", "callLLM(llm, systemPrompt, userMessage) for all providers"],
              ["app/api/next-movie/historySessionStore.ts", "server-side session cache so history isn't resent every request"],
              ["app/api/taste-summary/route.ts", "background taste profile generation (2nd person, ~256 tokens)"],
              ["app/api/streaming/route.ts", "streaming availability lookup"],
              ["app/api/config/route.ts", "returns which LLM keys are configured"],
            ].map(([file, desc]) => (
              <li key={file}>{file} <span>{desc}</span></li>
            ))}
          </ul>
        </div>

        {/* STACK */}
        <div className="j-section">
          <h2>Stack</h2>
          <div className="j-card">
            <p><strong>Framework:</strong> Next.js 16 (App Router, Turbopack)<br />
            <strong>LLMs:</strong> DeepSeek, Claude, GPT-4o, Gemini — selectable at runtime<br />
            <strong>Poster search:</strong> Serper Images API<br />
            <strong>Persistence:</strong> localStorage<br />
            <strong>Styling:</strong> Tailwind CSS v4<br />
            <strong>Chart:</strong> Hand-rolled SVG</p>
          </div>
        </div>

        {/* PROMPT LINK */}
        <div className="j-section">
          <h2>Reconstruction Prompt</h2>
          <div className="j-card">
            <span className="j-tag prompt">Prompt</span>
            <h3>Build this app from scratch</h3>
            <p>A complete specification you can paste into any coding agent to rebuild a near-identical app.</p>
            <p style={{ marginTop: 10 }}><a href="/prompt" style={{ color: "#7e22ce", fontWeight: 600 }}>Open prompt &rarr;</a></p>
          </div>
        </div>

      </div>
    </div>
  );
}
