import { describe, expect, it } from 'vitest';
import { countdown, qrSource } from './tracking';

describe('countdown', () => {
  it('shows minutes and seconds left on the code', () => {
    expect(countdown(900)).toBe('15:00');
    expect(countdown(61.9)).toBe('1:01');
    expect(countdown(5)).toBe('0:05');
  });

  it('never counts below zero', () => {
    expect(countdown(-3)).toBe('0:00');
  });
});

describe('qrSource', () => {
  /** An image source, never markup put into the page. */
  it('turns the QR code into a data URL', () => {
    const src = qrSource('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h1"/></svg>');
    expect(src?.startsWith('data:image/svg+xml;charset=utf-8,')).toBe(true);
    expect(src).not.toContain('<');
  });

  it('is nothing when there is no QR code', () => {
    expect(qrSource(null)).toBeNull();
  });
});
