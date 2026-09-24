/**
 * The life of one file in the player, as a single state machine.
 *
 * Every rule here used to live in a different corner of `Player.tsx`, held in
 * a mix of React state and refs that mirrored that state for the mpv
 * listeners: `fileReady` and `fileReadyRef`, `frameShown` and
 * `sawFileLoaded`, `endHandled`, `seekingRef`, `latest`. Most of the player
 * entries in docs/GOTCHAS.md are about those copies disagreeing for a tick —
 * the outgoing file's position read as the incoming one's, a first frame that
 * belonged to the previous episode, an end handled twice or not at all.
 *
 * Now every mpv event and every user action that affects the file's life is
 * an `Event`, and `reduce` is the only thing that decides what it means. It is
 * pure, so the rules are tested directly (session.test.ts) rather than
 * inferred from a running player.
 *
 * What it deliberately does **not** own: skip markers, the Up next offer and
 * the countdown. Those are derived from this state (`skip.ts` decides what is
 * active from `open` and `timePos`) rather than being part of the file's life.
 */

export interface Session {
  /** The file this session is for — the player's target. */
  path: string;
  /** Bumped on every new target, so effects can tell sessions apart. */
  seq: number;
  /**
   * mpv has reported `file-loaded` since this session began. Not yet proof
   * that the open file is this one: a late event from the outgoing file can
   * arrive after the reset. `open` is the proof.
   */
  loaded: boolean;
  /**
   * The open file is this session's, and its position and length have been
   * read from mpv directly. Until then every pushed `time-pos` and `duration`
   * describes the outgoing file and is ignored.
   */
  open: boolean;
  /** Its first frame is up, so the black cover can come off. */
  frameShown: boolean;
  timePos: number | null;
  duration: number | null;
  paused: boolean;
  /** The seek bar is being dragged: pushes would fight the thumb. */
  scrubbing: boolean;
  /**
   * The file has ended — naturally, or because its credits were skipped. Set
   * once per session; the end-of-file handling runs when it becomes true and
   * never again for this file.
   */
  ended: boolean;
  /** Where playback resumed from, for the toast; cleared when it has shown. */
  resumedFrom: number | null;
  error: string | null;
}

export type Event =
  /** A new target: forget everything about the previous file. */
  | { type: 'load'; path: string }
  | { type: 'file-loaded' }
  /**
   * The open file's own position and length, read on `file-loaded`. `path`
   * is what mpv says it has open; a mismatch means the event belonged to the
   * outgoing file.
   */
  | { type: 'opened'; path: string | null; timePos: number | null; duration: number | null; resumedFrom: number | null }
  | { type: 'playback-restart' }
  /** No first frame in time — a file with no video, or an event that never came. */
  | { type: 'cover-timeout' }
  | { type: 'time-pos'; value: number | null }
  | { type: 'duration'; value: number | null }
  | { type: 'pause'; value: boolean }
  /** `eof-reached`, from the observer or the poll, or `end-file` with reason `eof`. */
  | { type: 'eof' }
  /** The credits were skipped: the same end as a natural one. */
  | { type: 'end-early' }
  | { type: 'error'; message: string }
  | { type: 'scrub-start' }
  | { type: 'scrub'; timePos: number }
  | { type: 'scrub-end' }
  | { type: 'resume-shown' };

export function initialSession(path: string): Session {
  return {
    path,
    seq: 0,
    loaded: false,
    open: false,
    frameShown: false,
    timePos: null,
    duration: null,
    paused: false,
    scrubbing: false,
    ended: false,
    resumedFrom: null,
    error: null,
  };
}

/**
 * Whether mpv's idea of the open file is this session's. Separators and case
 * are ignored — Windows paths compare that way — and an unknown path (the
 * read failed) is given the benefit of the doubt, because refusing it would
 * leave the file unable ever to count as open.
 */
export function samePath(open: string | null, wanted: string): boolean {
  if (open === null) return true;
  const norm = (p: string) => p.replace(/\//g, '\\').toLowerCase();
  return norm(open) === norm(wanted);
}

export function reduce(state: Session, event: Event): Session {
  switch (event.type) {
    case 'load':
      // Pause state carries over: it belongs to mpv, not to the file.
      return { ...initialSession(event.path), seq: state.seq + 1, paused: state.paused };

    case 'file-loaded':
      return state.loaded ? state : { ...state, loaded: true };

    case 'opened':
      if (!state.loaded || state.open || !samePath(event.path, state.path)) return state;
      return {
        ...state,
        open: true,
        timePos: event.timePos ?? 0,
        duration: event.duration,
        resumedFrom: event.resumedFrom,
      };

    case 'playback-restart':
      // Only after `file-loaded`: a restart belonging to the outgoing file
      // must not uncover the gap before the new one.
      return state.loaded && !state.frameShown ? { ...state, frameShown: true } : state;

    case 'cover-timeout':
      return state.frameShown ? state : { ...state, frameShown: true };

    case 'time-pos':
      if (!state.open || state.scrubbing) return state;
      return { ...state, timePos: event.value };

    case 'duration':
      if (!state.open) return state;
      return { ...state, duration: event.value };

    case 'pause':
      return state.paused === event.value ? state : { ...state, paused: event.value };

    case 'eof':
    case 'end-early':
      // Once per file, and only for this file: during a change of episode
      // the outgoing one is still reporting that it has ended.
      if (!state.open || state.ended) return state;
      return { ...state, ended: true };

    case 'error':
      return { ...state, error: event.message };

    case 'scrub-start':
      return { ...state, scrubbing: true };

    case 'scrub':
      return state.duration ? { ...state, timePos: event.timePos } : state;

    case 'scrub-end':
      return { ...state, scrubbing: false };

    case 'resume-shown':
      return { ...state, resumedFrom: null };
  }
}
