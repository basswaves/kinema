/**
 * The setup pages, shown while the first scan runs (agreed 2026-10-02).
 *
 * The welcome page asks only what a library needs to exist: where it will be
 * watched, where the films are, and in a build from source a TMDB key. The
 * rest of what is worth knowing on day one — what the equipment can do, and
 * later intros, accounts and the extras — waits for the scan, which takes
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
import {
  useFocusable,
  FocusContext,
  setFocus,
  updateAllLayouts,
} from '@noriginmedia/norigin-spatial-navigation';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useCapabilities } from '../capabilities';
import { useScanStatus } from '../library/pipeline';
import FocusButton from './FocusButton';
import PictureSoundSetup from './PictureSoundSetup';
import IntrosSetup from './IntrosSetup';
import AccountSection from './AccountSection';
import { OpenSubtitlesSection } from './SubtitlesSettings';
import ExtrasSetup from './ExtrasSetup';
import { scrollPageToTop, useClaimFocus } from './focus';

/** 'open' while the pages are up, 'done' once finished or left. */
export const SETUP_PAGES_KEY = 'setup_pages';

const SETUP_FOCUS_KEY = 'setup-pages';
const PAGE_FOCUS_KEY = 'setup-page';
const FORWARD_FOCUS_KEY = 'setup-forward';
/** The longest a new page's first question is waited for. */
const LANDING_WAIT_MS = 2000;
/** What a remote can press on a page (`FocusButton`, `FocusInput`). */
const CONTROL = ':is(button:not(:disabled), input)';

interface Page {
  id: string;
  title: string;
  body: (onAnswer: () => void) => ReactNode;
  /**
   * The way on says Next from the start: a page made of Settings' own
   * sections, which do not say when something was done on them.
   */
  alwaysNext?: boolean;
}

interface Props {
  /** Finished or left: back to Home. */
  onClose: () => void;
}

