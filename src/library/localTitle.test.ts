import { describe, expect, it } from 'vitest';
import { readLocalName, shelfOf } from './localTitle';

describe('readLocalName', () => {
  it('trims the name and reads a four-digit year', () => {
    expect(readLocalName('  Our Holiday ', ' 2019 ')).toEqual({ name: 'Our Holiday', year: 2019 });
  });

  it('takes an empty year as none', () => {
    expect(readLocalName('Our Holiday', '')).toEqual({ name: 'Our Holiday', year: null });
  });

  it('says what is wrong instead of guessing', () => {
    expect(readLocalName('   ', '2019')).toBe('A title needs a name.');
    expect(readLocalName('Film', '19')).toBe('19 does not look like a year.');
    expect(readLocalName('Film', '20x9')).toBe('20x9 does not look like a year.');
    expect(readLocalName('Film', '1200')).toBe('1200 does not look like a year.');
  });
});

describe('shelfOf', () => {
  it('names the screen the title is found on', () => {
    expect(shelfOf(true)).toBe('TV shows');
    expect(shelfOf(false)).toBe('Movies');
  });
});
