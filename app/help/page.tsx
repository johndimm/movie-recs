import Link from "next/link";

export default function HelpPage() {
  return (
    <div className="min-h-screen bg-zinc-50 flex flex-col items-center py-6 sm:py-10 px-4">
      <div className="w-full max-w-3xl space-y-8">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src="/banner.png" alt="Trailer Vision" className="w-full rounded-2xl shadow-sm" />
        <div>
          <h1 className="text-xl sm:text-2xl font-bold text-zinc-900">Help</h1>
          <p className="text-sm text-zinc-500 mt-1">How to use Trailer Vision</p>
        </div>

        <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-5 sm:p-6 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Navigation</h2>
          <p className="text-sm text-zinc-600 leading-relaxed">
            The top bar is on every page:{" "}
            <strong className="text-zinc-800">App</strong>, <strong className="text-zinc-800">Watchlist</strong> (global saved titles),{" "}
            <strong className="text-zinc-800">Channels</strong>, <strong className="text-zinc-800">Settings</strong>,{" "}
            <strong className="text-zinc-800">Help</strong>. <Link href="/ratings" className="font-semibold text-zinc-800 underline-offset-2 hover:underline">Ratings</Link>{" "}
            is a separate page (not in the bar) with Seen / Watchlist / Not interested tabs.
          </p>
        </section>

        <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-5 sm:p-6 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Main screen</h2>
          <p className="text-sm text-zinc-600 leading-relaxed">
            You get a title with poster or trailer, plot, and Rotten Tomatoes when available. The rating strip is one line:{" "}
            <strong className="text-zinc-800">Seen it</strong> (red stars, half-star steps) — one tap submits if you&apos;ve seen it — then{" "}
            <strong className="text-zinc-800">Not yet</strong> (if you haven&apos;t) and <strong className="text-zinc-800">Next</strong> to skip without saving.
            After <strong className="text-zinc-800">Not yet</strong>, blue stars rate interest; use <strong className="text-zinc-800">I have seen it</strong> to go back.
            Unseen: high blue stars add the title to your watchlist; low stars mark not interested. The app learns from your history and suggests new titles.
          </p>
        </section>

        <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-5 sm:p-6 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Channels</h2>
          <p className="text-sm text-zinc-600 leading-relaxed">
            Create filters (genres, era, language, etc.) so recommendations stay on-topic. Pick a channel from
            the chips on the main page. Each channel is its own <strong className="text-zinc-800">recommendation island</strong>: its own
            prefetch queue (upcoming titles) and its own saved ratings, so the same film can end up with different stars
            in different channels when you&apos;re judging it under different taste lenses. Switching channels saves the old queue and restores the new one.
          </p>
        </section>

        <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-5 sm:p-6 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Upcoming queue</h2>
          <p className="text-sm text-zinc-600 leading-relaxed">
            Below the rating area you&apos;ll see titles waiting in line. The app refills in the background but keeps the buffer modest (on the order of a handful of cards) so new ratings affect upcoming picks sooner.{" "}
            <strong className="text-zinc-800">Click a row</strong> to jump to that title now; <strong className="text-zinc-800">Remove</strong> drops it without playing.
            The list is stored per channel and can be included when you export a backup in Settings.
          </p>
        </section>

        <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-5 sm:p-6 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Settings</h2>
          <p className="text-sm text-zinc-600 leading-relaxed">
            Choose movies vs TV, trailers vs posters, and which LLM to use. <strong className="text-zinc-800">Global request</strong> adds free-text
            instructions for every recommendation. <strong className="text-zinc-800">Export / Import</strong> saves your data as JSON (channels,
            queues, history, etc.); import overwrites only keys present in the file. <strong className="text-zinc-800">Reset</strong> clears everything.
          </p>
        </section>

        <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-5 sm:p-6 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Other pages</h2>
          <ul className="text-sm text-zinc-600 space-y-2 list-disc pl-5 leading-relaxed">
            <li>
              <Link href="/watchlist" className="font-semibold text-zinc-800 underline-offset-2 hover:underline">
                Watchlist
              </Link>
              {" — "}
              Full-page view of your <strong className="text-zinc-800">global</strong> watchlist (same data as Ratings → Watchlist): any channel can add titles here.
              Remove (×) moves a title to not interested and skipped.
            </li>
            <li>
              <Link href="/ratings" className="font-semibold text-zinc-800 underline-offset-2 hover:underline">
                Ratings
              </Link>
              {" — "}
              Three tabs: <strong className="text-zinc-800">Seen</strong> (your stars and signed delta vs the AI, with sorting; click a row to re-rate on the home page),{" "}
              <strong className="text-zinc-800">Watchlist</strong>, and <strong className="text-zinc-800">Not interested</strong>.
            </li>
            <li>
              <Link href="/channels" className="font-semibold text-zinc-800 underline-offset-2 hover:underline">
                Channels
              </Link>
              {" — "}
              Define filters per channel and open <strong className="text-zinc-800">Channel history</strong>: seen rows match Ratings → Seen (delta + sort); unseen rows show blue-star interest and pills (
              <strong className="text-zinc-800">Added</strong> / <strong className="text-zinc-800">Not on list</strong> for saves, <strong className="text-zinc-800">Not interested</strong> for passes).{" "}
              <strong className="text-zinc-800">Add to watchlist</strong> uses a minimum interest threshold and adds titles <em>not</em> already on your global watchlist (high-interest skips and removed saves you want back). Create or delete channels here.
            </li>
          </ul>
        </section>

        <section className="bg-white rounded-2xl border border-zinc-200 shadow-sm p-5 sm:p-6 space-y-3">
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">For developers</h2>
          <p className="text-sm text-zinc-600 leading-relaxed">
            Internal notes and the original build prompts live on separate pages (not needed for day-to-day use).
          </p>
          <ul className="flex flex-col sm:flex-row gap-3 pt-1">
            <li>
              <Link
                href="/journal"
                className="inline-flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 transition-colors"
              >
                Dev Journal
              </Link>
            </li>
            <li>
              <Link
                href="/prompt"
                className="inline-flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-2.5 text-sm font-medium text-zinc-800 hover:bg-zinc-100 transition-colors"
              >
                Prompt History
              </Link>
            </li>
          </ul>
        </section>
      </div>
    </div>
  );
}
