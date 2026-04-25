import { NextRequest, NextResponse } from "next/server";

const TMDB_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";

export interface CareerFilm {
  tmdbId: number;
  title: string;
  year: number | null;
  type: "movie" | "tv";
  posterUrl: string | null;
}

export async function GET(req: NextRequest) {
  const name = req.nextUrl.searchParams.get("name");
  const role = req.nextUrl.searchParams.get("role") as "actor" | "director" | null;
  if (!name || !role) return NextResponse.json({ error: "Missing params" }, { status: 400 });
  if (!TMDB_KEY) return NextResponse.json({ error: "No TMDB key" }, { status: 503 });

  try {
    const searchRes = await fetch(
      `${BASE}/search/person?api_key=${TMDB_KEY}&query=${encodeURIComponent(name)}&language=en-US`
    );
    if (!searchRes.ok) return NextResponse.json({ error: "Person not found" }, { status: 404 });
    const searchData = (await searchRes.json()) as {
      results?: { id: number; name: string }[];
    };
    const person = searchData.results?.[0];
    if (!person) return NextResponse.json({ error: "Person not found" }, { status: 404 });

    const credRes = await fetch(
      `${BASE}/person/${person.id}/combined_credits?api_key=${TMDB_KEY}&language=en-US`
    );
    if (!credRes.ok) return NextResponse.json({ error: "Credits not found" }, { status: 404 });

    type RawCredit = {
      id: number;
      title?: string;
      name?: string;
      release_date?: string;
      first_air_date?: string;
      media_type: string;
      poster_path?: string | null;
      job?: string;
    };
    const credData = (await credRes.json()) as { cast?: RawCredit[]; crew?: RawCredit[] };

    const raw: RawCredit[] =
      role === "actor"
        ? (credData.cast ?? [])
        : (credData.crew ?? []).filter((c) => c.job === "Director");

    const seen = new Set<number>();
    const films: CareerFilm[] = raw
      .filter((c) => {
        if (c.media_type !== "movie" && c.media_type !== "tv") return false;
        if (seen.has(c.id)) return false;
        seen.add(c.id);
        return true;
      })
      .map((c) => {
        const dateStr = c.release_date || c.first_air_date || "";
        const year = dateStr ? parseInt(dateStr.slice(0, 4)) : null;
        return {
          tmdbId: c.id,
          title: c.title || c.name || "Untitled",
          year,
          type: c.media_type as "movie" | "tv",
          posterUrl: c.poster_path ? `https://image.tmdb.org/t/p/w185${c.poster_path}` : null,
        };
      })
      .filter((f) => f.year !== null)
      .sort((a, b) => (a.year ?? 0) - (b.year ?? 0));

    return NextResponse.json({ personId: person.id, personName: person.name, films });
  } catch (e) {
    console.error("[career]", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
