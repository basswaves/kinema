/**
 * Settings → Playback → Opening videos: offering Kinema to Windows as a video
 * player (default_player.rs), and taking the offer back.
 *
 * Windows does not let a program make itself the default; the offer puts
 * Kinema in each video type's "Open with" and in Default apps, and opens
 * Kinema's page there for the choice. Only where the system has that
 * (`offers_player`).
 */
import { useEffect, useState } from 'react';
import ConfirmButton from './ConfirmButton';
import FocusButton from './FocusButton';
import { userError } from './errors';
import { offerAsPlayer, openDefaultApps, playerOffer, removeAsPlayer } from './api';

export default function VideoPlayerSection() {
  const [offered, setOffered] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    playerOffer()
      .then((answer) => live && setOffered(answer.offered))
      .catch((e: unknown) => live && setError(userError(e)));
    return () => {
      live = false;
    };
  }, []);

  const run = (action: () => Promise<void>) => {
    setError(null);
    action()
      .then(playerOffer)
      .then((answer) => setOffered(answer.offered))
      .catch((e: unknown) => setError(userError(e)));
  };

  return (
    <section className="settings-section">
      <h2>Opening videos</h2>
      <p className="settings-intro">
        Kinema plays any video you open with it from File Explorer, or drop on its window, whether
        or not it is in your library. One in the library plays as itself; any other is remembered
        where you stopped. Started for a video, Kinema closes when the video is done.
      </p>
      {offered === null && !error ? null : offered ? (
        <>
          <div className="settings-row">
            <FocusButton
              keepInView="nearest"
              className="btn-secondary"
              onSelect={() => run(openDefaultApps)}
            >
              Choose what Kinema opens
            </FocusButton>
            <ConfirmButton
              keepInView="nearest"
              className="btn-secondary"
              confirmLabel="Yes, remove Kinema"
              onConfirm={() => run(removeAsPlayer)}
            >
              Remove
            </ConfirmButton>
          </div>
          <p className="settings-hint">
            Kinema is in Open with for video files, and in Windows&rsquo; Default apps, where you
            choose which kinds of video it opens. Remove takes it out of both again.
          </p>
        </>
      ) : (
        <>
          <div className="settings-row">
            <FocusButton
              keepInView="nearest"
              className="btn-secondary"
              onSelect={() => run(offerAsPlayer)}
            >
              Offer Kinema as a video player
            </FocusButton>
          </div>
          <p className="settings-hint">
            Puts Kinema in Open with for video files and opens Windows&rsquo; Default apps, where
            you choose which kinds of video Kinema opens. Windows does not let a program choose
            that for itself.
          </p>
        </>
      )}
      {error && <p className="settings-error">{error}</p>}
    </section>
  );
}
