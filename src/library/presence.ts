/**
 * Android: whether Kinema is on the screen, from the plugin (Media3Plugin.kt,
 * which hears it from Android), for the library's work to wait on (playback.ts).
 * A desktop never hears of this: its background work is unchanged.
 */
import { addPluginListener, invoke } from '@tauri-apps/api/core';
import { capabilitiesNow, loadCapabilities } from '../capabilities';
import { setBehindScreen } from './playback';

export async function watchPresence(): Promise<void> {
  await loadCapabilities();
  if (capabilitiesNow()?.engine !== 'media3') return;

  // Anything that proves Kinema is in front goes on, whatever was heard last: a
  // scan held back by a message that went astray would wait for good, and look
  // like a scan that never ends. Waiting wrongly is the failure to avoid here.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setBehindScreen(false);
  });
  window.addEventListener('keydown', () => setBehindScreen(false), true);

  try {
    await addPluginListener<{ behind: boolean }>('media3', 'presence', (event) =>
      setBehindScreen(event.behind)
    );
    // A page started while Kinema is behind (the system gave up the old one,
    // PageGone.kt) has heard nothing, and would start the scan at once.
    const { inFront } = await invoke<{ inFront: boolean }>('plugin:media3|in_front');
    setBehindScreen(!inFront);
  } catch (e) {
    console.warn('presence: Android is not telling us when Kinema leaves the screen:', e);
  }
}
