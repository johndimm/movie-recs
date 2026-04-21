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
    <nav className="w-full border-b border-zinc-800 bg-black/90 backdrop-blur-sm sticky top-0 z-40">
      <div className="max-w-3xl mx-auto px-4 flex items-center gap-1 h-11">
        <span className="font-bold text-zinc-100 mr-3 text-sm tracking-tight hidden sm:inline">Trailer Vision</span>
        {LINKS.map(({ href, label }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={`px-3 py-1 rounded-lg text-sm font-medium transition-colors ${
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
    </nav>
  );
}
