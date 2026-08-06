import { useState } from 'react';
import Browse from './ui/Browse';
import LibraryView from './library/LibraryView';
import PlayerSpike from './spike/PlayerSpike';
import './App.css';

type Section = 'browse' | 'library' | 'spike';

/**
 * Browse is the real app. Library (scan/parse/match) and the Phase 0 mpv spike
 * are development surfaces reached from the switcher; both go away once the
 * library management moves into a proper settings screen.
 */
export default function App() {
  const [section, setSection] = useState<Section>('browse');
  const [playing, setPlaying] = useState(false);

  return (
    <>
      {section === 'browse' && <Browse onPlaybackChange={setPlaying} />}
      {section === 'library' && <LibraryView />}
      {section === 'spike' && <PlayerSpike />}

      {/* Hidden during playback — nothing should sit over the picture. */}
      <nav className={`dev-switch ${playing ? 'hidden' : ''}`}>
        <button className={section === 'browse' ? 'active' : ''} onClick={() => setSection('browse')}>
          Browse
        </button>
        <button
          className={section === 'library' ? 'active' : ''}
          onClick={() => setSection('library')}
        >
          Library
        </button>
        <button className={section === 'spike' ? 'active' : ''} onClick={() => setSection('spike')}>
          Spike
        </button>
      </nav>
    </>
  );
}
