/**
 * Language codes, as files and Windows spell them, reduced to one form.
 *
 * A release tags its tracks `eng`, `nor`, `nob`, `ger` or `deu`; Windows says
 * `nb-NO`. Matching those as strings is how a Norwegian preference missed a
 * track tagged `nor`. `Intl.Locale` already knows every alias — ISO 639-2 in
 * both its forms, three letters to two — so it does the reducing, and
 * `Intl.DisplayNames` the naming.
 */

/** Tags that say "no particular language" rather than naming one. */
const NOT_A_LANGUAGE = new Set(['und', 'zxx', 'mis', 'mul']);

/**
 * Norwegian is one language to a viewer however it is tagged: `nor`, `no`,
 * Bokmål `nob`/`nb` or Nynorsk `nno`/`nn`. Without this a Windows set to
 * Bokmål would never match the far more common `nor`.
 */
const SAME_LANGUAGE: Record<string, string> = { nb: 'no', nn: 'no' };

/** `eng` → `en`, `ger` → `de`, `nb-NO` → `no`; null for anything unusable. */
export function canonicalLang(code: string | null | undefined): string | null {
  if (!code) return null;
  const trimmed = code.trim();
  if (!trimmed) return null;
  let language: string;
  try {
    language = new Intl.Locale(trimmed).language.toLowerCase();
  } catch {
    return null;
  }
  // ISO 639-2 reserves qaa–qtz for local use.
  if (NOT_A_LANGUAGE.has(language) || /^q[a-t][a-z]$/.test(language)) return null;
  return SAME_LANGUAGE[language] ?? language;
}

let names: Intl.DisplayNames | null = null;

/** "English", "Norwegian" — in English, like the rest of the interface. */
export function languageName(code: string | null | undefined): string | null {
  const lang = canonicalLang(code);
  if (!lang) return null;
  try {
    names ??= new Intl.DisplayNames(['en'], { type: 'language' });
    const name = names.of(lang);
    return name && name !== lang ? name : lang.toUpperCase();
  } catch {
    return lang.toUpperCase();
  }
}

export function sameLanguage(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = canonicalLang(a);
  return x !== null && x === canonicalLang(b);
}

/** The language Windows is set to, reduced the same way. */
export function systemLanguage(): string {
  const lang = typeof navigator === 'undefined' ? null : canonicalLang(navigator.language);
  return lang ?? 'en';
}
