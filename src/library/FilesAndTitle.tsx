/**
 * "Files and title" on a title's own page (GitHub #14; was "Wrong title?",
 * T19): the files the title holds, a row per folder and season, and what a
 * person can do with one row — move it to another season, make it a title of
 * its own, unlink it alone, or put back what the names say. Under them, the
 * search from Needs attention for a title that is wrong altogether.
 *
 * The same rules as the queue: nothing is linked but the entry a person picks,
 * nothing is matched again, and no file is renamed, moved or written beside
 * (placing.ts). "Unlink, decide later" holds the files in Needs attention, so
 * the next scan's matcher cannot simply put the wrong title back.
 *
 * A menu like the Version list: it opens on the first row, the ring never
 * leaves it, Back closes it (or steps back out of a row's choice) and the
 * ring goes back to the button that opened it (focusStore.ts).
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useFocusGroup } from '../ui/focusGroups';
import FocusButton from '../ui/FocusButton';
import FocusInput from '../ui/FocusInput';
import FocusGroup, { FocusProvider } from '../ui/FocusGroup';
import { navFocus } from '../ui/focusStore';
import { count } from '../ui/format';
import { describeFailure } from '../metadata/reach';
import { addWithoutMatch, unlinkFiles } from '../metadata/api';
import { applyMatch, loadProviderKeys } from '../metadata/match';
import type { Candidate } from '../metadata/score';
import type { Provider } from '../metadata/match';
import { MatchSearch } from './FixMatch';
import { readLocalName } from './localTitle';
import { PlaceChooser } from './PlaceChooser';
import {
  commonName,
  folderRows,
  placeFiles,
  seasonLabel,
  titleFiles,
  unplaceFiles,
  type FolderRow,
  type Placement,
  type TitleFile,
} from './placing';
import './fixmatch.css';

const SEARCH_KEY = 'files-title-search';
const rowKey = (key: string) => `files-row-${key}`;
const MOVE_KEY = 'files-row-move';
const OWN_NAME_KEY = 'files-own-name';

type View = { kind: 'rows' } | { kind: 'place'; row: FolderRow } | { kind: 'own'; row: FolderRow };

interface Props {
  titleId: number;
  /** As shown on the page. */
  name: string;
  year: number | null;
  isSeries: boolean;
  /** Kept under its own name (local_title.rs): no search here, Find a match is on its page. */
  isLocal: boolean;
  onClose: () => void;
  /** The files left for another title (its id), or all went to Needs attention (null). */
  onDone: (titleId: number | null) => void;
  /** Some files changed, the title stays: the page reads itself again. */
  onChanged: () => void;
}

