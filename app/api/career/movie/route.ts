import { NextRequest, NextResponse } from "next/server";

const TMDB_KEY = process.env.TMDB_API_KEY;
const BASE = "https://api.themoviedb.org/3";

function orderedYoutubeCandidateKeys(
  ytVideos: { key: string; site: string; type: string; official?: boolean }[]
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (k: string | undefined) => { if (!k || seen.has(k)) return; seen.add(k); out.push(k); };
  const trailers = ytVideos.filter((v) => v.type === "Trailer");
  trailers.sort((a, b) => Number(!!b.official) - Number(!!a.official));
  for (const v of trailers) add(v.key);
  for (const v of ytVideos) add(v.key);
  return out;
}

async function youtubeOembedLooksOk(videoId: string): Promise<boolean | null> {
  try {
    const u = new URL("https://www.youtube.com/oembed");
    u.searchParams.set("url", `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`);
    u.searchParams.set("format", "json");
    const res = await fetch(u.toString(), { headers: { "User-Agent": "movie-recs/1.0" } });
    if (res.status === 404 || res.status === 401 || res.status === 403) return false;
    if (res.status >= 200 && res.status < 300) return true;
    return null;
  } catch { return null; }
}

async function findEmbeddableTrailer(tmdbId: number, type: "movie" | "tv"): Promise<string | null> {
  if (!TMDB_KEY) return null;
  try {
    const path = type === "tv" ? `tv/${tmdbId}/videos` : `movie/${tmdbId}/videos`;
    const res = await fetch(`${BASE}/${path}?api_key=${TMDB_KEY}`);
    if (!res.ok) return null;
    const data = (await res.json()) as {
      results?: { key: string; site: string; type: string; official?: boolean }[];
    };
    const ytVideos = (data.results ?? []).filter((v) => v.site === "YouTube");
    for (const key of orderedYoutubeCandidateKeys(ytVideos)) {
      const ok = await youtubeOembedLooksOk(key);
      if (ok !== false) return key;
    }
    return null;
  } catch { return null; }
}

export async function GET(req: NextRequest) {
  const tmdbId = parseInt(req.nextUrl.searchParams.get("tmdbId") ?? "");
  const type = (req.nextUrl.searchParams.get("type") ?? "movie") as "movie" | "tv";
  if (!tmdbId || !TMDB_KEY) return NextResponse.json({ error: "Missing params" }, { status: 400 });

  try {
    const path = type === "tv" ? `tv/${tmdbId}` : `movie/${tmdbId}`;
    const [detailRes, credRes, trailerKey] = await Promise.all([
      fetch(`${BASE}/${path}?api_key=${TMDB_KEY}&language=en-US`),
      fetch(`${BASE}/${path}/credits?api_key=${TMDB_KEY}&language=en-US`),
      findEmbeddableTrailer(tmdbId, type),
    ]);

    if (!detailRes.ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const detail = (await detailRes.json()) as {
      title?: string; name?: string;
      release_date?: string; first_air_date?: string;
      overview?: string;
      poster_path?: string | null;
      vote_average?: number;
    };

    const credits = credRes.ok
      ? (await credRes.json()) as {
          cast?: { name: string; order: number }[];
          crew?: { name: string; job: string }[];
        }
      : {};

    const title = detail.title || detail.name || "Untitled";
    const dateStr = detail.release_date || detail.first_air_date || "";
    const year = dateStr ? parseInt(dateStr.slice(0, 4)) : null;
    const director = credits.crew?.find((c) => c.job === "Director")?.name ?? null;
    const actors = (credits.cast ?? [])
      .sort((a, b) => a.order - b.order)
      .slice(0, 5)
      .map((c) => c.name);
    const posterUrl = detail.poster_path
      ? `https://image.tmdb.org/t/p/w500${detail.poster_path}`
      : null;

    return NextResponse.json({
      title,
      type,
      year,
      director,
      actors,
      plot: detail.overview ?? "",
      posterUrl,
      trailerKey: trailerKey ?? null,
      predictedRating: 3,
      rtScore: null,
      reason: null,
    });
  } catch (e) {
    console.error("[career/movie]", e);
    return NextResponse.json({ error: "Failed" }, { status: 500 });
  }
}
