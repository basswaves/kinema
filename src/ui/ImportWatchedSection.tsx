/**
 * Settings → Keep track of what I watch → Bring in what you watched elsewhere:
 * Kodi's database, a Jellyfin, Emby or Plex server, or a Trakt export file.
 *
 * Read once, when pressed. A server's key is used for that reading and kept
 * nowhere. Everything is matched by IMDb or TMDB number; what is not is
 * listed under the result, never guessed (import_watched.rs).
 */
import { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import ChoiceRow from './ChoiceRow';
import FocusButton from './FocusButton';
import FocusInput from './FocusInput';
import { userError } from './errors';
import { useCapabilities } from '../capabilities';
import {
  importWatchedFile,
  importWatchedServer,
  kodiDatabase,
  reportWords,
  type ImportReport,
  type ServerKind,
} from '../metadata/importWatched';

const SERVERS: { value: ServerKind; label: string }[] = [
  { value: 'jellyfin', label: 'Jellyfin' },
  { value: 'emby', label: 'Emby' },
  { value: 'plex', label: 'Plex' },
];

const SHOWN = 12;

const KEY_HINT: Record<ServerKind, string> = {
  jellyfin: 'An API key: Jellyfin’s Dashboard, API Keys, +.',
  emby: 'An API key: Emby’s Settings, Advanced, API Keys, New API Key.',
  plex: 'Your Plex token: open any item’s Get Info, View XML, and copy what follows X-Plex-Token= in the address.',
};

export default function ImportWatchedSection() {
  const can = useCapabilities();
  const [kodi, setKodi] = useState<string | null>(null);
  const [server, setServer] = useState<ServerKind>('jellyfin');
  const [url, setUrl] = useState('');
  const [key, setKey] = useState('');
  const [user, setUser] = useState('');
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ImportReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    kodiDatabase()
      .then((path) => live && setKodi(path))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, []);

  const run = (reading: Promise<ImportReport>) => {
    setBusy(true);
    setError(null);
    setReport(null);
    reading
      .then(setReport)
      .catch((e: unknown) => setError(userError(e)))
      .finally(() => setBusy(false));
  };

  const chooseFile = () => {
    void open({
      multiple: false,
      directory: false,
      filters: [{ name: 'Kodi database or Trakt export', extensions: ['db', 'json'] }],
    }).then((path) => {
      if (typeof path === 'string') run(importWatchedFile(path));
    });
  };

  // A short list: below the last button, a long one is out of a remote's reach.
  const unmatched = report ? [...report.not_in_library, ...report.unclear] : [];
  const shown = unmatched.slice(0, SHOWN);

  return (
    <section className="settings-section">
      <h2>Bring in what you watched elsewhere</h2>
      <p className="settings-intro">
        What you watched, and where you stopped, in Kodi, Jellyfin, Emby or Plex, or in a Trakt
        export. Read once, when you press it. Films and shows are matched by their IMDb or TMDB
        number only; anything else is listed and left alone. Something already watched here stays
        watched.
      </p>
      <p className="settings-hint">
        What becomes watched goes to SIMKL or Trakt once, if you are connected, as your history did
        when you connected: Trakt is asked what it has first, so nothing is sent twice.
      </p>

      {can?.folder_picker && (
        <div className="settings-row">
          {kodi && (
            <FocusButton
              keepInView="nearest"
              className="btn-secondary"
              disabled={busy}
              onSelect={() => run(importWatchedFile(kodi))}
            >
              Read Kodi on this computer
            </FocusButton>
          )}
          <FocusButton
            keepInView="nearest"
            className="btn-secondary"
            disabled={busy}
            onSelect={chooseFile}
          >
            Choose Kodi’s database or a Trakt export…
          </FocusButton>
        </div>
      )}

      <ChoiceRow
        label="From a server"
        choices={SERVERS}
        value={server}
        onChange={setServer}
        note="Your own server, on your network or wherever you run it. Kinema reads your watched films and episodes from it, with the key below, once."
        hint={KEY_HINT[server]}
      />
      <label className="settings-field">
        <span>The server’s address</span>
        <FocusInput
          className="settings-input"
          value={url}
          onChange={setUrl}
          placeholder={server === 'plex' ? 'http://192.168.1.10:32400' : 'http://192.168.1.10:8096'}
        />
      </label>
      <label className="settings-field">
        <span>
          {server === 'plex' ? 'Plex token' : 'API key'}{' '}
          <span className="muted">(used for this reading only, never kept)</span>
        </span>
        <FocusInput
          className="settings-input"
          type="password"
          value={key}
          onChange={setKey}
          placeholder={server === 'plex' ? 'Plex token' : 'API key'}
        />
      </label>
      {server !== 'plex' && (
        <label className="settings-field">
          <span>
            Whose history <span className="muted">(a user name; empty when there is one)</span>
          </span>
          <FocusInput
            className="settings-input"
            value={user}
            onChange={setUser}
            placeholder="User name"
          />
        </label>
      )}
      <div className="settings-row">
        <FocusButton
          keepInView="nearest"
          className="btn-primary"
          disabled={busy || !url.trim() || !key.trim()}
          onSelect={() => run(importWatchedServer(server, url, key, user))}
        >
          {busy ? 'Reading…' : 'Bring it in'}
        </FocusButton>
      </div>

      {error && <p className="settings-warn">{error}</p>}
      {report && <p className="settings-ok import-report">{reportWords(report)}</p>}
      {unmatched.length > 0 && (
        <ul className="import-unmatched">
          {shown.map((label) => (
            <li key={label}>{label}</li>
          ))}
          {unmatched.length > SHOWN && <li>and {unmatched.length - SHOWN} more</li>}
        </ul>
      )}
    </section>
  );
}
