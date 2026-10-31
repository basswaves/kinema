/**
 * The setup pages, shown while the first scan runs (agreed 2026-10-02).
 *
 * The welcome page asks only what a library needs to exist: where it will be
 * watched, where the films are, and in a build from source a TMDB key. The
 * rest of what is worth knowing on day one — what the equipment can do, and
 * later intros, watch history, subtitles and the extras — waits for the scan, which takes
 * minutes the first time anyway. Each page is one subject, a few answers
 * long, and can be skipped; nothing on one is chosen for the person.
 *
 * The filter for what earns a page: would someone otherwise never learn it
 * exists, or does answering now change the first day. Picture quality,
 * storage, languages and the developer tools do not, and stay in Settings.
 *
 * Home keeps these pages up until they are finished or left, however soon the
 * scan fills the library behind them, and a launch that finds them unfinished
 * — the app closed half-way — opens them again (`SETUP_PAGES_KEY`). Settings →
 * Library → Run setup again brings them back at any time.
 */
import { scanWords } from '../library/scanWords';
import { useCallback, useEffect, useLayoutEffect, useMemo, useState, type ReactNode } from 'react';
import { useCapabilities } from '../capabilities';
import { useScanStatus } from '../library/pipeline';
import FocusButton from './FocusButton';
import FocusGroup, { FocusProvider } from './FocusGroup';
import PictureSoundSetup from './PictureSoundSetup';
import IntrosSetup from './IntrosSetup';
import AccountSection from './AccountSection';
import { OpenSubtitlesSection } from './SubtitlesSettings';
import ExtrasSetup from './ExtrasSetup';
import { ALL_ARROWS, useNavGroup } from './focusGroups';
import { navRearrive, useLanding } from './focusStore';

/** 'open' while the pages are up, 'done' once finished or left. */
export const SETUP_PAGES_KEY = 'setup_pages';

const SETUP_FOCUS_KEY = 'setup-pages';
const PAGE_FOCUS_KEY = 'setup-page';
const FORWARD_FOCUS_KEY = 'setup-forward';
/** What a remote can press on a page (`FocusButton`, `FocusInput`). */
const CONTROL = ':is(button:not(:disabled), input)';

interface Page {
  id: string;
  title: string;
  body: ReactNode;
}

interface Props {
  /** Finished or left: back to Home. */
  onClose: () => void;
}

