/**
 * A setting whose choices are all on screen at once.
 *
 * Settings used to be one button that cycled through values it did not show:
 * "Offer the next episode: 60s early — press to cycle". You could not see the
 * options, and going one too far meant going all the way round. Here each
 * choice is its own button in a row: Left and Right move along it, OK picks,
 * and the chosen one is marked.
 */
import type { ReactNode } from 'react';
import FocusButton from './FocusButton';
import MoreAbout from './MoreAbout';

export interface Choice<V extends string> {
  value: V;
  label: string;
}

interface Props<V extends string> {
  label: string;
  choices: Choice<V>[];
  value: V;
  onChange: (value: V) => void;
  /** One line under the row. */
  note?: ReactNode;
  /** The longer explanation, behind "More about this". */
  more?: ReactNode;
}

export default function ChoiceRow<V extends string>({
  label,
  choices,
  value,
  onChange,
  note,
  more,
}: Props<V>) {
  return (
    <div className="choice-row">
      <div className="choice-label">{label}</div>
      <div className="choice-options" role="radiogroup" aria-label={label}>
        {choices.map((choice) => (
          <FocusButton
            key={choice.value}
            className={`choice ${choice.value === value ? 'chosen' : ''}`}
            keepInView="nearest"
            onSelect={() => onChange(choice.value)}
          >
            {choice.value === value && <span className="choice-tick">✓</span>}
            {choice.label}
          </FocusButton>
        ))}
      </div>
      {note && <p className="muted choice-note">{note}</p>}
      {more && <MoreAbout>{more}</MoreAbout>}
    </div>
  );
}
