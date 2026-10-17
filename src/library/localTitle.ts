/**
 * The name and year a person types for a title kept without a match
 * (local_title.rs). Checked here too, so a typo is said beside the field
 * rather than coming back as an error from the database.
 */

export interface LocalName {
  name: string;
  year: number | null;
}

/**
 * The typed name and year, or a sentence saying what is wrong with them. An
 * empty year is no year; anything else has to be one.
 */
export function readLocalName(name: string, year: string): LocalName | string {
  const cleaned = name.trim();
  if (!cleaned) return 'A title needs a name.';
  const typed = year.trim();
  if (!typed) return { name: cleaned, year: null };
  if (!/^\d{4}$/.test(typed)) return `${typed} does not look like a year.`;
  const value = Number(typed);
  if (value < 1870 || value > 2200) return `${typed} does not look like a year.`;
  return { name: cleaned, year: value };
}

/** Where a kept title is found, for the line saying it was added. */
export const shelfOf = (isSeries: boolean) => (isSeries ? 'TV shows' : 'Movies');
