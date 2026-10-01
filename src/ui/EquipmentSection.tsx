/**
 * Settings → Your equipment: what Kinema can see of the screens and audio
 * outputs this PC is connected to, and what it remembers of ones it has seen
 * before.
 *
 * Read-only on purpose. It describes hardware, and nothing here is a choice —
 * the choices built on it (which formats to pass through, whether to switch
 * the display) come later and will sit beside it. What it is for right now is
 * the one question nobody can answer by looking at a picture: *did Windows
 * actually tell the app the receiver takes TrueHD?*
 *
 * Opening it asks the hardware nothing: every launch already checked, and this
 * shows that. "Check again" is the only thing that re-asks — for when a
 * receiver was switched on or a Windows setting changed since launch.
 */
import { userError } from './errors';
import { useCallback, useEffect, useState } from 'react';
import FocusButton from './FocusButton';
import {
  checkEquipment,
  formatRate,
  getEquipment,
  hdrLabel,
  PROBE_LABEL,
  refreshRate,
  type Equipment,
} from '../player/equipment';

const day = (secs: number) =>
  new Date(secs * 1000).toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

/** `system` is for the wording only: "What Windows reports", "What Linux reports". */
export default function EquipmentSection({ system }: { system: string }) {
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  // Starts true: the saved answer is fetched as soon as the section mounts.
  const [checking, setChecking] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const check = useCallback(async () => {
    setChecking(true);
    setError(null);
    try {
      setEquipment(await checkEquipment());
    } catch (e) {
      setError(userError(e));
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    let live = true;
    getEquipment()
      .then((e) => live && setEquipment(e))
      .catch((e: unknown) => live && setError(userError(e)))
      .finally(() => live && setChecking(false));
    return () => {
      live = false;
    };
  }, []);

  const displays = equipment?.displays.filter((d) => d.connected) ?? [];
  const audio = equipment?.audio.filter((a) => a.connected) ?? [];
  const away = [
    ...(equipment?.displays.filter((d) => !d.connected) ?? []),
    ...(equipment?.audio.filter((a) => !a.connected) ?? []),
  ].sort((a, b) => b.last_seen - a.last_seen);

  return (
    <section className="settings-section">
      <h2>Your equipment</h2>
      <p className="settings-intro">
        What {system} reports about the screens and sound devices connected to this PC. Kinema
        checks every time it starts and bases its playback choices on this. Nothing here is a
        setting: if something looks wrong, the cause is in {system} or the cables, not in Kinema.
      </p>
      <div className="settings-toggle-row">
        <FocusButton keepInView="nearest" className="btn-secondary" onSelect={() => void check()}>
          {checking ? 'Checking…' : 'Check again'}
        </FocusButton>
        <span className="muted">
          {equipment
            ? `Last checked ${new Date(equipment.checked_at * 1000).toLocaleTimeString()}. `
            : ''}
          Only needed if a TV or receiver was switched on, or a {system} sound or display setting
          was changed, after Kinema started.
        </span>
      </div>
      {error && <p className="equipment-problem">Could not check: {error}</p>}

      {equipment && (
        <>
          <h3>Screens</h3>
          {displays.length === 0 && <p className="muted">None found.</p>}
          {displays.map((d) => (
            <div className="equipment-item" key={d.id || d.gdi_name}>
              <div className="equipment-head">
                <strong>{d.name}</strong>
                {d.new && <span className="equipment-new">new</span>}
                <span className="muted">
                  {d.connection} ·{' '}
                  {/* A mode of 0×0 is one the desktop did not report (Linux off GNOME). */}
                  {d.width > 0 ? `${d.width}×${d.height} at ${formatRate(refreshRate(d))} Hz · ` : ''}
                  {hdrLabel(d, system)}
                </span>
              </div>
              <ul className="equipment-notes">
                {d.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          ))}

          <h3>Sound</h3>
          {audio.length === 0 && <p className="muted">None found.</p>}
          {audio.map((a) => (
            <div className="equipment-item" key={a.id}>
              <div className="equipment-head">
                <strong>{a.name}</strong>
                {a.new && <span className="equipment-new">new</span>}
                <span className="muted">
                  {a.connection}
                  {a.is_default ? ` · ${system} default` : ''}
                  {/* The Windows mixer and spatial sound: Windows only (an empty layout elsewhere). */}
                  {a.mix_layout ? ` · Windows mixes to ${a.mix_layout}` : ''}
                  {a.spatial_objects ? ' · Windows spatial sound on' : ''}
                  {a.max_pcm_channels
                    ? ` · takes up to ${a.max_pcm_channels} channels directly`
                    : ''}
                </span>
              </div>
              <ul className="equipment-formats">
                {a.bitstream.map((b) => (
                  <li key={b.codec} className={`equipment-format equipment-format-${b.result}`}>
                    {b.label}: {PROBE_LABEL[b.result]}
                    {b.remembered ? ' (remembered)' : ''}
                  </li>
                ))}
              </ul>
              <ul className="equipment-notes">
                {a.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          ))}

          {away.length > 0 && (
            <>
              <h3>Seen before, not connected now</h3>
              <ul className="equipment-notes">
                {away.map((d) => (
                  <li key={d.id}>
                    {d.name} <span className="muted">· last seen {day(d.last_seen)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          {equipment.problems.length > 0 && (
            <p className="equipment-problem">Could not read: {equipment.problems.join('; ')}.</p>
          )}
        </>
      )}
    </section>
  );
}
