/**
 * Send HDR only to a screen that is showing HDR.
 *
 * mpv's own choice cannot be relied on here. With `target-colorspace-hint` at
 * `yes` *or* `auto` it tags the output HDR10 even on an SDR screen with
 * Windows HDR off (measured on the development monitor), and Windows
 * then converts it down itself — so the BT.2390 tone mapping this project
 * chose on purpose never ran for anyone with an SDR screen. The backend knows
 * whether the screen the window is on has HDR switched on, so it is asked
 * before every file: HDR can be switched in Windows at any moment.
 *
 *   HDR on        -> hint on; with the hint mode `source` the display gets the
 *                    film's own HDR10 metadata and tone maps it itself.
 *   HDR off / SDR -> hint off; mpv tone maps to SDR with TONE_MAPPING_OPTIONS.
 *   unknown       -> hint on, as before this existed: HDR stays possible.
 */
import { invoke } from '@tauri-apps/api/core';
import { setProperty } from 'tauri-plugin-libmpv-api';
import type { HdrState } from './equipment';

interface WindowDisplay {
  gdi_name: string;
  hdr: HdrState;
}

export function hintFor(hdr: HdrState): 'yes' | 'no' {
  return hdr === 'off' || hdr === 'unsupported' ? 'no' : 'yes';
}

let lastLogged = '';

export async function matchHdrToDisplay(): Promise<void> {
  let display: WindowDisplay;
  try {
    display = await invoke<WindowDisplay>('window_display');
  } catch (e) {
    console.warn('display: could not ask which screen the window is on', e);
    return;
  }
  const hint = hintFor(display.hdr);
  await setProperty('target-colorspace-hint', hint);
  // Once per change, not per file: an evening of episodes would otherwise
  // repeat the same line forty times.
  const line = `display: ${display.gdi_name || 'unknown screen'} HDR ${display.hdr} → colour-space hint ${hint}`;
  if (line !== lastLogged) {
    lastLogged = line;
    console.log(line);
  }
}
