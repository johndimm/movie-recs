"use client";

import { useEffect } from "react";

type Tone = "default" | "danger";

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  onConfirm,
  onCancel,
  tone = "default",
  showCancel = true,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  tone?: Tone;
  /** When false, only the confirm button is shown (alert-style). */
  showCancel?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  const confirmBtn =
    tone === "danger"
      ? "rounded-lg bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-400 focus-visible:ring-offset-2"
      : "rounded-lg bg-zinc-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-zinc-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-400 focus-visible:ring-offset-2";

  const cancelBtn =
    "rounded-lg border border-zinc-200 bg-white px-3 py-1.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-zinc-300 focus-visible:ring-offset-2";

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="confirm-dialog-title"
    >
      <button
        type="button"
        className="absolute inset-0 bg-black/45"
        aria-label="Dismiss"
        onClick={onCancel}
      />
      <div className="relative w-full max-w-md rounded-2xl border border-zinc-200 bg-white p-5 shadow-xl">
        <h2 id="confirm-dialog-title" className="text-base font-semibold text-zinc-900">
          {title}
        </h2>
        <div className="mt-2 text-sm leading-relaxed text-zinc-600">{children}</div>
        <div className="mt-6 flex flex-wrap justify-end gap-2">
          {showCancel && (
            <button type="button" className={cancelBtn} onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          <button type="button" className={confirmBtn} onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
