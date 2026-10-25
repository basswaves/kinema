/**
 * Settings → Library: films and episodes here more than once (versions.rs).
 * Each is already one title with a Version choice beside Play; this is the
 * list, for anyone tidying a library. Kinema never deletes or moves a file.
 *
 * Always drawn, so Settings search lands on it; with nothing here twice it
 * says so. The versions' words need each file's facts, so they are read when
 * the list is opened, not before.
 */
import { useEffect, useState } from 'react';
import FocusButton from './FocusButton';
import {
  duplicateTitles,
  readVersions,
  sizeWords,
  titleVersions,
  type Duplicate,
  type Version,
} from '../library/versions';

/** More than this many are counted, and the first ones listed. */
const LISTED = 50;

function what(d: Duplicate): string {
  const name = d.year ? `${d.title} (${d.year})` : d.title;
  if (d.episode === null) return name;
  const s = String(d.season ?? 0).padStart(2, '0');
  const e = String(d.episode).padStart(2, '0');
  return `${name} · S${s}E${e}`;
}

export default function DuplicatesSection() {
  const [found, setFound] = useState<Duplicate[]>([]);
  const [open, setOpen] = useState(false);
  const [named, setNamed] = useState<Map<string, Version[]>>(new Map());

  useEffect(() => {
    let live = true;
    duplicateTitles()
      .then((list) => live && setFound(list))
      .catch((e) => console.warn('duplicates lookup failed', e));
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void (async () => {
      const words = new Map<string, Version[]>();
      for (const d of found.slice(0, LISTED)) {
        const files = (await titleVersions(d.title_id).catch(() => [])).filter((f) =>
          d.file_ids.includes(f.file_id)
        );
        words.set(d.file_ids.join(','), await readVersions(files));
        if (!live) return;
      }
      setNamed(words);
    })();
    return () => {
      live = false;
    };
  }, [open, found]);

  const n = found.length;
  if (n === 0) {
    return (
      <section className="settings-section">
        <h2>Here more than once</h2>
        <p className="settings-intro">
          No film or episode is in more than one file. When one is, it stays one title, with a
          Version choice beside Play, and is listed here.
        </p>
      </section>
    );
  }
  return (
    <section className="settings-section">
      <h2>Here more than once</h2>
      <p className="settings-intro">
        {n === 1 ? 'One film or episode is' : `${n} films and episodes are`} in more than one
        file. Each is one title, with a Version choice beside Play that remembers what you pick.
        Kinema never deletes a file: to tidy up, remove the copies you do not want from the folder.
      </p>
      <FocusButton keepInView="nearest" className="btn-secondary" onSelect={() => setOpen((o) => !o)}>
        {open ? 'Hide the list' : 'Show the list'}
      </FocusButton>
      {open && (
        <ul className="duplicates">
          {found.slice(0, LISTED).map((d) => {
            const versions = named.get(d.file_ids.join(','));
            return (
              <li key={d.file_ids.join(',')}>
                <div>
                  {what(d)}
                  <span className="muted">
                    {' '}
                    · {d.file_ids.length} versions · {sizeWords(d.size_bytes)}
                  </span>
                </div>
                {versions && (
                  <ul className="muted">
                    {versions.map((v) => (
                      <li key={v.file_id} title={v.path}>
                        {v.words}
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
          {n > LISTED && <li className="muted">and {n - LISTED} more</li>}
        </ul>
      )}
    </section>
  );
}
