/**
 * Focus keys for the places in the player that focus is aimed at explicitly:
 * the shell every control hangs off, the control the OSD opens on, the button
 * the track panel returns the ring to, and the seek bar. The track panel's own
 * key is beside it, in TrackPanel.tsx.
 *
 * Each must stay the same for a control's whole life (docs/GOTCHAS.md, "A
 * focus key that changes is never registered").
 */
export const PLAYER_SHELL_KEY = 'player-shell';
export const PLAYER_PLAY_KEY = 'player-play';
export const PLAYER_TRACKS_KEY = 'player-tracks-button';
export const PLAYER_SEEK_KEY = 'player-seek';
