/**
 * Settings → Library → Move to a new computer: the library's own memory as
 * one file, and taking such a file in (moving.rs).
 *
 * Needs a file picker; on a TV box with none the section is not shown.
 */
import { useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import FocusButton from './FocusButton';
import FocusGroup from './FocusGroup';
import { userError } from './errors';
import { useCapabilities } from '../capabilities';
import { applyMovedMatches, exportMove, importMove, moveWords } from '../metadata/moving';

const FILES = [{ name: 'Kinema library', extensions: ['json'] }];

export default function MoveSection() {
  const can = useCapabilities();
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (!can?.folder_picker) return null;

  const work = (task: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    setNote(null);
    task()
      .then((words) => words && setNote(words))
      .catch((e: unknown) => setError(userError(e)))
      .finally(() => setBusy(false));
  };

  const exportIt = () =>
    work(async () => {
      const day = new Date().toISOString().slice(0, 10);
      const path = await save({ defaultPath: `kinema-library-${day}.json`, filters: FILES });
      if (typeof path !== 'string') return null;
      const rows = await exportMove(path);
      return `Saved, with ${rows} watched or begun ${rows === 1 ? 'film or episode' : 'films and episodes'}. Take it to the new computer and choose Take a library in there.`;
    });

  const importIt = () =>
    work(async () => {
      const path = await open({ multiple: false, directory: false, filters: FILES });
      if (typeof path !== 'string') return null;
      const report = await importMove(path);
      // Matches made by hand whose files are already here, now; the rest
      // after the scans that find them.
      await applyMovedMatches().catch(() => 0);
      return moveWords(report);
    });

  return (
    <section className="settings-section">
      <h2>Move to a new computer</h2>
      <p className="settings-intro">
        One file with what Kinema cannot find again by scanning: what you watched and where you
        stopped, the matches you corrected by hand, your playlists, My list and your settings. No
        sign-in, key or password goes in it, nor this computer&rsquo;s screens and sound devices.
      </p>
      <p className="settings-hint">
        On the new computer, add your folders first, then take the file in. Nothing is un-watched,
        and a newer resume point there is kept. Sign in to SIMKL or Trakt again; what was sent from
        here is not sent twice.
      </p>
      <FocusGroup kind="row" className="settings-row">
        <FocusButton className="btn-secondary" disabled={busy} onSelect={exportIt}>
          Save the library to a file…
        </FocusButton>
        <FocusButton className="btn-secondary" disabled={busy} onSelect={importIt}>
          Take a library in…
        </FocusButton>
      </FocusGroup>
      {error && <p className="settings-warn">{error}</p>}
      {note && <p className="settings-ok">{note}</p>}
    </section>
  );
}
