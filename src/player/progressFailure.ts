/**
 * When the resume point cannot be kept (A5-03): the data folder is full or
 * cannot be written. Said once on screen in plain words, logged with the
 * reason, and the saving carries on every few seconds, so it mends itself as
 * soon as the folder can be written again. Kinema does not say what it does
 * not know: only the two causes the system's own error names get a cause.
 */

export function saveFailureNotice(error: unknown): string {
  const why = String(error instanceof Error ? error.message : error).toLowerCase();
  const head = 'Your place in this film cannot be kept right now';
  if (why.includes('full') || why.includes('no space')) {
    return `${head}: the disk is full. Kinema keeps trying, and keeps it once there is room.`;
  }
  if (why.includes('readonly') || why.includes('read-only') || why.includes('permission')) {
    return `${head}: Kinema's folder cannot be written to. Kinema keeps trying, and keeps it once it can.`;
  }
  return `${head}. Kinema keeps trying, and keeps it once it can.`;
}

/** Tracks a run of failed saves: one notice and one log line per run. */
export function createSaveWatch(
  say: ((text: string) => void) | null,
  log: (text: string, error?: unknown) => void
) {
  let failing = false;
  return {
    failed(error: unknown) {
      if (failing) return;
      failing = true;
      log('progress: could not save the resume point; will keep trying', error);
      say?.(saveFailureNotice(error));
    },
    saved() {
      if (!failing) return;
      failing = false;
      log('progress: saving works again');
    },
  };
}
