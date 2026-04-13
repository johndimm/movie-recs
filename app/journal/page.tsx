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
          <p style={{ marginTop: 6, fontSize: "0.875rem", color: "#888" }}>Dev Journal &mdash; Sunday, April 12, 2026</p>
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
            { tag: "ux", title: "Reveal popup after rating", body: "The AI prediction and error were easy to miss when they appeared above the fold. A modal now pops up immediately after submitting a rating, showing your score, the AI's prediction, and the error in large type. It auto-dismisses when the next card loads. A perfect prediction (error = 0) triggers a special gold celebration modal with a randomised congratulatory message." },
            { tag: "ux", title: "Clear labeling of \"seen\" vs \"not seen\" sections", body: "After watching someone use the app, it was clear the two halves of the card were ambiguous. The rating slider is now inside a box labeled \"I've seen it — rate it\" and the two skip buttons are in a separate box labeled \"Haven't seen it\". \"Want to watch\" is green-tinted to signal it's a save action." },
            { tag: "feature", title: "Movie details: poster, cast, plot, director, year", body: "You asked for the main actors, a plot summary, director, release year, and a poster on each card. The LLM returns all metadata as structured JSON; the Serper image search API fetches a poster (year included in the query to avoid getting a different version). The card became a proper movie entry rather than a bare title." },
            { tag: "feature", title: "Rotten Tomatoes score", body: "You wanted a professional rating to show alongside yours after the reveal. The LLM returns the RT Tomatometer from its training knowledge (e.g. \"91%\"). A 🍅 / 💀 badge renders on the card, giving immediate external context for how your taste compares to critics." },
            { tag: "feature", title: "Two kinds of \"haven't seen it\"", body: "You identified two distinct signals: films you want to see (LLM got your taste right — a positive outcome, score 85/100) vs films you have no interest in (LLM missed entirely — score 20/100). \"Want to watch\" adds to the watchlist. \"Not interested\" is discarded. Both are excluded from future picks." },
            { tag: "feature", title: "Watchlist with streaming info", body: "Titles marked \"Want to watch\" are saved to a persistent watchlist with full metadata. On save, the selected LLM is asked which streaming services carry the title in the US; results appear as blue pills on the watchlist page." },
            { tag: "feature", title: "Shared navigation bar", body: "A sticky nav bar at the top of every page (rendered in app/layout.tsx) links to App, Watchlist, Journal, and Prompt. The watchlist link shows a live count badge read from localStorage. The active page is highlighted. All navigation stays in the same tab — no target=_blank needed." },
            { tag: "feature", title: "System/user prompt split with Anthropic caching", body: "callLLM() was refactored from a single prompt argument to (systemPrompt, userMessage). The stable instruction block goes in the system prompt with cache_control: { type: 'ephemeral' } and the anthropic-beta: prompt-caching-2024-07-31 header — Anthropic only re-bills the system prompt on cache miss. OpenAI caches prefixes ≥1024 tokens automatically. Gemini uses the systemInstruction field. The split also makes the per-request payload smaller." },
            { tag: "feature", title: "Smooth transitions + \"LLM is thinking\" indicator", body: "While the next title loads, the current card dims to 45% opacity so the layout doesn't jump. A fixed pill at the bottom reads \"LLM is thinking…\" with bouncing dots, visible regardless of scroll position. When the response arrives, the card fades out, content swaps, then fades back in." },
            { tag: "feature", title: "Media type filter and LLM selector", body: "A segmented control restricts picks to Movies, TV Series, or both. If the current card doesn't match a newly selected type, a fresh fetch fires immediately. A second control lists every LLM whose API key is present in .env (DeepSeek, Claude, GPT-4o, Gemini); the selection is live." },
            { tag: "feature", title: "Poster lightbox", body: "The poster renders at w-72 on the card. Clicking it opens a full-screen lightbox (black overlay, Escape to close). Page max-width is max-w-3xl to give the poster room without making the text too wide." },
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
              ["app/page.tsx", "main UI — card, chart, reveal modal, controls"],
              ["app/layout.tsx", "root layout — renders shared NavBar above all pages"],
              ["app/components/NavBar.tsx", "sticky nav bar with live watchlist count"],
              ["app/watchlist/page.tsx", "watchlist — poster, metadata, streaming pills, remove"],
              ["app/journal/page.tsx", "this page"],
              ["app/prompt/page.tsx", "reconstruction prompt with copy button"],
              ["app/api/next-movie/route.ts", "LLM pick + poster fetch"],
              ["app/api/next-movie/llm.ts", "callLLM(llm, systemPrompt, userMessage) for all providers"],
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
