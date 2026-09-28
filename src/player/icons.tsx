/**
 * The player's control icons. Drawn here rather than taken from an icon set:
 * a dozen simple shapes are less to carry than a dependency, and they take the
 * button's own colour (`currentColor`) so focus and hover states need nothing
 * extra. Decorative — every button carries its name as `aria-label` and title.
 */
import type { ReactNode } from 'react';

function Icon({ children, filled = false }: { children: ReactNode; filled?: boolean }) {
  return (
    <svg
      className="player-icon"
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill={filled ? 'currentColor' : 'none'}
      stroke={filled ? 'none' : 'currentColor'}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const PlayIcon = () => (
  <Icon filled>
    <path d="M7 4.5v15a.5.5 0 0 0 .77.42l11.5-7.5a.5.5 0 0 0 0-.84L7.77 4.08A.5.5 0 0 0 7 4.5z" />
  </Icon>
);

export const PauseIcon = () => (
  <Icon filled>
    <rect x="6" y="4.5" width="4" height="15" rx="1" />
    <rect x="14" y="4.5" width="4" height="15" rx="1" />
  </Icon>
);

export const PreviousIcon = () => (
  <Icon filled>
    <rect x="5" y="5" width="2.5" height="14" rx="1" />
    <path d="M19 5.9v12.2a.5.5 0 0 1-.8.4L9.6 12.4a.5.5 0 0 1 0-.8l8.6-6.1a.5.5 0 0 1 .8.4z" />
  </Icon>
);

export const NextIcon = () => (
  <Icon filled>
    <rect x="16.5" y="5" width="2.5" height="14" rx="1" />
    <path d="M5 5.9v12.2a.5.5 0 0 0 .8.4l8.6-6.1a.5.5 0 0 0 0-.8L5.8 5.5a.5.5 0 0 0-.8.4z" />
  </Icon>
);

/** A turning arrow with the seconds inside it; `back` turns it the other way. */
function JumpIcon({ back }: { back: boolean }) {
  return (
    <Icon>
      <g transform={back ? undefined : 'matrix(-1 0 0 1 24 0)'}>
        <path d="M5 12a7 7 0 1 0 2.05-4.95" />
        <path d="M5 4v4h4" />
      </g>
      <text
        x="12"
        y="15.2"
        textAnchor="middle"
        fontSize="7.5"
        fontWeight="700"
        fill="currentColor"
        stroke="none"
      >
        10
      </text>
    </Icon>
  );
}

export const BackTenIcon = () => <JumpIcon back />;
export const ForwardTenIcon = () => <JumpIcon back={false} />;

export const SubtitlesIcon = () => (
  <Icon>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M7 12h3M13 12h4M7 15.5h6M16 15.5h1" />
  </Icon>
);

export const VolumeIcon = ({ muted }: { muted: boolean }) => (
  <Icon>
    <path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor" />
    {muted ? (
      <path d="M16 9.5l5 5M21 9.5l-5 5" />
    ) : (
      <>
        <path d="M15.5 9a4 4 0 0 1 0 6" />
        <path d="M18 6.5a7.5 7.5 0 0 1 0 11" />
      </>
    )}
  </Icon>
);

export const FullscreenIcon = () => (
  <Icon>
    <path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5" />
  </Icon>
);
