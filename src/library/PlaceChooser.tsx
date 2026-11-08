/**
 * "Where do these go?" (GitHub #14, placing.ts): a show's season for some
 * files — Specials too — and the episode numbers, when the names and the
 * service disagree. From Needs attention's `Link as…` (in `PlaceDialog`) and
 * from Files and title's `Move to another season…` (inside that dialog).
 *
 * It never decides: it shows where each file would go, says which would
 * become a second copy, and the person presses. Nothing on disk changes.
 *
 * The seasons are a row of buttons as the design drew them, kept on one line
 * (a row that wraps hides its second line from a remote: GOTCHAS); a long
 * show's row scrolls sideways under the ring.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import FocusButton from '../ui/FocusButton';
import FocusGroup, { FocusProvider } from '../ui/FocusGroup';
import { useFocusGroup } from '../ui/focusGroups';
import { navFocus } from '../ui/focusStore';
import { count } from '../ui/format';
import { getTitleDetail, type Episode } from '../ui/api';
import { describeFailure } from '../metadata/reach';
import {
  firstOf,
  planPlacements,
  secondCopies,
  seasonLabel,
  seasonsOffered,
  titleFiles,
  type PlaceFile,
  type Placement,
  type TitleFile,
} from './placing';
import './fixmatch.css';

export const PLACE_NAMES_KEY = 'place-as-names';
const seasonKey = (s: number) => `place-season-${s}`;
const pickKey = (e: number) => `place-pick-${e}`;
const rowKey = (id: number) => `place-row-${id}`;

interface ChooserProps {
  titleId: number;
  show: string;
  files: PlaceFile[];
  /** `Link` from Needs attention, `Move` from Files and title. */
  verb: 'Link' | 'Move';
  /** The season to start on; `names` = as the names say. */
  initial: number | 'names';
  busy: boolean;
  /** `null`: as the names say. */
  onPlace: (placements: Placement[] | null, where: string) => void;
  onCancel: () => void;
  /**
   * Set while one row's episode is being picked: the dialog's own Back
   * handler runs first (it was added first) and must leave that Back to the
   * picker, which takes it back to the list.
   */
  pickingRef: { current: boolean };
}

