/**
 * "Wrong title?" on a title's own page (T19): the search from Needs attention,
 * right there, so a wrong match is fixed where it is seen instead of through
 * Settings → developer tools → Unlink → Needs attention.
 *
 * The same rules as the queue: nothing is linked but the entry a person picks
 * (a hand-picked title is authoritative, as in FixMatch), and "I don't know
 * either" is the developer tools' unlink — the files wait in Needs attention,
 * held, so the next scan's matcher cannot simply put the wrong title back.
 *
 * A menu like the Version list: it opens on the search box, the ring never
 * leaves it, Back closes it and the ring goes back to the button that opened
 * it (focusStore.ts does all three).
 */
import { useCallback, useEffect, useState } from 'react';
import { useFocusGroup } from '../ui/focusGroups';
import FocusButton from '../ui/FocusButton';
import FocusGroup, { FocusProvider } from '../ui/FocusGroup';
import { count } from '../ui/format';
import { describeFailure } from '../metadata/reach';
import { unlinkFiles } from '../metadata/api';
import { applyMatch, loadProviderKeys } from '../metadata/match';
import type { Candidate } from '../metadata/score';
import type { Provider } from '../metadata/match';
import { titleVersions } from './versions';
import { MatchSearch } from './FixMatch';
import './fixmatch.css';

const WRONG_TITLE_INPUT_KEY = 'wrong-title-search';

interface Props {
  titleId: number;
  /** As shown on the page: what the files are linked to now. */
  name: string;
  year: number | null;
  isSeries: boolean;
  onClose: () => void;
  /** Linked to another title (its id), or unlinked (null). */
  onDone: (titleId: number | null) => void;
}

export default function WrongTitle({ titleId, name, year, isSeries: wasSeries, onClose, onDone }: Props) {
  const { ref, focusKey } = useFocusGroup('menu', { current: WRONG_TITLE_INPUT_KEY });
  const [isSeries, setIsSeries] = useState(wasSeries);
  const [fileIds, setFileIds] = useState<number[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void titleVersions(titleId)
      .then((files) => setFileIds(files.map((f) => f.file_id)))
      .catch((e: unknown) => setError(String(e)));
  }, [titleId]);

  const close = onClose;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Backspace in the search box is a letter taken back, not Back.
      const typing = e.target instanceof HTMLInputElement;
      if (e.key === 'Escape' || e.key === 'BrowserBack' || (e.key === 'Backspace' && !typing)) {
        e.preventDefault();
        e.stopPropagation();
        close();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close]);

  const run = useCallback(
    async (work: (ids: number[]) => Promise<number | null>) => {
      if (!fileIds || fileIds.length === 0) return;
      setBusy(true);
      setError(null);
      try {
        onDone(await work(fileIds));
      } catch (e) {
        setError(await describeFailure(e));
      } finally {
        setBusy(false);
      }
    },
    [fileIds, onDone]
  );

  const link = useCallback(
    (provider: Provider, candidate: Candidate, linkSeries: boolean) =>
      void run(async (ids) =>
        applyMatch(
          ids.map((id) => ({ id })),
          provider,
          candidate.providerId,
          linkSeries,
          // Read at the moment of the link, as Needs attention does.
          await loadProviderKeys(),
          1,
          `manual: “${candidate.title}”${candidate.year ? ` (${candidate.year})` : ''} via ${provider}, was “${name}”`
        )
      ),
    [run, name]
  );

  const unlink = useCallback(
    () =>
      void run(async (ids) => {
        await unlinkFiles(ids, `unlinked by hand from “${name}”`);
        return null;
      }),
    [run, name]
  );

  const files = fileIds?.length ?? 0;
  return (
    <FocusProvider value={focusKey}>
      <div className="leave-backdrop" onClick={close}>
        <div
          className="leave wrong-title"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Wrong title?"
        >
          <h2>Wrong title?</h2>
          <p className="muted">
            {fileIds === null
              ? 'Reading the files…'
              : `${count(files, 'file')} ${files === 1 ? 'is' : 'are'} linked to “${name}”${year ? ` (${year})` : ''}. Search for what ${files === 1 ? 'it' : 'they'} really ${files === 1 ? 'is' : 'are'} and pick it; nothing is linked until you do.`}
          </p>
          {error && <div className="fixmatch-error">{error}</div>}
          <section className="fixmatch">
            <MatchSearch
              initialQuery={name}
              isSeries={isSeries}
              onToggleSeries={() => setIsSeries((v) => !v)}
              busy={busy || !files}
              linkLabel="This one"
              onLink={link}
              inputFocusKey={WRONG_TITLE_INPUT_KEY}
            />
          </section>
          <FocusGroup kind="row" className="settings-row wrong-title-foot">
            <FocusButton
              className="btn-secondary"
              disabled={busy || !files}
              onSelect={unlink}
            >
              Unlink, decide later
            </FocusButton>
            <FocusButton className="btn-secondary" onSelect={close}>
              Cancel
            </FocusButton>
          </FocusGroup>
          <p className="muted wrong-title-note">
            Unlink takes the title off these files; they wait under Settings → Library → Needs
            attention, and the next scan does not put it back.
          </p>
        </div>
      </div>
    </FocusProvider>
  );
}
