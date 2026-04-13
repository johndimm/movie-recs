"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const WATCHLIST_KEY = "movie-recs-watchlist";

const LINKS = [
  { href: "/",          label: "App" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/journal",   label: "Journal" },
  { href: "/prompt",    label: "Prompt" },
];

export default function NavBar() {
  const pathname = usePathname();
  const [watchlistCount, setWatchlistCount] = useState(0);

  useEffect(() => {
    const read = () => {
      try {
        const stored = localStorage.getItem(WATCHLIST_KEY);
        setWatchlistCount(stored ? JSON.parse(stored).length : 0);
      } catch {}
    };
    read();
    window.addEventListener("storage", read);
    return () => window.removeEventListener("storage", read);
  }, []);

  return (
    <nav className="w-full border-b border-zinc-200 bg-white/80 backdrop-blur-sm sticky top-0 z-40">
      <div className="max-w-3xl mx-auto px-4 flex items-center gap-1 h-11">
        <span className="font-bold text-zinc-900 mr-3 text-sm tracking-tight">Movie Recs</span>
        {LINKS.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors ${
                active
                  ? "bg-zinc-900 text-white"
                  : "text-zinc-500 hover:text-zinc-900 hover:bg-zinc-100"
              }`}
            >
              {label}
              {label === "Watchlist" && watchlistCount > 0 && (
                <span className={`ml-1.5 text-xs font-bold px-1.5 py-0.5 rounded-full ${active ? "bg-white/20 text-white" : "bg-blue-100 text-blue-700"}`}>
                  {watchlistCount}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
