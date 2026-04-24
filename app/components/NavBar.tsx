"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Player" },
  { href: "/channels", label: "Channels" },
  { href: "/history", label: "History" },
  { href: "/watchlist", label: "Watchlist" },
  { href: "/settings", label: "Settings" },
  { href: "/help", label: "Help" },
];

export default function NavBar() {
  const pathname = usePathname();

  return (
    <nav className="w-full min-w-0 border-b border-zinc-800 bg-black/90 backdrop-blur-sm sticky top-0 z-40">
      <div className="max-w-3xl mx-auto min-w-0 px-4 h-11 flex items-center">
        <div className="min-w-0 flex-1 overflow-x-auto overscroll-x-contain [scrollbar-width:none] [-ms-overflow-style:none] [&::-webkit-scrollbar]:hidden">
          <div className="flex w-max min-h-11 items-center gap-1 pr-1">
            <span className="font-bold text-zinc-100 mr-2 shrink-0 text-sm tracking-tight hidden sm:inline">
              Trailer Vision
            </span>
            {LINKS.map(({ href, label }) => {
              const active = pathname === href;
              return (
                <Link
                  key={href}
                  href={href}
                  className={`shrink-0 px-2.5 py-1 sm:px-3 rounded-lg text-sm font-medium transition-colors ${
                    active
                      ? "bg-zinc-700 text-white"
                      : "text-zinc-400 hover:text-white hover:bg-zinc-800"
                  }`}
                >
                  {label}
                </Link>
              );
            })}
          </div>
        </div>
      </div>
    </nav>
  );
}
