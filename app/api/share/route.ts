import { NextRequest, NextResponse } from "next/server";

const KV_URL = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;
const TTL = 60 * 60 * 24 * 30; // 30 days

// In-memory fallback for local dev (not persisted across restarts)
const localStore = new Map<string, string>();

async function kvSet(key: string, value: string): Promise<void> {
  if (!KV_URL || !KV_TOKEN) { localStore.set(key, value); return; }
  await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([["SET", key, value, "EX", TTL]]),
  });
}

async function kvGet(key: string): Promise<string | null> {
  if (!KV_URL || !KV_TOKEN) return localStore.get(key) ?? null;
  const res = await fetch(`${KV_URL}/pipeline`, {
    method: "POST",
    headers: { Authorization: `Bearer ${KV_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify([["GET", key]]),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as [{ result: string | null }];
  return data[0]?.result ?? null;
}

function randomId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const id = randomId();
    await kvSet(`share:${id}`, JSON.stringify(body));
    return NextResponse.json({ id });
  } catch {
    return NextResponse.json({ error: "Failed to create share" }, { status: 500 });
  }
}

export async function GET(req: NextRequest) {
  const id = req.nextUrl.searchParams.get("id");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  const raw = await kvGet(`share:${id}`);
  if (!raw) return NextResponse.json({ error: "Not found" }, { status: 404 });
  try {
    return NextResponse.json(JSON.parse(raw));
  } catch {
    return NextResponse.json({ error: "Corrupt share" }, { status: 500 });
  }
}
