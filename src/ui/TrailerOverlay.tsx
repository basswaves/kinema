/**
 * A YouTube trailer playing inside Kinema (trailer.ts says when): YouTube's
 * embedded player in a frame, driven from Kinema's own keys. OK pauses, the
 * arrows seek ten seconds, Back or Esc closes, and Down reaches the buttons.
 * Any error YouTube reports, or no answer in a few seconds, closes it and
 * opens the trailer in the browser instead.
 *
 * The frame is another site's page: once it holds the keyboard, keys go to it
 * and never come back. So it is kept out of the tab order, and when a click
 * hands it the keyboard anyway, Kinema takes it straight back — the click
 * itself still reaches YouTube's own controls.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import FocusButton from './FocusButton';
import FocusGroup, { FocusProvider } from './FocusGroup';
import { ALL_ARROWS, useNavGroup } from './focusGroups';
import { useNavLeaf } from './focusStore';
import { openLink } from './links';
import {
  closeTrailer,
  EMBED_ORIGIN,
  embedUrl,
  errorText,
  readNews,
  watchUrl,
  type ShownTrailer,
} from './trailer';

const SCREEN_KEY = 'trailer-screen';
const CLOSE_KEY = 'trailer-close';
/** How long YouTube's player has to say it is ready before the browser gets it. */
const READY_MS = 8000;
const SEEK_S = 10;
/** YouTube's player states: 1 playing, 2 paused. */
const PLAYING = 1;

export default function TrailerOverlay({ trailer }: { trailer: ShownTrailer }) {
  // A dialog: the ring on the picture as it opens, and back where it was on
  // the way out (focusStore.ts).
  const { ref, focusKey } = useNavGroup({ kind: 'column', current: SCREEN_KEY, hold: ALL_ARROWS, modal: true });
  const frame = useRef<HTMLIFrameElement>(null);
  const player = useRef({ state: -1, time: 0, ready: false });
  const [paused, setPaused] = useState(false);

  const send = useCallback((func: string, args: unknown[] = []) => {
    frame.current?.contentWindow?.postMessage(
      JSON.stringify({ event: 'command', func, args, id: 1, channel: 'widget' }),
      EMBED_ORIGIN
    );
  }, []);

  const toggle = useCallback(() => {
    send(player.current.state === PLAYING ? 'pauseVideo' : 'playVideo');
  }, [send]);

  const seek = useCallback(
    (by: number) => {
      const to = Math.max(0, player.current.time + by);
      player.current.time = to;
      send('seekTo', [to, true]);
    },
    [send]
  );

  const close = useCallback((why?: string) => closeTrailer(why), []);

  // What YouTube's frame says: ready, playing or paused, where it is, errors.
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== EMBED_ORIGIN || e.source !== frame.current?.contentWindow) return;
      const news = readNews(e.data);
      if (!news) return;
      const info = news.info as Record<string, unknown> | number | undefined;
      if (news.event === 'onReady') player.current.ready = true;
      else if (news.event === 'onError') close(errorText(info));
      else if (news.event === 'onStateChange' && typeof info === 'number') {
        player.current.state = info;
        setPaused(info === 2);
      } else if (news.event === 'infoDelivery' && info && typeof info === 'object') {
        if (typeof info.currentTime === 'number') player.current.time = info.currentTime;
        if (typeof info.playerState === 'number') {
          player.current.state = info.playerState;
          setPaused(info.playerState === 2);
        }
      }
    };
    window.addEventListener('message', onMessage);
    const timer = window.setTimeout(() => {
      if (!player.current.ready) close('YouTube did not answer in time');
    }, READY_MS);
    return () => {
      window.removeEventListener('message', onMessage);
      window.clearTimeout(timer);
    };
  }, [close]);

  // Once the frame has loaded, ask it for news until it answers, as YouTube's
  // own API does: the player inside may not be listening yet.
  const onLoad = useCallback(() => {
    const hello = () => {
      if (player.current.ready) return;
      frame.current?.contentWindow?.postMessage(
        JSON.stringify({ event: 'listening', id: 1, channel: 'widget' }),
        EMBED_ORIGIN
      );
      for (const name of ['onReady', 'onStateChange', 'onError']) send('addEventListener', [name]);
    };
    hello();
    const ping = window.setInterval(() => {
      if (player.current.ready) window.clearInterval(ping);
      else hello();
    }, 250);
    window.setTimeout(() => window.clearInterval(ping), READY_MS);
  }, [send]);

  // Capture phase, like the key list: the page behind must never see Back.
  // Space and the play key pause too, wherever the ring is.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Backspace' || e.key === 'BrowserBack') {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === ' ' || e.key === 'MediaPlayPause') {
        e.preventDefault();
        e.stopPropagation();
        toggle();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [close, toggle]);

  // A click in the frame gives it the keyboard; take it back at once.
  useEffect(() => {
    const onBlur = () =>
      window.setTimeout(() => {
        if (document.activeElement === frame.current) {
          frame.current?.blur();
          window.focus();
          frame.current?.parentElement?.focus();
        }
      }, 0);
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  const origin = window.location.origin;

  return (
    <FocusProvider value={focusKey}>
      <div className="shortcuts-backdrop trailer-backdrop" onClick={() => close()}>
        <div
          className="trailer"
          ref={ref}
          onClick={(e) => e.stopPropagation()}
          role="dialog"
          aria-label={`${trailer.title} · Trailer`}
        >
          <Screen onToggle={toggle} onSeek={seek}>
            <iframe
              ref={frame}
              src={embedUrl(trailer.key, origin)}
              title={`${trailer.title} · Trailer`}
              tabIndex={-1}
              allow="autoplay; encrypted-media; picture-in-picture"
              referrerPolicy="strict-origin-when-cross-origin"
              onLoad={onLoad}
            />
          </Screen>
          <FocusGroup kind="row" current={CLOSE_KEY} className="trailer-bar">
            <p className="muted trailer-keys">
              {paused ? 'Paused · ' : ''}OK pauses · ← → {SEEK_S} seconds · Back closes
            </p>
            <FocusButton className="btn-secondary" onSelect={() => void openLink(watchUrl(trailer.key))}>
              Open on YouTube ↗
            </FocusButton>
            <FocusButton focusKey={CLOSE_KEY} className="btn-primary" onSelect={() => close()}>
              Close
            </FocusButton>
          </FocusGroup>
        </div>
      </div>
    </FocusProvider>
  );
}

/**
 * The picture, as one place the ring can be: OK and the arrows go to YouTube's
 * player from here, and Down leaves for the buttons. A component of its own so
 * it registers inside the overlay (docs/GOTCHAS.md, "A control's place in the
 * engine's tree is where its hook runs").
 */
function Screen({
  onToggle,
  onSeek,
  children,
}: {
  onToggle: () => void;
  onSeek: (by: number) => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const { focused, props } = useNavLeaf(SCREEN_KEY, ref, {
    on: true,
    onSelect: onToggle,
    // Left and Right seek, Up stays; Down leaves for the buttons.
    onArrow: (arrow) => {
      if (arrow === 'left' || arrow === 'right') onSeek(arrow === 'left' ? -SEEK_S : SEEK_S);
      return arrow !== 'down';
    },
  });
  return (
    <div
      ref={ref}
      {...props}
      className={`trailer-screen ${focused ? 'focused' : ''}`.trim()}
    >
      {children}
    </div>
  );
}