export default function SetupPages({ onClose }: Props) {
  // A page of its own (NAV-MAP, agreed 2026-10-11): Up from Next or Finish
  // later is nothing, not the top bar.
  const { ref, focusKey } = useNavGroup(
    { kind: 'column', current: PAGE_FOCUS_KEY, hold: ALL_ARROWS },
    { focusKey: SETUP_FOCUS_KEY }
  );
  const can = useCapabilities();
  const scan = useScanStatus();

  // Only the pages this system has something to ask on.
  const pages = useMemo<Page[]>(() => {
    if (!can) return [];
    const all: (Page | false)[] = [
      // What PictureSoundSetup asks about; a system with neither has no page.
      (can.audio_direct || can.display_switching) && {
        id: 'picture',
        title: 'Picture and sound',
        body: <PictureSoundSetup />,
      },
      {
        id: 'intros',
        title: 'Skipping intros',
        body: <IntrosSetup />,
      },
      // By what someone wants, as Settings is (settingsSections.ts): the
      // service's own card one level down, the same job as there.
      {
        id: 'tracking',
        title: 'Keep track of what you watch',
        body: (
          <>
            <p className="muted">
              Optional: Kinema can add what you finish to a watch history online, on SIMKL or
              Trakt. Each works without the other.
            </p>
            <AccountSection service="simkl" />
            <AccountSection service="trakt" />
          </>
        ),
      },
      {
        id: 'subtitles',
        title: 'Subtitles online',
        body: (
          <>
            <p className="muted">
              For a film that does not come with the subtitles you want, Kinema can look online.
              It works without an account (5 downloads a day); a free account allows 20 a day.
            </p>
            <OpenSubtitlesSection />
          </>
        ),
      },
      {
        id: 'extras',
        title: 'Details and ratings',
        body: <ExtrasSetup />,
      },
    ];
    return all.filter((p): p is Page => Boolean(p));
  }, [can]);

  const [index, setIndex] = useState(0);
  const page = pages[index] as Page | undefined;
  const last = index === pages.length - 1;

  // Nothing to ask on this system: there are no pages to show.
  useEffect(() => {
    if (can && pages.length === 0) onClose();
  }, [can, pages.length, onClose]);

  // A new page starts at its first question, never on the button pressed to
  // get there; a page with none starts on Next, and takes the ring to its
  // first question when one comes later (a busy computer answered the ffmpeg
  // check late) — unless a key was pressed meanwhile: then the ring is the
  // person's. The page goes to its top as it opens.
  const [hasQuestions, setHasQuestions] = useState(false);
  useLanding(page ? (hasQuestions ? PAGE_FOCUS_KEY : FORWARD_FOCUS_KEY) : null);
  const pageId = page?.id;
  useLayoutEffect(() => {
    if (!pageId) return;
    // A new page starts at its top, at once.
    for (let el = document.querySelector<HTMLElement>('.setup-pages'); el; el = el.parentElement) {
      const { overflowY } = getComputedStyle(el);
      if (overflowY === 'auto' || overflowY === 'scroll') el.scrollTop = 0;
    }
  }, [pageId]);

  const go = useCallback(
    (next: number) => {
      // The pressed key opened this page: the landing is the page's again.
      navRearrive();
      setHasQuestions(false);
      setIndex(next);
    },
    []
  );

  const forward = useCallback(() => {
    if (last) onClose();
    else go(index + 1);
  }, [go, index, last, onClose]);

  // Back on a later page returns to the page before, ahead of the shell's own
  // Back (which in TV mode offers to leave the app).
  useEffect(() => {
    if (index === 0) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' && e.key !== 'Backspace' && e.key !== 'BrowserBack') return;
      if ((e.target as HTMLElement).tagName === 'INPUT' && e.key === 'Backspace') return;
      e.preventDefault();
      e.stopPropagation();
      go(index - 1);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [go, index]);

  // Whether the scan was seen running here, so its end can be said.
  const [sawScan, setSawScan] = useState(false);
  if (scan && !sawScan) setSawScan(true);

  // The element even before the system's answer gives the pages: the focus
  // container measures it once, at mount ("Component added without a node
  // reference"). The same shape as below, so React keeps the one element.
  if (!page) {
    return (
      <FocusProvider value={focusKey}>
        <div className="first-run setup-pages" ref={ref} />
      </FocusProvider>
    );
  }

  return (
    <FocusProvider value={focusKey}>
      <div className="first-run setup-pages" ref={ref}>
        <div className="setup-progress muted">
          <span>
            Setting up · {index + 1} of {pages.length}
          </span>
          {scan ? (
            <span>
              Reading your library meanwhile: {scanWords(scan)}
            </span>
          ) : (
            sawScan && <span>Your library is ready.</span>
          )}
        </div>
        <h1>{page.title}</h1>

        {/* At the top, so not caring costs one press rather than every row.
            Always Next, never Skip (owner, 2026-10-05): every answer is saved
            as it is given, so the way on only goes on, and accepting what is
            shown is what it does — "Skip" read as "don't do this". */}
        <FocusGroup kind="row" className="settings-row setup-nav">
          <FocusButton
            className="btn-primary"
            focusKey={FORWARD_FOCUS_KEY}
           
            onSelect={forward}
          >
            {last ? 'Finish' : 'Next'}
          </FocusButton>
          {!last && (
            <FocusButton className="btn-secondary" onSelect={onClose}>
              Finish later
            </FocusButton>
          )}
        </FocusGroup>

        <PageBody key={page.id} id={page.id} onQuestions={setHasQuestions}>
          {page.body}
        </PageBody>

        {!last && (
          <p className="muted setup-later">
            Finish later goes to your library. Settings → Library → Run setup again brings these
            pages back.
          </p>
        )}
      </div>
    </FocusProvider>
  );
}

/**
 * The page's own questions, as a container of their own, so arriving on a
 * page lands on its first question rather than on the buttons above it.
 *
 * Only while it has a question to land on. A page can have nothing to press:
 * Keep track of what you watch in a build without SIMKL's or Trakt's app,
 * and Subtitles online without an OpenSubtitles key: every build but a release. Focus given to an
 * empty container stays on the container, which draws no ring, so the remote
 * was left with nothing to act from — and every recovery chose this
 * container again. Out of the way, the page's own landing goes to Next.
 */
function PageBody({
  id,
  onQuestions,
  children,
}: {
  id: string;
  onQuestions: (has: boolean) => void;
  children: ReactNode;
}) {
  const [hasControls, setHasControls] = useState(false);
  // A panel: Up from an answer is the answer above it (Next only from the
  // first), never a jump past the others to Next (NAV-MAP, 2026-10-11).
  const { ref, focusKey } = useNavGroup<HTMLElement>(
    { kind: 'column', disabled: !hasControls },
    { focusKey: PAGE_FOCUS_KEY, focusable: hasControls }
  );
  useLayoutEffect(() => onQuestions(hasControls), [hasControls, onQuestions]);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const look = () => setHasControls(root.querySelector(CONTROL) !== null);
    look();
    const watch = new MutationObserver(look);
    watch.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
    return () => watch.disconnect();
  }, [ref]);

  return (
    <FocusProvider value={focusKey}>
      <section className="first-run-step setup-page" data-page={id} ref={ref}>
        {children}
      </section>
    </FocusProvider>
  );
}
