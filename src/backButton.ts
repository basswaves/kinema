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
 * Where there is no such button (Windows, Linux) the listener simply never
 * hears anything.
 */
import { onBackButtonPress } from '@tauri-apps/api/app';

export function installBackButton(): void {
  onBackButtonPress(() => {
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
