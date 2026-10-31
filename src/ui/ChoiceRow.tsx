/**
 * A setting whose choices are all on screen at once.
 *
 * Settings used to be one button that cycled through values it did not show:
 * "Offer the next episode: 60s early, press to cycle". You could not see the
 * options, and going one too far meant going all the way round. Here each
 * choice is its own button in a row: Left and Right move along it, OK picks,
 * and the chosen one is marked.
 *
 * Under it, everything there is to say about it, in two short parts: what it
 * does, and when to choose otherwise. For a while the rest sat behind a "More
 * about this" button, and the rest was usually where the useful part was.
 *
 * The choices are a row (focusGroups.ts): Up or Down into it lands on the
 * chosen one (owner, 2026-10-30). Landing on the nearest choice depended on
 * how wide the words are drawn, which differs with the system's font — Linux
 * and Windows went to different choices from the same place.
 */
import { useId, type ReactNode } from 'react';
import FocusButton from './FocusButton';
import { FocusProvider } from './FocusGroup';
import { useFocusGroup } from './focusGroups';

export interface Choice<V extends string> {
  value: V;
  label: string;
}

interface Props<V extends string> {
  label: string;
  choices: Choice<V>[];
  value: V;
  onChange: (value: V) => void;
  /** What it does, in a sentence or two. */
  note?: ReactNode;
  /** When to pick the other choice, and what it costs. Quieter, under `note`. */
  hint?: ReactNode;
  /** More to choose, under the choices — the devices "only these" means. */
  children?: ReactNode;
}

export default function ChoiceRow<V extends string>({
  label,
  choices,
  value,
  onChange,
  note,
  hint,
  children,
}: Props<V>) {
  return (
    <div className="choice-row">
      <div className="choice-label">{label}</div>
      <ChoiceOptions label={label} choices={choices} value={value} onChange={onChange} />
      {children}
      {note && <p className="choice-note">{note}</p>}
      {hint && <p className="choice-hint">{hint}</p>}
    </div>
  );
}

/** The choices alone, as one row: what is under them stays part of the page. */
function ChoiceOptions<V extends string>({
  label,
  choices,
  value,
  onChange,
}: Pick<Props<V>, 'label' | 'choices' | 'value' | 'onChange'>) {
  // Labels repeat between rows ("Intros and credits"); an id per row does not.
  const id = useId();
  const keyOf = (v: V) => `choice:${id}:${v}`;
  // A question not answered yet (the first run's devices) lands on its first
  // choice. Left from the first choice still goes back to the list of sections.
  const chosen = choices.some((c) => c.value === value) ? value : choices[0]?.value;
  const { ref, focusKey } = useFocusGroup('row', {
    current: chosen === undefined ? undefined : keyOf(chosen),
    stopAt: ['right'],
  });
  return (
    <FocusProvider value={focusKey}>
      <div
        className="choice-options"
        role="radiogroup"
        aria-label={label}
        ref={ref}
        // Up and Down out of it measure from the choice the ring is on (focusGroups.ts).
        data-leave-from-ring=""
      >
        {choices.map((choice) => (
          <FocusButton
            key={choice.value}
            focusKey={keyOf(choice.value)}
            className={`choice ${choice.value === value ? 'chosen' : ''}`}
           
            onSelect={() => onChange(choice.value)}
          >
            {choice.value === value && <span className="choice-tick">✓</span>}
            {choice.label}
          </FocusButton>
        ))}
      </div>
    </FocusProvider>
  );
}
