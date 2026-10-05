/**
 * The system's own Back button — the one on an Android remote, or a phone's
 * Back gesture — made into the Back every screen already listens for.
 *
 * Kinema's screens each handle Back as a key press: Escape, Backspace, or the
 * `BrowserBack` many remotes send. Android's Back is not a key the page ever
 * sees. Left alone it closes the app from any screen, so a remote's Back in
 * the middle of Settings landed on the TV's home screen. Listening for it
 * here stops that, and the press is passed on as `BrowserBack` to whatever
 * has focus, so every screen's own handling — the player, dialogs, Leave on
 * Home — works unchanged.
 *
 * Only where the system has such a button (capability `back_button`). A
 * desktop has none, and asking for it there is refused — which logged a
 * warning at every start of every Windows and Linux copy, read in bug
 * reports as something wrong.
 */
import { onBackButtonPress } from '@tauri-apps/api/app';
import { capabilitiesNow, loadCapabilities } from './capabilities';

export async function installBackButton(): Promise<void> {
  await loadCapabilities();
  if (!capabilitiesNow()?.back_button) return;
  await onBackButtonPress(() => {
    const target = document.activeElement ?? document.body;
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'BrowserBack', code: 'BrowserBack', bubbles: true, cancelable: true })
    );
  }).catch((e: unknown) => {
    // Without it the system's Back closes Kinema, as before; every other way
    // back still works.
    console.warn('back button: could not listen', e);
  });
}