export function PlaceChooser({ titleId, show, files, verb, initial, busy, onPlace, onCancel, pickingRef }: ChooserProps) {
  const [season, setSeason] = useState<number | 'names'>(initial);
  const [first, setFirst] = useState(() => firstOf(files));
  const [picked, setPicked] = useState<Map<number, number>>(new Map());
  const [pickingFor, setPickingFor] = useState<number | null>(null);
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [here, setHere] = useState<TitleFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([getTitleDetail(titleId), titleFiles(titleId)])
      .then(([detail, list]) => {
        if (cancelled) return;
        setEpisodes(detail.episodes);
        setHere(list);
      })
      .catch(async (e: unknown) => !cancelled && setError(await describeFailure(e)));
    return () => {
      cancelled = true;
    };
  }, [titleId]);

  const named = useMemo(() => [...new Set(files.map((f) => f.season))], [files]);
  const seasons = useMemo(() => seasonsOffered(episodes, named), [episodes, named]);
  const namesSay = named.length === 1 ? seasonLabel(named[0]) : 'their own seasons';

  const plan = useMemo<Placement[]>(
    () =>
      season === 'names'
        ? [...files]
            .sort((a, b) => a.file_name.localeCompare(b.file_name))
            .map((f) => ({ file_id: f.id, season: f.season, episode: f.episode }))
        : planPlacements(files, season, first, picked),
    [files, season, first, picked]
  );
  const copies = useMemo(() => secondCopies(plan, here), [plan, here]);
  const nameOf = useCallback(
    (s: number | null, e: number | null) =>
      episodes.find((x) => x.season === s && x.episode === e && x.name)?.name ?? null,
    [episodes]
  );
  const byId = useMemo(() => new Map(files.map((f) => [f.id, f])), [files]);

  const choose = (s: number | 'names') => {
    setSeason(s);
    setPicked(new Map());
  };

  /** The row the ring goes back to when the picker closes. */
  const back = useRef<number | null>(null);
  // Back while picking one row's episode goes back to the list, not out.
  useEffect(() => {
    pickingRef.current = pickingFor !== null;
    if (pickingFor === null) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopImmediatePropagation();
        back.current = pickingFor;
        setPickingFor(null);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [pickingFor, pickingRef]);

  // The list and the picker take each other's place: the ring goes with them.
  useLayoutEffect(() => {
    if (pickingFor !== null) {
      const at = plan.find((p) => p.file_id === pickingFor)?.episode;
      const list = episodes.filter((e) => e.season === season);
      navFocus(pickKey(list.some((e) => e.episode === at) ? (at as number) : (list[0]?.episode ?? 0)));
    } else if (back.current !== null) {
      navFocus(rowKey(back.current));
      back.current = null;
    }
  }, [pickingFor, plan, episodes, season]);

  const where = season === 'names' ? `as the names say (${namesSay})` : seasonLabel(season);
  const n = files.length;
  const target = season === 'names' ? [] : episodes.filter((e) => e.season === season);

  if (pickingFor !== null) {
    const f = byId.get(pickingFor);
    return (
      <div className="place">
        <p className="muted">
          Which episode of {seasonLabel(season as number)} is <strong>{f?.file_name}</strong>?
        </p>
        <FocusGroup kind="panel" className="place-picks">
          {target.map((e) => (
            <FocusButton
              key={e.episode}
              focusKey={pickKey(e.episode)}
              className="place-pick"
              onSelect={() => {
                setPicked((m) => new Map(m).set(pickingFor, e.episode));
                back.current = pickingFor;
                setPickingFor(null);
              }}
            >
              {seasonLabel(e.season)} {e.episode}
              {e.name ? ` · ${e.name}` : ''}
            </FocusButton>
          ))}
          {target.length === 0 && (
            <p className="muted">The service lists no episodes for this season.</p>
          )}
        </FocusGroup>
        <FocusGroup kind="row" className="settings-row wrong-title-foot">
          <FocusButton
            className="btn-secondary"
            onSelect={() => {
              back.current = pickingFor;
              setPickingFor(null);
            }}
          >
            Back to the list
          </FocusButton>
        </FocusGroup>
      </div>
    );
  }

  return (
    <div className="place">
      <h2>
        {show}: where do {n === 1 ? 'this file' : `these ${n} files`} go?
      </h2>
      {error && <div className="fixmatch-error">{error}</div>}
      <FocusGroup
        kind="row"
        className="settings-row place-seasons"
        current={season === 'names' ? PLACE_NAMES_KEY : seasonKey(season)}
      >
        <FocusButton
          focusKey={PLACE_NAMES_KEY}
          className={season === 'names' ? 'on' : ''}
          onSelect={() => choose('names')}
        >
          As the names say: {namesSay}
        </FocusButton>
        {seasons.map((s) => (
          <FocusButton
            key={s}
            focusKey={seasonKey(s)}
            className={season === s ? 'on' : ''}
            onSelect={() => choose(s)}
          >
            {seasonLabel(s)}
          </FocusButton>
        ))}
      </FocusGroup>

      {season !== 'names' && (
        <FocusGroup kind="row" className="settings-row place-first">
          <span className="muted">First episode:</span>
          <FocusButton
            label="First episode: one lower"
            // Never disabled: a remote could not reach it, and the ring on it
            // would be stranded when it turned so (GOTCHAS). At 1 it stays 1.
            onSelect={() => {
              setFirst((v) => Math.max(1, v - 1));
              setPicked(new Map());
            }}
          >
            −
          </FocusButton>
          <span className="place-first-n">{first}</span>
          <FocusButton
            label="First episode: one higher"
            onSelect={() => {
              setFirst((v) => v + 1);
              setPicked(new Map());
            }}
          >
            +
          </FocusButton>
        </FocusGroup>
      )}

      <FocusGroup kind="panel" className="place-rows">
        {plan.map((p) => {
          const f = byId.get(p.file_id);
          const title = nameOf(p.season, p.episode);
          const label = (
            <>
              <span className="place-file">{f?.file_name}</span>
              <span className="place-arrow" aria-hidden>
                →
              </span>
              <span className="place-to">
                {p.season === null || p.episode === null
                  ? 'no episode number'
                  : `${seasonLabel(p.season)} ${p.episode}${title ? ` · ${title}` : ''}`}
                {copies.has(p.file_id) && (
                  <span className="place-copy"> · already here: this becomes a second copy</span>
                )}
              </span>
            </>
          );
          return season === 'names' ? (
            <div key={p.file_id} className="place-row">
              {label}
            </div>
          ) : (
            <FocusButton
              key={p.file_id}
              focusKey={rowKey(p.file_id)}
              className="place-row"
              label={`${f?.file_name}: choose its episode`}
              onSelect={() => setPickingFor(p.file_id)}
            >
              {label}
            </FocusButton>
          );
        })}
      </FocusGroup>
      {season !== 'names' && (
        <p className="muted wrong-title-note">
          Press a row to choose its episode yourself. File names stay as they are.
        </p>
      )}

      <FocusGroup kind="row" className="settings-row wrong-title-foot">
        <FocusButton
          className="primary"
          disabled={busy}
          onSelect={() => onPlace(season === 'names' ? null : plan, where)}
        >
          {busy ? 'Working…' : `${verb} ${count(n, 'file')}`}
        </FocusButton>
        <FocusButton className="btn-secondary" onSelect={onCancel}>
          Cancel
        </FocusButton>
      </FocusGroup>
    </div>
  );
}

