/** What the navigation checker records (e2e/navmap.nav.ts) and reports (navmapReport.ts). */

export const DIRS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'] as const;
export type Dir = (typeof DIRS)[number];

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface LeafInfo {
  key: string;
  label: string;
  /** The group it sits in, as a person would name it ("Rail: Movies", "Top bar"). */
  group: string;
  heading: string;
  boundary: string | null;
  parents: string[];
  /** Where it was when the screen arrived (viewport pixels). */
  rect: Rect;
  /** False when the checker did not press arrows from it (sampled out, or the shared top bar). */
  walked: boolean;
}

export interface Move {
  from: string;
  dir: Dir;
  /** The focus key now focused (the same as `from` when nothing moved). */
  to: string;
  toLabel: string;
  toHeading: string;
  flags: string[];
  /** Where the control ended up, kept when a position flag was raised. */
  after?: {
    top: number;
    bottom: number;
    barBottom: number;
    viewportHeight: number;
    headingTop: number | null;
  };
}

export interface LagResult {
  name: string;
  keyHeld: string;
  presses: number;
  maxOutsidePx: number;
  msUntilVisibleAfterKeyUp: number;
}

export interface ScreenResult {
  id: string;
  name: string;
  /** How the screen was reached: by arrows and OK from Home, via the probe's setFocus, or not at all. */
  how: 'keyboard' | 'probe' | 'skipped';
  note: string;
  landing: string | null;
  sampled: string | null;
  seconds: number;
  leaves: LeafInfo[];
  moves: Move[];
  unreachable: string[];
  trapped: string[];
  flagCounts: Record<string, number>;
  /** When the moves were copied from another system's identical screen rather than pressed again. */
  reusedFrom: string | null;
}

export interface SystemResult {
  system: string;
  engine: string;
  seconds: number;
  screens: ScreenResult[];
  lag: LagResult[];
}
