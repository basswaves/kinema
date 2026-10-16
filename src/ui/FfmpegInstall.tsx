/**
 * The one-press ffmpeg install, as the three places that offer it show it
 * (ExtrasSetup.tsx, HomeNotices.tsx, Settings.tsx): a button and a line of
 * what is happening. The state is shared (ffmpegInstallState.ts), so whichever
 * place pressed it, each shows the same install.
 *
 * Two pieces rather than one block, because Home's notices keep their words
 * and their buttons in separate columns.
 *
 * Where Kinema cannot install it (not Windows), or winget turned out to be
 * missing, the button is the link to ffmpeg's download page, as it always
 * was — under the same focus key, so a remote's focus stays where it was.
 *
 * Also here: what an ffmpeg that *was* found cannot decode (`FfmpegLacks`),
 * shown in the same two places as its status.
 */
import { useEffect, useState } from 'react';
import FocusButton from './FocusButton';
import { openLink } from './links';
import { useCapabilities } from '../capabilities';
import { ffmpegLacks } from '../library/api';
import { ffmpegLacksWords } from './ffmpegNotice';
import {
  FFMPEG_DOWNLOAD_URL,
  ffmpegInstalled,
  startFfmpegInstall,
  useFfmpegInstall,
} from './ffmpegInstallState';

interface ButtonProps {
  focusKey?: string;
  className?: string;
}

/** "Install ffmpeg", or the download page where it cannot be installed from here. */
export function FfmpegInstallButton({ focusKey, className = 'btn-primary' }: ButtonProps) {
  const can = useCapabilities();
  const install = useFfmpegInstall();
  const noWinget = install.report?.outcome === 'no_winget';
  if (!can?.installs_ffmpeg || noWinget) {
    return (
      <FocusButton
        focusKey={focusKey}
        className={noWinget ? className : 'btn-secondary'}
        keepInView="nearest"
        onSelect={() => void openLink(FFMPEG_DOWNLOAD_URL)}
      >
        Open the ffmpeg download page ↗
      </FocusButton>
    );
  }
  const failed = Boolean(install.error) || install.report?.outcome === 'failed';
  return (
    // Never disabled while it runs: a disabled button leaves the focus tree,
    // and a remote's focus would jump somewhere else mid-install.
    <FocusButton
      focusKey={focusKey}
      className={className}
      keepInView="nearest"
      onSelect={() => void startFfmpegInstall()}
    >
      {install.running ? 'Installing…' : failed ? 'Try again' : 'Install ffmpeg'}
    </FocusButton>
  );
}

/** What the install is doing, or how it ended. Nothing before a press. */
export function FfmpegInstallStatus() {
  const install = useFfmpegInstall();
  const { report } = install;
  if (install.running) {
    return (
      <p className="settings-hint" role="status" aria-live="polite">
        {install.line ?? 'Installing'}…
      </p>
    );
  }
  if (install.error) {
    return (
      <p className="settings-warn" role="status">
        Could not install ffmpeg: {install.error}
      </p>
    );
  }
  if (!report) return null;
  if (ffmpegInstalled(report)) {
    return (
      <p className="settings-ok" role="status">
        ffmpeg is installed. Kinema is reading your files with it in the background.
      </p>
    );
  }
  if (report.outcome === 'no_winget') {
    return (
      <p className="settings-warn" role="status">
        Windows’ app installer (winget) is not on this computer, so Kinema cannot install ffmpeg
        for you. Its download page has it for Windows; Kinema finds it once it is installed.
      </p>
    );
  }
  return (
    <div className="ffmpeg-install-failed" role="status">
      <p className="settings-warn">
        Could not install ffmpeg. {report.reason ?? ''} The details are in Kinema&rsquo;s log.
      </p>
      {report.tail.length > 0 && (
        <pre className="ffmpeg-install-tail">{report.tail.slice(-4).join('\n')}</pre>
      )}
      {/* The way it was always added still works, and a failure that keeps
          failing must not leave Try again as the only way on. */}
      <div className="settings-row">
        <FocusButton
          className="btn-secondary"
          keepInView="nearest"
          onSelect={() => void openLink(FFMPEG_DOWNLOAD_URL)}
        >
          Open the ffmpeg download page ↗
        </FocusButton>
      </div>
    </div>
  );
}

/**
 * Beside "Found ffmpeg at …": the formats this one cannot decode and what
 * that costs (Fedora's ffmpeg-free, for one), or nothing. Asked once each
 * time the ffmpeg in use changes.
 */
export function FfmpegLacks({ resolved }: { resolved: string | null }) {
  const [lacks, setLacks] = useState<{ for: string; words: string | null } | null>(null);
  useEffect(() => {
    if (resolved === null) return;
    let live = true;
    void ffmpegLacks(resolved === 'ffmpeg' ? '' : resolved)
      .then((found) => live && setLacks({ for: resolved, words: ffmpegLacksWords(found) }))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [resolved]);
  // An answer about another ffmpeg than the one now in use says nothing.
  if (!lacks?.words || lacks.for !== resolved) return null;
  return <p className="settings-warn">{lacks.words}</p>;
}