interface DialogProps extends Omit<ChooserProps, 'onCancel' | 'initial' | 'verb' | 'pickingRef'> {
  onClose: () => void;
  /**
   * A plain link would stack these files on episodes another group already
   * has: asked first, with the choice to go on.
   */
  question?: string;
  onSecondCopies?: () => void;
  error?: string | null;
}

/** Needs attention's `Link as…`: the chooser in a dialog of its own. */
export function PlaceDialog({ question, onSecondCopies, onClose, error, ...chooser }: DialogProps) {
  const [asking, setAsking] = useState(Boolean(question));
  const pickingRef = useRef(false);
  const { ref, focusKey } = useFocusGroup('menu', {
    current: asking ? 'place-ask-choose' : PLACE_NAMES_KEY,
  });

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (pickingRef.current) return;
      if (e.key === 'Escape' || e.key === 'BrowserBack' || e.key === 'Backspace') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [onClose]);

  useLayoutEffect(() => {
    if (!asking) navFocus(PLACE_NAMES_KEY);
  }, [asking]);

  return (
    <FocusProvider value={focusKey}>
      <div className="leave-backdrop" onClick={onClose}>
        <div
          className="leave wrong-title"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label="Where do these go?"
        >
          {error && <div className="fixmatch-error">{error}</div>}
          {asking ? (
            <>
              <h2>{chooser.show}</h2>
              <p>{question}</p>
              <FocusGroup kind="row" className="settings-row wrong-title-foot">
                <FocusButton focusKey="place-ask-choose" className="primary" onSelect={() => setAsking(false)}>
                  Choose where they go
                </FocusButton>
                <FocusButton className="btn-secondary" disabled={chooser.busy} onSelect={() => onSecondCopies?.()}>
                  Add as second copies
                </FocusButton>
                <FocusButton className="btn-secondary" onSelect={onClose}>
                  Cancel
                </FocusButton>
              </FocusGroup>
            </>
          ) : (
            <PlaceChooser {...chooser} verb="Link" initial="names" onCancel={onClose} pickingRef={pickingRef} />
          )}
        </div>
      </div>
    </FocusProvider>
  );
}