export default function FilesAndTitle({
  titleId,
  name,
  year,
  isSeries: wasSeries,
  isLocal,
  onClose,
  onDone,
  onChanged,
}: Props) {
  const [files, setFiles] = useState<TitleFile[] | null>(null);
  const [view, setView] = useState<View>({ kind: 'rows' });
  const [open, setOpen] = useState<string | null>(null);
  const [isSeries, setIsSeries] = useState(wasSeries);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const pickingRef = useRef(false);
  /** Where the ring goes when the rows come back. */
  const backTo = useRef<string | null>(null);

  const rows = useMemo(() => folderRows(files ?? []), [files]);
  const { ref, focusKey } = useFocusGroup('menu', {
    current: rows[0] ? rowKey(rows[0].key) : SEARCH_KEY,
  });

  const reload = useCallback(
    () =>
      titleFiles(titleId)
        .then(setFiles)
        .catch(async (e: unknown) => setError(await describeFailure(e))),
    [titleId]
  );
  useEffect(() => {
    void reload();
  }, [reload]);

  const back = useCallback(() => {
    if (view.kind !== 'rows') {
      backTo.current = rowKey(view.row.key);
      setView({ kind: 'rows' });
    } else if (open) {
      backTo.current = rowKey(open);
      setOpen(null);
    } else onClose();
  }, [view, open, onClose]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (pickingRef.current) return;
      // Backspace in a text box is a letter taken back, not Back.
      const typing = e.target instanceof HTMLInputElement;
      if (e.key === 'Escape' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !typing)) {
        e.preventDefault();
        e.stopPropagation();
        back();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [back]);

  // A view takes the last one's place: the ring goes with it.
  useLayoutEffect(() => {
    if (view.kind === 'own') navFocus(OWN_NAME_KEY);
    else if (view.kind === 'rows' && backTo.current) {
      navFocus(backTo.current);
      backTo.current = null;
    }
  }, [view, open]);
  useLayoutEffect(() => {
    if (open) navFocus(MOVE_KEY);
  }, [open]);
  // The rows arrive a moment after the dialog: it opens on the first.
  const landed = useRef(false);
  useLayoutEffect(() => {
    if (landed.current || rows.length === 0) return;
    landed.current = true;
    navFocus(rowKey(rows[0].key));
  }, [rows]);

  /** One change; then the rows again, or the page left if none are left. */
  const run = useCallback(
    async (work: () => Promise<number | null | 'stay'>, message: string, row?: FolderRow) => {
      setBusy(true);
      setError(null);
      try {
        const went = await work();
        if (went !== 'stay') {
          onDone(went);
          return;
        }
        const left = await titleFiles(titleId);
        if (left.length === 0) {
          onDone(null);
          return;
        }
        setFiles(left);
        setNote(message);
        setOpen(null);
        const still = row && folderRows(left).find((r) => r.parentDir === row.parentDir);
        backTo.current = rowKey((still ?? folderRows(left)[0]).key);
        setView({ kind: 'rows' });
        onChanged();
      } catch (e) {
        setError(await describeFailure(e));
      } finally {
        setBusy(false);
      }
    },
    [titleId, onDone, onChanged]
  );

  const link = useCallback(
    (provider: Provider, candidate: Candidate, linkSeries: boolean) =>
      void run(async () => {
        const ids = (files ?? []).map((f) => f.file_id);
        return applyMatch(
          ids.map((id) => ({ id })),
          provider,
          candidate.providerId,
          linkSeries,
          await loadProviderKeys(),
          1,
          `manual: “${candidate.title}”${candidate.year ? ` (${candidate.year})` : ''} via ${provider}, was “${name}”`
        );
      }, ''),
    [run, name, files]
  );

  const idsOf = (row: FolderRow) => row.files.map((f) => f.file_id);

  const unlinkRow = (row: FolderRow) =>
    void run(
      async () => {
        await unlinkFiles(idsOf(row), `unlinked by hand from “${name}”`);
        return 'stay';
      },
      `${count(row.files.length, 'file')} from ${row.folder} wait under Settings → Library → Needs attention; the rest of “${name}” is as it was.`,
      row
    );

  const namesBack = (row: FolderRow) =>
    void run(
      async () => {
        await unplaceFiles(idsOf(row));
        return 'stay';
      },
      `${count(row.files.length, 'file')} from ${row.folder} are back where their names say.`,
      row
    );

  const place = (row: FolderRow, plan: Placement[] | null, where: string) =>
    void run(
      async () => {
        if (plan === null) await unplaceFiles(idsOf(row));
        else await placeFiles(plan, `manual: placed by hand on “${name}”`);
        return 'stay';
      },
      `Moved ${count(row.files.length, 'file')} to ${where}. File names are unchanged. What was already sent to SIMKL or Trakt, or ticked as watched, under the old numbers stays as it was.`,
      row
    );

  const unlinkAll = () =>
    void run(async () => {
      await unlinkFiles((files ?? []).map((f) => f.file_id), `unlinked by hand from “${name}”`);
      return null;
    }, '');

  const total = files?.length ?? 0;

  return (
    <FocusProvider value={focusKey}>
      <div className="leave-backdrop" onClick={onClose}>
        <div
          className="leave wrong-title"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Files and title"
        >
          {error && <div className="fixmatch-error">{error}</div>}
          {view.kind === 'place' ? (
            <PlaceChooser
              titleId={titleId}
              show={name}
              files={view.row.files.map((f) => ({
                id: f.file_id,
                file_name: f.file_name,
                season: f.name_season,
                episode: f.name_episode,
                parsed_title: f.parsed_title,
              }))}
              verb="Move"
              initial={view.row.placed && view.row.season !== null ? view.row.season : 'names'}
              busy={busy}
              onPlace={(plan, where) => place(view.row, plan, where)}
              onCancel={back}
              pickingRef={pickingRef}
            />
          ) : view.kind === 'own' ? (
            <OwnTitle
              row={view.row}
              isSeries={wasSeries}
              busy={busy}
              onCancel={back}
              onKeep={(keepName, keepYear) =>
                void run(
                  () => addWithoutMatch(idsOf(view.row), wasSeries, keepName, keepYear),
                  ''
                )
              }
            />
          ) : (
            <>
              <h2>Files and title: {name}</h2>
              <p className="muted">
                {files === null
                  ? 'Reading the files…'
                  : `${count(total, 'file')} ${total === 1 ? 'is' : 'are'} linked to “${name}”${year ? ` (${year})` : ''}. Press a folder to move it, make it its own title or unlink it alone. Nothing on disk is renamed or moved.`}
              </p>
              {note && <div className="detail-note">{note}</div>}
              <FocusGroup kind="panel" className="files-rows">
                {rows.map((row) => (
                  <RowItem
                    key={row.key}
                    row={row}
                    isSeries={wasSeries}
                    open={open === row.key}
                    busy={busy}
                    onToggle={() => setOpen(open === row.key ? null : row.key)}
                    onMove={() => setView({ kind: 'place', row })}
                    onOwn={() => setView({ kind: 'own', row })}
                    onUnlink={() => unlinkRow(row)}
                    onNamesBack={() => namesBack(row)}
                  />
                ))}
              </FocusGroup>
              {!isLocal && (
                <>
                  <p className="muted files-search-head">
                    Wrong {wasSeries ? 'show' : 'film'} altogether? Search for what it really is and
                    pick it; nothing is linked until you do.
                  </p>
                  <section className="fixmatch">
                    <MatchSearch
                      initialQuery={name}
                      isSeries={isSeries}
                      onToggleSeries={() => setIsSeries((v) => !v)}
                      busy={busy || !total}
                      linkLabel="This one"
                      onLink={link}
                      inputFocusKey={SEARCH_KEY}
                    />
                  </section>
                </>
              )}
              <FocusGroup kind="row" className="settings-row wrong-title-foot">
                {!isLocal && (
                  <FocusButton className="btn-secondary" disabled={busy || !total} onSelect={unlinkAll}>
                    Unlink all, decide later
                  </FocusButton>
                )}
                <FocusButton className="btn-secondary" onSelect={onClose}>
                  Close
                </FocusButton>
              </FocusGroup>
              <p className="muted wrong-title-note">
                Unlinked files wait under Settings → Library → Needs attention, and the next scan
                does not put them back.
              </p>
            </>
          )}
        </div>
      </div>
    </FocusProvider>
  );
}

