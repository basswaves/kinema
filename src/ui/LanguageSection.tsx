/**
 * Settings → the languages a new title opens with.
 *
 * A preference about the viewer, not taste in picture — the settings rule is
 * about the second. Offered in Windows' own language and English, which covers
 * the choice for nearly everyone without a list of two hundred languages.
 */
import { useEffect, useState } from 'react';
import { getSetting, setSetting } from '../metadata/api';
import { languageName, systemLanguage } from '../player/language';
import {
  AUDIO_DEFAULT_KEY,
  defaultSubs,
  SUBS_DEFAULT_KEY,
} from '../player/trackChoice';
import ChoiceRow, { type Choice } from './ChoiceRow';
import { userError } from './errors';

function dedupe<V extends string>(choices: Choice<V>[]): Choice<V>[] {
  return choices.filter((c, i) => choices.findIndex((d) => d.value === c.value) === i);
}

export default function LanguageSection({ onError }: { onError: (message: string) => void }) {
  const own = systemLanguage();
  const languages = own === 'en' ? ['en'] : [own, 'en'];
  const name = (code: string) => languageName(code) ?? code;

  const [audio, setAudio] = useState('original');
  const [subs, setSubs] = useState(defaultSubs());

  useEffect(() => {
    let live = true;
    void Promise.all([getSetting(AUDIO_DEFAULT_KEY), getSetting(SUBS_DEFAULT_KEY)])
      .then(([a, s]) => {
        if (!live) return;
        if (a) setAudio(a);
        if (s) setSubs(s);
      })
      .catch((e) => onError(userError(e)));
    return () => {
      live = false;
    };
  }, [onError]);

  const save = (key: string, value: string, set: (v: string) => void) => {
    set(value);
    void setSetting(key, value).catch((e) => onError(userError(e)));
  };

  const audioChoices = dedupe([
    { value: 'original', label: 'As the file sets it' },
    ...languages.map((code) => ({ value: code, label: name(code) })),
  ]);

  const subChoices = dedupe([
    { value: 'off', label: 'Off' },
    ...languages.flatMap((code) => [
      { value: `foreign:${code}`, label: `${name(code)} when needed` },
      { value: `always:${code}`, label: `${name(code)} always` },
    ]),
  ]);

  return (
    <>
      <ChoiceRow
        label="Audio language"
        choices={audioChoices}
        value={audio}
        onChange={(v) => save(AUDIO_DEFAULT_KEY, v, setAudio)}
        note="The language a movie or show starts in. As the file sets it is nearly always the original language."
      />
      <ChoiceRow
        label="Subtitles"
        choices={subChoices}
        value={subs}
        onChange={(v) => save(SUBS_DEFAULT_KEY, v, setSubs)}
        note="When needed turns subtitles on when the audio is in another language. Otherwise it shows only forced subtitles, the ones for signs and lines in a foreign language."
        hint="If you change the audio or subtitles while watching a show, Kinema remembers that for the show, and it wins over these."
      />
    </>
  );
}
