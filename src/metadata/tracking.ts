/**
 * The watch-tracking services — the typed side of `src-tauri/src/simkl.rs`
 * and `src-tauri/src/trakt.rs`.
 *
 * One way: Kinema tells an account what was finished, and nothing comes back.
 * Everything that talks to a service is in Rust; this is the page's half of
 * signing in, and what it shows. Both services answer the same five commands,
 * named after them (`simkl_status`, `trakt_status`, …).
 */
import { invoke } from '@tauri-apps/api/core';

export type Service = 'simkl' | 'trakt';

/** Setting keys for an app of one's own, for a build without one. */
export const SIMKL_CLIENT_ID_KEY = 'simkl_client_id';
export const TRAKT_CLIENT_ID_KEY = 'trakt_client_id';
export const TRAKT_CLIENT_SECRET_KEY = 'trakt_client_secret';

export interface AccountStatus {
  /** This copy of Kinema has an app for the service, so connecting is possible. */
  available: boolean;
  connected: boolean;
  /** The service refused the sign-in Kinema held: connect again. */
  needs_reconnect: boolean;
  /** The account's name, when the service said it. */
  user: string | null;
  /** Finished films and episodes the service has not accepted yet. */
  waiting: number;
  last_sent_at: number | null;
}

/** What to show while waiting for the person to approve on their phone. */
export interface DeviceCode {
  /** The code, shown exactly as the service gave it. */
  user_code: string;
  verification_uri: string;
  /** The page to open — with the code filled in where the service allows. */
  verification_uri_complete: string;
  expires_in: number;
  qr_svg: string | null;
}

export type PollOutcome = 'waiting' | 'connected' | 'expired' | 'denied' | 'refused' | 'failed';

export interface AccountApi {
  status: () => Promise<AccountStatus>;
  startConnect: () => Promise<DeviceCode>;
  /** Ask once. Rust decides whether it is time to ask the service itself. */
  pollConnect: () => Promise<PollOutcome>;
  cancelConnect: () => Promise<void>;
  disconnect: () => Promise<void>;
}

export function accountApi(service: Service): AccountApi {
  return {
    status: () => invoke<AccountStatus>(`${service}_status`),
    startConnect: () => invoke<DeviceCode>(`${service}_start_connect`),
    pollConnect: () => invoke<PollOutcome>(`${service}_poll_connect`),
    cancelConnect: () => invoke<void>(`${service}_cancel_connect`),
    disconnect: () => invoke<void>(`${service}_disconnect`),
  };
}

/** SIMKL's status, for the self-test, which must see it unavailable. */
export const simklStatus = () => accountApi('simkl').status();
export const traktStatus = () => accountApi('trakt').status();

/**
 * How often the page asks. Rust answers "waiting" without asking the service
 * until the service's own interval has passed, so this only sets how soon an
 * approval is noticed.
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
