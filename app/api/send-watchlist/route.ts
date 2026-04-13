import { Resend } from "resend";

const resend = new Resend(process.env.RESEND_API_KEY);

interface WatchlistEntry {
  title: string;
  type: "movie" | "tv";
  year: number | null;
  director: string | null;
  actors: string[];
  plot: string;
  posterUrl: string | null;
  rtScore: string | null;
  streaming: string[];
}

function renderHtml(entries: WatchlistEntry[]): string {
  const rows = entries.map((e) => {
    const meta = [
      e.type === "tv" ? "TV Series" : "Movie",
      e.year ? String(e.year) : null,
      e.rtScore ? `🍅 ${e.rtScore}` : null,
    ].filter(Boolean).join(" · ");

    const director = e.director
      ? `<p style="margin:4px 0 0;font-size:13px;color:#666;">${e.type === "tv" ? "Created by" : "Dir."} ${e.director}</p>`
      : "";

    const cast = e.actors.length
      ? `<p style="margin:4px 0 0;font-size:13px;color:#666;">${e.actors.join(" · ")}</p>`
      : "";

    const plot = e.plot
      ? `<p style="margin:8px 0 0;font-size:14px;color:#444;line-height:1.5;">${e.plot}</p>`
      : "";

    const streaming = e.streaming?.length
      ? `<p style="margin:8px 0 0;font-size:13px;">` +
        e.streaming.map((s) => `<span style="display:inline-block;background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:99px;padding:2px 10px;margin:2px 4px 2px 0;font-size:12px;font-weight:600;">${s}</span>`).join("") +
        `</p>`
      : "";

    const poster = e.posterUrl
      ? `<img src="${e.posterUrl}" alt="${e.title}" style="width:80px;border-radius:8px;object-fit:cover;flex-shrink:0;" />`
      : "";

    return `
      <div style="background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:16px;margin-bottom:16px;display:flex;gap:16px;align-items:flex-start;">
        ${poster}
        <div style="flex:1;min-width:0;">
          <p style="margin:0 0 2px;font-size:11px;font-weight:600;color:#9ca3af;text-transform:uppercase;letter-spacing:.05em;">${meta}</p>
          <h2 style="margin:0;font-size:18px;font-weight:700;color:#111;">${e.title}</h2>
          ${director}${cast}${plot}${streaming}
        </div>
      </div>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"/></head>
<body style="margin:0;padding:32px 24px;background:#f9fafb;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">
  <div style="max-width:600px;margin:0 auto;">
    <h1 style="font-size:24px;font-weight:700;color:#111;margin:0 0 4px;">My Watchlist</h1>
    <p style="font-size:14px;color:#6b7280;margin:0 0 24px;">${entries.length} title${entries.length !== 1 ? "s" : ""} to watch</p>
    ${rows}
    <p style="font-size:12px;color:#9ca3af;margin-top:32px;text-align:center;">Sent from Movie Recs · Streaming availability may have changed.</p>
  </div>
</body>
</html>`;
}

const ALLOWED_TO = process.env.RESEND_TO_EMAIL ?? "john.r.dimm@gmail.com";

export async function POST(request: Request) {
  const { to, entries }: { to: string; entries: WatchlistEntry[] } = await request.json();

  if (!to || !entries?.length) {
    return Response.json({ error: "Missing 'to' or 'entries'" }, { status: 400 });
  }

  if (to.toLowerCase() !== ALLOWED_TO.toLowerCase()) {
    return Response.json(
      { error: `Until a sending domain is verified in Resend, emails can only be sent to ${ALLOWED_TO}.` },
      { status: 403 }
    );
  }

  try {
    const { data, error } = await resend.emails.send({
      from: "Movie Recs <onboarding@resend.dev>",
      to,
      subject: `Your watchlist — ${entries.length} title${entries.length !== 1 ? "s" : ""}`,
      html: renderHtml(entries),
    });

    if (error) {
      console.error("Resend error:", error);
      return Response.json({ error }, { status: 500 });
    }

    return Response.json({ id: data?.id });
  } catch (err) {
    console.error("send-watchlist failed:", err);
    return Response.json({ error: String(err) }, { status: 500 });
  }
}
