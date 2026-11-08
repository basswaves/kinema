/**
 * "Worth a look" in Needs attention (round 8 L3, worthALook.ts): matches made
 * under older rules that today's rules read differently. Each says why in one
 * sentence and offers the two choices a person has: keep it as it is, or find
 * the right match with the same search as the rest of the queue. Either is a
 * hand decision; until one is made the file stays linked as it was.
 */
import { useLayoutEffect, useMemo, useState } from 'react';
import FocusButton from '../ui/FocusButton';
import FocusGroup from '../ui/FocusGroup';
import { useFocusLeaf } from '../ui/focusGroups';
import { lineUp, MOTION_MS } from '../ui/focusScroll';
import { count } from '../ui/format';
import { applyMatch, loadProviderKeys } from '../metadata/match';
import { MatchSearch } from './FixMatch';
import {
  keepAsItIs,
  whyWords,
  worthRowKey,
  type Why,
  type WorthGroup,
} from './worthALook';

/** What to search for at first: what the name says now, else the linked title. */
function firstQuery(group: WorthGroup): string {
  try {
    const why = JSON.parse(group.why) as Why;
    if (why.kind === 'title' && why.now) return why.now;
  } catch {
    // An unreadable reason searches for the title it is linked to.
  }
  return group.title;
}

const titleWithYear = (title: string, year: number | null) =>
  year ? `“${title}” (${year})` : `“${title}”`;

export function WorthALookSection({
  groups,
  busy,
  run,
}: {
  groups: WorthGroup[];
  busy: boolean;
  /** FixMatch's own: does the work, re-reads the queue, says what happened. */
  run: (work: () => Promise<string>) => void;
}) {
  const [openKey, setOpenKey] = useState<string | null>(null);
  const files = useMemo(() => groups.reduce((n, g) => n + g.files.length, 0), [groups]);

  return (
    <FocusGroup kind="panel" className="fixmatch-worth">
      <header className="fixmatch-head">
        <h3>Worth a look</h3>
        <span className="muted">
          {count(files, 'file')} Kinema matched by itself before an update, which the new rules
          would look at again. Nothing changes until you choose.
        </span>
      </header>
      {groups.map((group) => (
        <WorthRow
          key={group.key}
          group={group}
          busy={busy}
          open={openKey === group.key}
          onToggle={() => setOpenKey(openKey === group.key ? null : group.key)}
          onKeep={() =>
            run(async () => {
              await keepAsItIs(group.files.map((f) => f.file_id));
              setOpenKey(null);
              return `Kept ${count(group.files.length, 'file')} with ${titleWithYear(group.title, group.year)}.`;
            })
          }
          onLink={(provider, candidate, isSeries) =>
            run(async () => {
              await applyMatch(
                group.files.map((f) => ({ id: f.file_id })),
                provider,
                candidate.providerId,
                isSeries,
                await loadProviderKeys(),
                1,
                `manual: “${candidate.title}”${candidate.year ? ` (${candidate.year})` : ''} via ${provider}, was “${group.title}”`
              );
              setOpenKey(null);
              return `Linked ${count(group.files.length, 'file')} to “${candidate.title}”.`;
            })
          }
        />
      ))}
    </FocusGroup>
  );
}

function WorthRow({
  group,
  busy,
  open,
  onToggle,
  onKeep,
  onLink,
}: {
  group: WorthGroup;
  busy: boolean;
  open: boolean;
  onToggle: () => void;
  onKeep: () => void;
  onLink: Parameters<typeof MatchSearch>[0]['onLink'];
}) {
  const [isSeries, setIsSeries] = useState(group.isSeries);
  return (
    <FocusGroup kind="panel" className={`fixmatch-row ${open ? 'open' : ''}`}>
      <WorthSummary group={group} open={open} onToggle={onToggle} />
      {open && (
        <div className="fixmatch-panel">
          <ul className="fixmatch-files">
            {group.files.slice(0, 8).map((file) => (
              <li key={file.file_id} title={file.path}>
                {file.file_name}
              </li>
            ))}
            {group.files.length > 8 && (
              <li className="muted">…and {group.files.length - 8} more</li>
            )}
          </ul>
          <FocusGroup kind="row" className="fixmatch-search">
            <FocusButton className="primary" disabled={busy} onSelect={onKeep}>
              Keep as it is
            </FocusButton>
          </FocusGroup>
          <p className="muted">Or find the right match:</p>
          <MatchSearch
            initialQuery={firstQuery(group)}
            isSeries={isSeries}
            onToggleSeries={() => setIsSeries((v) => !v)}
            busy={busy}
            linkLabel={`Link ${group.files.length} file${group.files.length === 1 ? '' : 's'}`}
            onLink={onLink}
          />
        </div>
      )}
    </FocusGroup>
  );
}

/** The row's summary is its own control, as in the rest of the queue. */
function WorthSummary({
  group,
  open,
  onToggle,
}: {
  group: WorthGroup;
  open: boolean;
  onToggle: () => void;
}) {
  const { ref, focused, navProps } = useFocusLeaf<HTMLDivElement>({
    focusKey: worthRowKey(group),
    onSelect: onToggle,
  });
  useLayoutEffect(() => {
    const summary = ref.current;
    const row = summary?.parentElement;
    if (open && summary && row) lineUp(row, summary, MOTION_MS);
  }, [open, ref]);
  return (
    <div
      ref={ref}
      className={`fixmatch-summary ${focused ? 'focused' : ''}`}
      onClick={onToggle}
      role="button"
      {...navProps}
      tabIndex={0}
    >
      <div className="fixmatch-title">
        {group.title}
        {group.year ? ` (${group.year})` : ''}
        <span className="muted">
          {' '}
          · {count(group.files.length, 'file')} · {group.isSeries ? 'series' : 'movie'}
        </span>
      </div>
      <div className="fixmatch-advice">{whyWords(group.why, group.title)}</div>
    </div>
  );
}
