import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string, scheme = 'asset') => `${scheme}://localhost/${path}`,
}));

import Art from './Art';
import detailSource from './TitleDetail.tsx?raw';
import homeSource from './Home.tsx?raw';

function screen(): void {
  vi.stubGlobal('window', { innerWidth: 3840, devicePixelRatio: 2 });
  vi.stubGlobal('getComputedStyle', () => ({ fontSize: '32px' }));
  vi.stubGlobal('document', { documentElement: {} });
}

afterEach(() => vi.unstubAllGlobals());

describe('a picture that is the point of a page (A6-08)', () => {
  it('is asked for as a screen-sized thumb, never as the original', () => {
    screen();
    const backdrop = renderToStaticMarkup(
      <Art local="C:\data\artwork\local-7.jpg" remote={null} screenRem="window" />,
    );
    expect(backdrop).toContain('thumb://localhost/local-7.jpg?w=1920');
    expect(backdrop).not.toContain('asset');
    const poster = renderToStaticMarkup(
      <Art local="/data/artwork/local-7.jpg" remote={null} screenRem={11.875} />,
    );
    expect(poster).toContain('?w=960');
  });

  it('falls to the drawn picture, not the original, when no copy can be made', () => {
    screen();
    // The copy failed (too big to shrink): nothing else is a source but remote.
    const html = renderToStaticMarkup(
      <Art local="/data/artwork/9.jpg" remote="https://image.example/p.jpg" screenRem="window" />,
    );
    expect(html).not.toContain('asset://');
  });

  it('is asked for by the title page (backdrop, poster) and Home (big picture)', () => {
    const uses = (source: string, cls: string) => new RegExp('className="' + cls + '"\\s+screenRem=').test(source);
    expect(uses(detailSource, 'detail-backdrop')).toBe(true);
    expect(uses(detailSource, 'detail-poster')).toBe(true);
    expect(uses(homeSource, 'hero-backdrop')).toBe(true);
  });
});
