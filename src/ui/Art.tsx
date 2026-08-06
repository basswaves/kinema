/**
 * An image that prefers the locally cached copy and falls back to the remote
 * URL.
 *
 * Every artwork field arrives from Rust as a pair — the provider URL and the
 * path of the cached file, if one exists. Going through a single component
 * means the fallback rule lives in one place instead of being re-decided at
 * each of the five call sites.
 *
 * The `onError` fallback is the part that earns its keep: a cache row can
 * outlive its file (the directory was cleared by hand, app data moved). Without
 * it the poster would simply vanish, even though the URL it came from still
 * works.
 */
import { convertFileSrc } from '@tauri-apps/api/core';
import { useState, type ReactNode } from 'react';

interface Props {
  /** Absolute path to the cached file, from the `*_path` field. */
  local: string | null;
  /** The provider URL, from the `*_url` field. */
  remote: string | null;
  className?: string;
  /** Rendered when there is no artwork at all. */
  fallback?: ReactNode;
  lazy?: boolean;
}

export default function Art({ local, remote, className, fallback = null, lazy }: Props) {
  // Tracking *which* source failed rather than a boolean means this resets by
  // itself when the props change — no effect, no stale "broken" state.
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  const localSrc = local ? convertFileSrc(local) : null;
  const src = localSrc && localSrc !== failedSrc ? localSrc : remote;

  if (!src) return <>{fallback}</>;

  return (
    <img
      className={className}
      src={src}
      alt=""
      draggable={false}
      loading={lazy ? 'lazy' : undefined}
      onError={() => {
        // Falling back silently would make a broken asset protocol look exactly
        // like a working one — the images still appear, just fetched over the
        // network again. devlog puts this in app.log, so the difference is
        // visible from outside the webview.
        if (src === localSrc) console.warn(`artwork: cached copy failed, using ${remote}`, local);
        setFailedSrc(src);
      }}
    />
  );
}
