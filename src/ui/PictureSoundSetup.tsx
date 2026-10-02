/**
 * The first run's picture-and-sound step (agreed 2026-10-02).
 *
 * Kinema can send a film's sound to a receiver untouched, match the screen
 * to the film's frame rate and turn HDR on for an HDR film — each only where
 * the equipment can. The Home notice used to be the only place that said so,
 * and only once the equipment was there; this says it up front, whatever is
 * connected now, so a PC set up at a desk already knows what to do at the
 * home cinema.
 *
 * Each item says what it gives and what it costs in a line each, and asks one
 * of three answers (`devicePolicy.ts`): every device that can, only this
 * setup (named), or off. Nothing is chosen for the person, and nothing is
 * saved until they choose: skipping leaves Kinema as it was, with screen
 * switching off. Only what this system can do is asked (capabilities.ts).
 *
 * An answer is stored as the setting itself, so Settings → Picture & sound
 * shows it, and the Home notice knows the question has been answered
 * (`qualityNotice.ts`).
 *
 * One of the setup pages shown while the first scan runs (`SetupPages.tsx`),
 * which gives it its heading and its Skip.
 */
import { useEffect, useState } from 'react';
import { getSetting } from '../metadata/api';
import { useCapabilities } from '../capabilities';
import { AUDIO_DIRECT_KEY } from '../player/audioOutput';
import { savePolicy, type Policy } from '../player/devicePolicy';
import { SWITCH_HDR_KEY, SWITCH_REFRESH_KEY } from '../player/displaySwitch';
import { getEquipment, type Equipment } from '../player/equipment';
import ChoiceRow from './ChoiceRow';
import { hdrOptions, refreshOptions, soundOptions } from './deviceOptions';
import type { DeviceOption } from './DeviceChoice';
import { userError } from './errors';

interface Item {
  key: string;
  title: string;
  gives: string;
  costs: string;
  allLabel: string;
  options: (e: Equipment | null) => DeviceOption[];
}

function items(system: string, sound: boolean, screen: boolean): Item[] {
  const all: (Item | false)[] = [
    sound && {
      key: AUDIO_DIRECT_KEY,
      title: 'Sound straight to the receiver',
      gives: 'Dolby Atmos, DTS:X and lossless sound reach the receiver exactly as they are on the disc.',
      costs: "While a film plays, the PC's other sounds are silent, and the volume is the receiver's.",
      allLabel: 'Every receiver',
      options: soundOptions,
    },
    screen && {
      key: SWITCH_REFRESH_KEY,
      title: 'Match the screen to the film',
      gives: 'Camera pans glide instead of stuttering: the screen runs at the film’s own 24 frames a second.',
      costs: 'The screen goes black for a second or two as a film starts and after it ends. Only in full screen.',
      allLabel: 'Every screen that can',
      options: refreshOptions,
    },
    screen && {
      key: SWITCH_HDR_KEY,
      title: 'Turn HDR on for HDR films',
      gives: `HDR films keep their brightness and colour on a screen that has HDR switched off in ${system}.`,
      costs: 'The screen goes black for a moment while HDR switches on, and again when it goes back off.',
      allLabel: 'Every screen that can',
      options: hdrOptions,
    },
  ];
  return all.filter((i): i is Item => Boolean(i));
}

type Answer = Policy | '';

export default function PictureSoundSetup({ onAnswer }: { onAnswer: () => void }) {
  const can = useCapabilities();
  const [equipment, setEquipment] = useState<Equipment | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [error, setError] = useState<string | null>(null);

  const asked = can ? items(can.system, can.audio_direct, can.display_switching) : [];
  const keys = asked.map((i) => i.key).join(',');

  useEffect(() => {
    let live = true;
    void getEquipment()
      .then((e) => live && setEquipment(e))
      .catch(() => undefined);
    // An answer given before — in Settings, or here on a second first run
    // after every folder was removed — is shown as given.
    void Promise.all(keys.split(',').filter(Boolean).map(async (k) => [k, await getSetting(k)] as const))
      .then((stored) => {
        if (!live) return;
        const given: Record<string, Answer> = {};
        for (const [k, v] of stored) {
          given[k] = v === 'on' ? 'all' : v === 'these' ? 'these' : v === 'off' ? 'off' : '';
        }
        setAnswers(given);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [keys]);

  if (asked.length === 0) return null;

  const choose = (item: Item, policy: Policy) => {
    const here = item.options(equipment).filter((d) => d.connected && d.able).map((d) => d.id);
    setAnswers((a) => ({ ...a, [item.key]: policy }));
    setError(null);
    onAnswer();
    void savePolicy(item.key, { policy, devices: policy === 'these' ? here : [] }).catch((e) =>
      setError(userError(e))
    );
  };

  return (
    <>
      <p className="muted">
        Kinema can get the most out of a TV and an AV receiver, now or whenever this PC is
        connected to one. Choose for each, or skip this: everything then stays as it is, and all
        of it is in Settings → Picture &amp; sound at any time.
      </p>
      {error && <div className="settings-error">{error}</div>}

      {asked.map((item) => {
        const here = item.options(equipment).filter((d) => d.connected && d.able);
        const choices: { value: Answer; label: string }[] = [
          { value: 'all', label: item.allLabel },
          ...(here.length > 0
            ? [{ value: 'these' as const, label: `Only ${here.map((d) => d.name).join(' and ')}` }]
            : []),
          { value: 'off', label: 'Off' },
        ];
        return (
          <ChoiceRow<Answer>
            key={item.key}
            label={item.title}
            choices={choices}
            value={answers[item.key] ?? ''}
            onChange={(v) => v && choose(item, v)}
            note={item.gives}
            hint={
              here.length > 0
                ? item.costs
                : `${item.costs} Nothing connected now can; with the first choice, Kinema uses it when something that can is connected.`
            }
          />
        );
      })}
    </>
  );
}
