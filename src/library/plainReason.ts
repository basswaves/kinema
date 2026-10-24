/**
 * The matcher's reason for a refusal, in plain words for Needs attention.
 *
 * The stored reason is assembled from fragments in `metadata/score.ts` and
 * `metadata/match.ts` ("title 52%, year exact; ambiguous vs "Beast""), and
 * `adviceFor` in FixMatch.tsx matches on that wording, so the stored text
 * stays as it is. This only changes how it reads: the same facts, said the
 * way a person would. A fragment it does not know passes through unchanged.
 */
export function plainReason(reason: string): string {
  // " · searched as “X” from Y" is already plain; keep it apart and put it back.
  const at = reason.indexOf(' · ');
  const note = at >= 0 ? reason.slice(at) : '';
  const core = at >= 0 ? reason.slice(0, at) : reason;

  if (core === 'no candidates returned') return `Nothing came back for this name${note}`;
  if (core === 'no candidates scored') return `Nothing that came back was close${note}`;
  if (!/^title \d+%/.test(core)) return reason;

  const [scores, ...rest] = core.split('; ');
  const facts = scores.split(', ').map(plainScore);
  const others = rest.map(plainRunnerUp);
  const sentence = [facts.join(', '), ...others].join('; ');
  return sentence.charAt(0).toUpperCase() + sentence.slice(1) + note;
}

function plainScore(part: string): string {
  const title = /^title (\d+)%$/.exec(part);
  if (title) return `the name is ${title[1]} % alike`;
  if (part === 'year exact') return 'the year is the same';
  if (part === 'year ±1') return 'the year is one off';
  const off = /^year off by (\d+)$/.exec(part);
  if (off) return `the year is ${off[1]} years off`;
  if (part === 'no candidate year') return 'it has no year to compare';
  if (part === 'candidate has no episodes') return 'it lists no episodes';
  return part;
}

function plainRunnerUp(part: string): string {
  const ambiguous = /^ambiguous vs "(.*)"$/.exec(part);
  if (ambiguous) return `“${ambiguous[1]}” looked just as likely`;
  const tie = /^tie vs "(.*)" broken by popularity$/.exec(part);
  if (tie) return `close to “${tie[1]}”, the better-known one was taken`;
  return part;
}
