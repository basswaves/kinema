import { useEffect } from 'react';
import Browse from './ui/Browse';
import { loadTvMode, setTvMode, useTvMode } from './ui/tv';
import './App.css';

/**
 * Browse is the whole app now. Library management lives in its Settings screen,
 * with the stage-by-stage developer tools folded in behind a disclosure there.
 *
 * `src/spike/PlayerSpike.tsx` is deliberately still on disk but no longer
 * reachable: it is the diagnostic harness for HDR passthrough, which remains
 * unverified for want of an HDR display. It goes when that is confirmed.
 */
export default function App() {
  const tv = useTvMode();

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

  return <Browse />;
}
