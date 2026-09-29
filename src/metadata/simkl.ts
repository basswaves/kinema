/**
 * SIMKL — the typed side of `src-tauri/src/simkl.rs`.
 *
 * One way: Kinema tells a SIMKL account what was finished, and nothing comes
 * back. Everything that talks to SIMKL is in Rust; this is the page's half of
 * signing in, and what it shows.
 */
import { invoke } from '@tauri-apps/api/core';

/** Setting key: an app ID of the user's own, for a build without one. */
export const SIMKL_CLIENT_ID_KEY = 'simkl_client_id';

export interface SimklStatus {
  /** This copy of Kinema has an app ID, so connecting is possible. */
  available: boolean;
  connected: boolean;
  /** SIMKL refused the sign-in Kinema held: connect again. */
  needs_reconnect: boolean;
  /** The account's name, when SIMKL said it. */
  user: string | null;
  /** Finished films and episodes SIMKL has not accepted yet. */
  waiting: number;
  last_sent_at: number | null;
}

/** What to show while waiting for the person to approve on their phone. */
export interface DeviceCode {
  /** `XXXX-YYYY`, shown exactly as SIMKL gave it. */
  user_code: string;
  verification_uri: string;
  /** The same page with the code filled in; what the QR code holds. */
  verification_uri_complete: string;
  expires_in: number;
  qr_svg: string | null;
}

export type PollOutcome = 'waiting' | 'connected' | 'expired' | 'refused' | 'failed';

export const simklStatus = () => invoke<SimklStatus>('simkl_status');
export const simklStartConnect = () => invoke<DeviceCode>('simkl_start_connect');
/** Ask once. Rust decides whether it is time to ask SIMKL itself. */
export const simklPollConnect = () => invoke<PollOutcome>('simkl_poll_connect');
export const simklCancelConnect = () => invoke<void>('simkl_cancel_connect');
export const simklDisconnect = () => invoke<void>('simkl_disconnect');

/**
 * How often the page asks. Rust answers "waiting" without asking SIMKL until
 * SIMKL's own interval has passed, so this only sets how soon an approval is
 * noticed.
 */
export const POLL_EVERY_MS = 2000;

/** `m:ss` left on the code. */
export function countdown(secondsLeft: number): string {
  const s = Math.max(0, Math.floor(secondsLeft));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** The QR code as an image source, so no markup is put into the page. */
export function qrSource(svg: string | null): string | null {
  return svg ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` : null;
}