/**
 * A folder and season, and when open, what can be done with it. A component
 * of its own inside its own group, so its controls register inside the row
 * (GOTCHAS: a control's place in the tree is where its hook runs).
 */
function RowItem({
  row,
  isSeries,
  open,
  busy,
  onToggle,
  onMove,
  onOwn,
  onUnlink,
  onNamesBack,
}: {
  row: FolderRow;
  isSeries: boolean;
  open: boolean;
  busy: boolean;
  onToggle: () => void;
  onMove: () => void;
  onOwn: () => void;
  onUnlink: () => void;
  onNamesBack: () => void;
}) {
  const where = row.rootPath && row.parentDir.startsWith(row.rootPath) ? row.rootPath : row.parentDir;
  return (
    <FocusGroup kind="panel" className={`files-row ${open ? 'open' : ''}`}>
      <FocusButton focusKey={rowKey(row.key)} className="files-row-head" onSelect={onToggle}>
        <span className="files-row-name">{row.folder}</span>{' '}
        <span className="muted">
          {count(row.files.length, 'file')}
          {isSeries ? ` · ${seasonLabel(row.season)}` : ''}
          {row.placed ? ' (placed by hand)' : ''} · {where}
          {row.missing ? ' (not found now)' : ''}
        </span>
      </FocusButton>
      {open && (
        <FocusGroup kind="row" className="settings-row files-row-actions" current={MOVE_KEY}>
          {isSeries ? (
            <FocusButton focusKey={MOVE_KEY} disabled={busy} onSelect={onMove}>
              Move to another season…
            </FocusButton>
          ) : null}
          <FocusButton focusKey={isSeries ? undefined : MOVE_KEY} disabled={busy} onSelect={onOwn}>
            Make it its own title…
          </FocusButton>
          <FocusButton disabled={busy} onSelect={onUnlink}>
            Unlink, decide later
          </FocusButton>
          {row.placed && (
            <FocusButton disabled={busy} onSelect={onNamesBack}>
              Back to what the names say
            </FocusButton>
          )}
        </FocusGroup>
      )}
    </FocusGroup>
  );
}

/** "Make it its own title…": a name and a year, then a card of its own. */
function OwnTitle({
  row,
  isSeries,
  busy,
  onCancel,
  onKeep,
}: {
  row: FolderRow;
  isSeries: boolean;
  busy: boolean;
  onCancel: () => void;
  onKeep: (name: string, year: number | null) => void;
}) {
  const [name, setName] = useState(() => commonName(row.files));
  const [year, setYear] = useState('');
  const [error, setError] = useState<string | null>(null);
  const keep = () => {
    const read = readLocalName(name, year);
    if (typeof read === 'string') {
      setError(read);
      return;
    }
    setError(null);
    onKeep(read.name, read.year);
  };
  return (
    <div className="fixmatch-local">
      <h2>{row.folder}: its own title</h2>
      <p className="muted">
        {count(row.files.length, 'file')} get a card of {row.files.length === 1 ? 'its' : 'their'} own
        under {isSeries ? 'Shows' : 'Films'}, with no description or poster unless one lies beside
        them. Find a match stays on its page.
      </p>
      <FocusGroup kind="row" className="fixmatch-search">
        <FocusInput
          focusKey={OWN_NAME_KEY}
          className="fixmatch-input"
          value={name}
          onChange={setName}
          onEnter={keep}
          placeholder="Name"
        />
        <FocusInput
          className="fixmatch-input fixmatch-year"
          value={year}
          onChange={setYear}
          onEnter={keep}
          placeholder="Year"
        />
      </FocusGroup>
      {error && <div className="fixmatch-error">{error}</div>}
      <FocusGroup kind="row" className="settings-row wrong-title-foot">
        <FocusButton className="primary" disabled={busy} onSelect={keep}>
          Make it its own title
        </FocusButton>
        <FocusButton className="btn-secondary" onSelect={onCancel}>
          Back
        </FocusButton>
      </FocusGroup>
    </div>
  );
}
