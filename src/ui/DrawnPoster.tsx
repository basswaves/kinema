/**
 * A poster drawn for a title with no picture: nothing beside its files, none
 * from TMDB, no frame. It replaced a grey card with the name on it, which made
 * a fresh library — or one whose pictures are still on their way — look broken.
 *
 * The colour comes from the title and year, so the same film is the same
 * colour on every screen and every launch, never random per run. Drawn in CSS,
 * not a stored image: it costs nothing, needs no ffmpeg, and asks no host.
 * Order of pictures stays: beside the files → TMDB → a frame → this.
 */
import { drawnStyle } from './drawnColour';

interface Props {
  title: string;
  year?: number | null;
  /** A wide slot (Continue Watching): the name on one line, smaller. */
  wide?: boolean;
  className?: string;
}

export default function DrawnPoster({ title, year, wide, className }: Props) {
  return (
    <div
      className={`drawn-poster${wide ? ' wide' : ''}${className ? ` ${className}` : ''}`}
      style={drawnStyle(title, year)}
      aria-label={title}
      role="img"
    >
      <span className="drawn-poster-title">{title}</span>
      {year ? <span className="drawn-poster-year">{year}</span> : null}
    </div>
  );
}
