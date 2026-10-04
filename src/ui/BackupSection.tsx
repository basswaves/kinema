/**
 * Settings → Advanced → Safety copies: the copies of the library Kinema keeps,
 * and the way back to one.
 *
 * The copies are made without being asked (once a week, and before an upgrade),
 * so this is where their existence is made visible at all. Restoring closes
 * Kinema; the copy is put in place as it starts again (backup.rs).
 */
import { useEffect, useState } from 'react';
import ConfirmButton from './ConfirmButton';
import FocusButton from './FocusButton';
import { formatBytes } from './format';
import { userError } from './errors';
import { useCapabilities } from '../capabilities';
import { listBackups, openBackupFolder, restoreBackup, type BackupCopy } from '../metadata/api';

const KIND: Record<BackupCopy['kind'], string> = {
  weekly: 'Weekly copy',
  before_upgrade: 'Before an upgrade',
  before_restore: 'Before a restore',
};

const day = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

export default function BackupSection() {
  const [copies, setCopies] = useState<BackupCopy[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const can = useCapabilities();

  useEffect(() => {
    let live = true;
    listBackups()
      .then((list) => live && setCopies(list))
      .catch((e: unknown) => live && setError(userError(e)));
    return () => {
      live = false;
    };
  }, []);

  return (
    <section className="settings-section">
      <h2>Safety copies</h2>
      <p className="settings-intro">
        Once a week, and before every upgrade, Kinema keeps a copy of your library: what you have
        watched, where you stopped and the matches you corrected by hand. Restoring one closes
        Kinema; start it again and the library is as the copy was. What it replaces is kept here
        too.
      </p>
      {error && <p className="settings-warn">{error}</p>}
      {copies !== null && copies.length === 0 && (
        <p className="settings-hint">No copy has been made yet. The first comes a week after the
          library has something in it.</p>
      )}
      {copies?.map((copy) => (
        <div className="settings-row backup-row" key={copy.name}>
          <span>
            {KIND[copy.kind] ?? copy.kind} · {day(copy.made_at)} · {formatBytes(copy.bytes)}
          </span>
          <ConfirmButton
            keepInView="nearest"
            className="btn-secondary"
            confirmLabel="Close Kinema and restore this copy"
            onConfirm={() => void restoreBackup(copy.name).catch((e) => setError(userError(e)))}
          >
            Restore
          </ConfirmButton>
        </div>
      ))}
      {/* Nothing to show a folder in on a TV box (capability `opens_folders`). */}
      {can?.opens_folders && (
        <div className="settings-row">
          <FocusButton
            keepInView="nearest"
            className="btn-secondary"
            onSelect={() => void openBackupFolder().catch((e) => setError(userError(e)))}
          >
            Open the folder of copies
          </FocusButton>
        </div>
      )}
    </section>
  );
}
