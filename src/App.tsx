import { useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import Browse from './ui/Browse';
import Shortcuts from './ui/Shortcuts';
import { setShortcutsOpen, useShortcutsOpen } from './ui/shortcutsState';
import { loadTvMode, setTvMode, useTvMode } from './ui/tv';
import './App.css';

/**
 * Browse is the whole app now. Library management lives in its Settings screen,
 * with the stage-by-stage developer tools folded in behind a disclosure there.
 */
export default function App() {
  const tv = useTvMode();
  const showShortcuts = useShortcutsOpen();

  /**
   * Show the window once there is something to show.
   *
   * It is created hidden (`"visible": false` in tauri.conf.json). Shown at
   * once, a transparent window displayed WebView2's white and then — before
   * the page's first paint — whatever was behind the app, for about the first
   * second of every launch. By the time this effect runs React has committed
   * the first view, which paints an opaque background of its own.
   *
   * Not an animation frame: a hidden window may never get one. And `lib.rs`
   * shows the window by itself after a few seconds if this never runs, so a
   * failure here costs a slower start, never an invisible app.
   */
  useEffect(() => {
    void getCurrentWindow()
      .show()
      .catch((e) => console.warn('could not show the window', e));
  }, []);

  // Applied at the root so the scale reaches the player OSD too, not just the
  // browsing views — the controls are exactly what you need to read from the
  // sofa, and they live outside Browse.
  useEffect(() => {
    void loadTvMode();
  }, []);

  // Ctrl+Shift+T toggles the layout without a trip to the settings screen.
  // Comparing the layouts means switching back and forth repeatedly, and doing
  // that through two menus tells you nothing about how either one feels.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 't') {
        e.preventDefault();
        setTvMode(!tv);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tv]);

  /**
   * `?` opens the key list, Escape closes it.
   *
   * Registered in the **capture** phase, and it is the only listener here that
   * is. Browse turns Escape into "go home" and the player has a whole Escape
   * ladder, both on `window` in the bubble phase — so without capturing first,
   * dismissing this overlay would also navigate away behind it. Capturing at
   * `window` runs before either of them, and stopping propagation there means
   * neither ever sees the press.
   */
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Typing a question mark into the search box is not a request for help.
      const target = e.target as HTMLElement | null;
      const typing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA';

      if (!showShortcuts && e.key === '?' && !typing) {
        e.preventDefault();
        e.stopPropagation();
        setShortcutsOpen(true);
      } else if (
        showShortcuts &&
        (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack' || e.key === '?')
      ) {
        e.preventDefault();
        e.stopPropagation();
        setShortcutsOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [showShortcuts]);

  return (
    <>
      <Browse />
      {showShortcuts && <Shortcuts onClose={() => setShortcutsOpen(false)} />}
    </>
  );
}