export default function SetupPages({ onClose }: Props) {
  const { ref, focusKey } = useFocusable({
    focusKey: SETUP_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: false,
    preferredChildFocusKey: PAGE_FOCUS_KEY,
  });
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
        body: (onAnswer) => <PictureSoundSetup onAnswer={onAnswer} />,
      },
      {
        id: 'intros',
        title: 'Intros and credits',
        body: (onAnswer) => <IntrosSetup onAnswer={onAnswer} />,
      },
      // Settings → Accounts as it is: connecting is the same job here.
      {
        id: 'accounts',
        title: 'Accounts',
        alwaysNext: true,
        body: () => (
          <>
            <p className="muted">
              All optional, and each works without the others: SIMKL or Trakt keep a record of
              what you finish in Kinema, and OpenSubtitles is where Kinema looks for subtitles a
              film does not come with.
            </p>
            <AccountSection service="simkl" />
            <AccountSection service="trakt" />
            <OpenSubtitlesSection />
          </>
        ),
      },
      {
        id: 'extras',
        title: 'Extras',
        body: (onAnswer) => <ExtrasSetup onAnswer={onAnswer} />,
      },
    ];
    return all.filter((p): p is Page => Boolean(p));
  }, [can]);

  const [index, setIndex] = useState(0);
  /** Pages where something has been chosen: their way on says Next, not Skip. */
  const [answered, setAnswered] = useState<Set<string>>(() => new Set());
  const page = pages[index] as Page | undefined;
  const last = index === pages.length - 1;

  // Nothing to ask on this system: there are no pages to show.
  useEffect(() => {
    if (can && pages.length === 0) onClose();
  }, [can, pages.length, onClose]);

  useClaimFocus(SETUP_FOCUS_KEY, Boolean(page));

  /**
   * A new page starts at its first question, never on the button pressed to
   * get there: OK held a moment too long would otherwise skip the next page
   * unread.
   *
   * Some pages ask the system something before their questions exist (is
   * ffmpeg there?), and focus given before then lands on whatever happened to
   * be there first. So it waits, briefly, for the new page to have a control;
   * a page that has none by then (see PageBody) starts on Next.
   *
   * Then the page goes to its top and every control is measured again before
   * focus is given. "First" is the control nearest the top-left corner by
   * the positions the spatial library last measured, and those can date from
   * before the page moved: the first page opens with the welcome page's
   * scroll, and on CI's Linux WebKit the ring landed a row down.
   */
  const landing = useRef(0);
  const landOn = useCallback((id: string) => {
    const started = Date.now();
    const attempt = ++landing.current;
    const land = () => {
      if (attempt !== landing.current) return;
      const root = document.querySelector<HTMLElement>(`.setup-page[data-page="${id}"]`);
      const ready = root?.querySelector(CONTROL);
      if (!ready && Date.now() - started <= LANDING_WAIT_MS) {
        window.setTimeout(land, 50);
        return;
      }
      scrollPageToTop(root ?? null, 'auto');
      void Promise.resolve(updateAllLayouts()).then(() => {
        // Named outright rather than left to the containers: the page body
        // learns it has questions a moment after they appear.
        if (attempt === landing.current) void setFocus(ready ? PAGE_FOCUS_KEY : FORWARD_FOCUS_KEY);
      });
    };
    window.setTimeout(land, 0);
  }, []);

  // The first page, once there is one.
  const firstId = pages[0]?.id;
  useEffect(() => {
    if (firstId) landOn(firstId);
  }, [firstId, landOn]);

  const go = useCallback(
    (next: number) => {
      setIndex(next);
      const id = pages[next]?.id;
      if (id) landOn(id);
    },
    [landOn, pages]
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

  if (!page) return null;

  return (
    <FocusContext.Provider value={focusKey}>
      <div className="first-run setup-pages" ref={ref}>
        <div className="setup-progress muted">
          <span>
            Setting up · {index + 1} of {pages.length}
          </span>
          {scan ? (
            <span>
              Reading your library meanwhile: {scan.stage}
              {scan.detail ? ` · ${scan.detail}` : ''}
            </span>
          ) : (
            sawScan && <span>Your library is ready.</span>
          )}
        </div>
        <h1>{page.title}</h1>

        {/* At the top, so not caring costs one press rather than every row. */}
        <div className="settings-row setup-nav">
          <FocusButton
            className="btn-primary"
            focusKey={FORWARD_FOCUS_KEY}
            keepInView="nearest"
            onSelect={forward}
          >
            {last ? 'Finish' : page.alwaysNext || answered.has(page.id) ? 'Next' : 'Skip'}
          </FocusButton>
          {!last && (
            <FocusButton className="btn-secondary" keepInView="nearest" onSelect={onClose}>
              Finish later
            </FocusButton>
          )}
        </div>

        <PageBody key={page.id} id={page.id}>
          {page.body(() => setAnswered((a) => (a.has(page.id) ? a : new Set(a).add(page.id))))}
        </PageBody>

        {!last && (
          <p className="muted setup-later">
            Finish later goes to your library. Settings → Library → Run setup again brings these
            pages back.
          </p>
        )}
      </div>
    </FocusContext.Provider>
  );
}

/**
 * The page's own questions, as a container of their own, so arriving on a
 * page lands on its first question rather than on the buttons above it.
 *
 * Only while it has a question to land on. A page can have nothing to press:
 * Accounts in a build without SIMKL's or Trakt's app and without an
 * OpenSubtitles key, which is every build but a release. Focus given to an
 * empty container stays on the container, which draws no ring, so the remote
 * was left with nothing to act from — and every recovery chose this
 * container again. Out of the way, the page's own landing goes to Next.
 */
function PageBody({ id, children }: { id: string; children: ReactNode }) {
  const [hasControls, setHasControls] = useState(false);
  const { ref, focusKey } = useFocusable<object, HTMLElement>({
    focusKey: PAGE_FOCUS_KEY,
    trackChildren: true,
    saveLastFocusedChild: false,
    focusable: hasControls,
  });

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
    <FocusContext.Provider value={focusKey}>
      <section className="first-run-step setup-page" data-page={id} ref={ref}>
        {children}
      </section>
    </FocusContext.Provider>
  );
}
