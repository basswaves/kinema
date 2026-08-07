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
  /**
   * Rendered when there is no artwork at all — *or* when every source has been
   * tried and failed. Both are "there is no picture here", and a caller that
   * has something to show instead should get to show it in either case.
   */
  fallback?: ReactNode;
  lazy?: boolean;
  /** Describes the image where it carries meaning, as a logo does. */
  alt?: string;
}

export default function Art({
  local,
  remote,
  className,
  fallback = null,
  lazy,
  alt = '',
}: Props) {
  // The set of sources that have failed, keyed by URL. Keying by URL rather
  // than counting attempts means new props are retried automatically — the new
  // URLs are simply not in the set — with no effect and no stale broken state.
  const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());

  const localSrc = local ? convertFileSrc(local) : null;
  // Local first, remote second: the cache is an accelerator, the URL the truth.
  const sources = [localSrc, remote].filter((s): s is string => Boolean(s));
  const src = sources.find((candidate) => !failed.has(candidate)) ?? null;

  if (!src) return <>{fallback}</>;

  return (
    <img
      className={className}
      src={src}
      alt={alt}
      draggable={false}
      loading={lazy ? 'lazy' : undefined}
      onError={() => {
        // Falling back silently would make a broken asset protocol look exactly
        // like a working one — the images still appear, just fetched over the
        // network again. devlog puts this in app.log, so the difference is
        // visible from outside the webview.
        if (src === localSrc) console.warn(`artwork: cached copy failed, using ${remote}`, local);
        // Each source is marked failed exactly once, so this terminates. The
        // previous version tracked a single failed source and flipped between
        // the two forever when *both* were broken — offline with a half-built
        // cache, which is precisely when it mattered.
        setFailed((previous) => new Set(previous).add(src));
      }}
    />
  );
}
