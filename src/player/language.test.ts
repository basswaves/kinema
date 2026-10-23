import { describe, expect, it } from 'vitest';
import { languageBadge } from './language';

describe('languageBadge', () => {
  it('is the two-letter code, however the file spells the language', () => {
    expect(languageBadge('eng')).toBe('EN');
    expect(languageBadge('ger')).toBe('DE');
    expect(languageBadge('nob')).toBe('NO');
    expect(languageBadge('nor')).toBe('NO');
  });

  it('adds the region only where the file states one that says something', () => {
    expect(languageBadge('pt-BR')).toBe('PT-BR');
    expect(languageBadge('en-us')).toBe('EN-US');
    expect(languageBadge('de-DE')).toBe('DE');
  });

  it('is nothing for a track with no language', () => {
    expect(languageBadge(null)).toBeNull();
    expect(languageBadge('')).toBeNull();
    expect(languageBadge('und')).toBeNull();
    expect(languageBadge('qaa')).toBeNull();
  });
});
