/**
 * Settings → Privacy: "What leaves your computer".
 *
 * The words are in `src/trust/whatLeaves.json`, written once so the website
 * can say the same; a test keeps that list in step with every host the code
 * contacts. This adds only what the page knows live: whether each switchable
 * service is in use now, and a button to the setting that stops it (owner,
 * 2026-10-23: one place for each switch, never a second copy here).
 */
import { useEffect, useState } from 'react';
import page from '../trust/whatLeaves.json';
import FocusButton from './FocusButton';
import FocusGroup from './FocusGroup';
import { getSetting } from '../metadata/api';
import { accountApi } from '../metadata/tracking';
import { subtitleStatus } from '../player/onlineSubtitles';
import { INTRODB_APP_ENABLED_KEY, INTRODB_ENABLED_KEY } from '../library/api';
import { UPDATE_CHECK_KEY } from './updates';
import { useCapabilities, type Capabilities } from '../capabilities';

type Service = (typeof page.services)[number] & {
  section?: string;
  state?: string;
  only?: string;
};

/** Each switchable service's state now: on, off, or not known yet. */
type States = Record<string, boolean>;

async function readStates(): Promise<States> {
  const on = (key: string) => getSetting(key).then((v) => v !== 'off').catch(() => null);
  const [omdb, introDb, introDbApp, updates, subtitles, simkl, trakt] = await Promise.all([
    getSetting('omdb_api_key').then((v) => Boolean(v?.trim())).catch(() => null),
    on(INTRODB_ENABLED_KEY),
    on(INTRODB_APP_ENABLED_KEY),
    on(UPDATE_CHECK_KEY),
    subtitleStatus().then((s) => s.auto_forced).catch(() => null),
    accountApi('simkl').status().then((s) => s.connected).catch(() => null),
    accountApi('trakt').status().then((s) => s.connected).catch(() => null),
  ]);
  const states: Record<string, boolean | null> = {
    omdb,
    theintrodb: introDb,
    introdb_app: introDbApp,
    updates,
    opensubtitles: subtitles,
    simkl,
    trakt,
  };
  return Object.fromEntries(
    Object.entries(states).filter((e): e is [string, boolean] => e[1] !== null)
  );
}

/** What the state says, in the service's own terms. */
function stateWords(state: string, on: boolean): string {
  if (state === 'opensubtitles') return on ? 'Forced subtitles: on' : 'Only when you ask';
  if (state === 'simkl' || state === 'trakt') return on ? 'Connected' : 'Not connected';
  if (state === 'omdb') return on ? 'In use: a key is set' : 'Off: no key';
  return on ? 'On' : 'Off';
}

export default function WhatLeavesSection({
  sectionNames,
  onGo,
}: {
  /** The Settings sections a button can go to, by id, with their names. */
  sectionNames: Record<string, string>;
  onGo: (section: string) => void;
}) {
  const can = useCapabilities();
  const [states, setStates] = useState<States>({});
  useEffect(() => {
    let live = true;
    void readStates().then((s) => live && setStates(s));
    return () => {
      live = false;
    };
  }, []);

  const services = (page.services as Service[]).filter(
    (s) => !s.only || can?.[s.only as keyof Capabilities]
  );

  return (
    <section className="settings-section what-leaves">
      <h2>{page.title}</h2>
      <p className="settings-intro">{page.intro}</p>
      {/* Above the list, not after it: past the last button a remote has
          nothing to land on that would scroll them into view. */}
      <p className="settings-intro">{page.local}</p>
      <p className="settings-intro">{page.links.intro}</p>
      <p className="muted what-leaves-hosts">
        {page.links.hosts.map((l) => `${l.host} (${l.for})`).join(' · ')}
      </p>
      <ul className="what-leaves-list">
        {services.map((s) => (
          <li key={s.id}>
            <div className="what-leaves-head">
              <strong>{s.name}</strong>
              {s.state && s.state in states && (
                <span className={`what-leaves-state ${states[s.state] ? 'on' : 'off'}`}>
                  {stateWords(s.state, states[s.state])}
                </span>
              )}
            </div>
            <dl>
              <dt>Sends</dt>
              <dd>{s.sends}</dd>
              <dt>When</dt>
              <dd>{s.when}</dd>
              <dt>Stops it</dt>
              <dd>{s.stop}</dd>
            </dl>
            {s.hosts.length > 0 && <p className="muted what-leaves-hosts">{s.hosts.join(' · ')}</p>}
            {s.section && sectionNames[s.section] && (
              <FocusGroup kind="row" className="settings-row">
                <FocusButton
                  className="btn-secondary"
                  label={`Go to ${sectionNames[s.section]}, for ${s.name}`}
                  onSelect={() => onGo(s.section!)}
                >
                  Go to {sectionNames[s.section]}
                </FocusButton>
              </FocusGroup>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
