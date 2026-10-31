/**
 * The movement rules, without a browser: every rule of focusModel.ts, the
 * owner's agreed moves on Home and the shelves (notes NAV-MAP.md), and each
 * entry of docs/GOTCHAS.md "Spatial navigation (D-pad)" that applies to Home,
 * rails and grids, as the case the new engine must give by construction.
 */
import { describe, expect, it } from 'vitest';
import {
  canHold,
  enter,
  move,
  recover,
  remembered,
  scrollAnchor,
  tabMove,
  tabStops,
  type AreaSpec,
  type Arrow,
  type NavNode,
} from './focusModel';

/** An area in the test's shorthand: its rules and its children. */
interface A {
  area: AreaSpec;
  disabled?: boolean;
  children: (string | [string, A] | { key: string; disabled: true })[];
}

function build(root: A): Map<string, NavNode> {
  const tree = new Map<string, NavNode>();
  const add = (key: string, parent: string | null, a: A) => {
    const children: string[] = [];
    for (const c of a.children) {
      if (typeof c === 'string') {
        tree.set(c, { key: c, parent: key, children: [] });
        children.push(c);
      } else if (Array.isArray(c)) {
        add(c[0], key, c[1]);
        children.push(c[0]);
      } else {
        tree.set(c.key, { key: c.key, parent: key, children: [], disabled: true });
        children.push(c.key);
      }
    }
    tree.set(key, { key, parent, children, area: a.area, disabled: a.disabled });
  };
  add('root', null, root);
  return tree;
}

const row = (children: A['children'], extra: Partial<AreaSpec> = {}): A => ({
  area: { kind: 'row', ...extra },
  children,
});
const rail = (children: A['children']): A => row(children, { remember: true });
const column = (children: A['children'], extra: Partial<AreaSpec> = {}): A => ({
  area: { kind: 'column', ...extra },
  children,
});

/** Home as Kinema builds it: the top bar, then the page. */
function home(notices = true) {
  return build(
    column([
      ['top', row(['nav:home', 'nav:movies', 'nav:tv', 'nav:search', 'nav:settings', 'nav:help'], { current: 'nav:home' })],
      [
        'home',
        column([
          ['hero', row(['play', 'info', 'something'], { current: 'play' })],
          ['notices', notices ? column([['n1', row(['n1-ok'])], ['n2', row(['n2-a', 'n2-b'])]]) : { area: { kind: 'column' }, disabled: true, children: [] }],
          [
            'continue',
            rail([
              ['c1', column(['c1-body', 'c1-remove'], { current: 'c1-body' })],
              ['c2', column(['c2-body', 'c2-remove'], { current: 'c2-body' })],
            ]),
          ],
          ['mylist', { area: { kind: 'row', remember: true }, disabled: true, children: [] }],
          ['recent', rail(['r1', 'r2', 'r3', 'r4', 'r5', 'r-all'])],
          ['tv', rail(['t1', 't2', 't3'])],
        ]),
      ],
    ])
  );
}

/** Press keys in turn from `start`, remembering as the store does. */
function walk(tree: Map<string, NavNode>, start: string, keys: Arrow[], memory = new Map<string, string>()) {
  const record = (key: string) => {
    for (const [area, child] of remembered(tree, key)) memory.set(area, child);
  };
  record(start);
  let at = start;
  for (const key of keys) {
    const next = move(tree, at, key, memory);
    if (next) {
      at = next;
      record(at);
    }
  }
  return at;
}

const none = new Map<string, string>();

describe('Home (NAV-MAP, agreed 2026-10-11)', () => {
  const tree = home();

  it('Down from any top-bar button is Play', () => {
    for (const b of ['nav:home', 'nav:settings', 'nav:help']) expect(move(tree, b, 'down', none)).toBe('play');
  });

  it('Up from any hero button is the open section, not the nearest button', () => {
    for (const b of ['play', 'info', 'something']) expect(move(tree, b, 'up', none)).toBe('nav:home');
  });

  it('a row lands on its current item, never on the one last left', () => {
    expect(walk(tree, 'something', ['down', 'up'])).toBe('play');
  });

  it('Left and Right move along the top bar and stop at its ends', () => {
    expect(move(tree, 'nav:home', 'right', none)).toBe('nav:movies');
    expect(move(tree, 'nav:help', 'right', none)).toBeNull();
    expect(move(tree, 'nav:home', 'left', none)).toBeNull();
  });

  it('notices: Down from the hero is the first, Up from below is the last, Up from the first is Play', () => {
    expect(move(tree, 'info', 'down', none)).toBe('n1-ok');
    expect(move(tree, 'c1-body', 'up', none)).toBe('n2-a');
    expect(move(tree, 'n1-ok', 'up', none)).toBe('play');
    expect(move(tree, 'n2-a', 'right', none)).toBe('n2-b');
    expect(move(tree, 'n2-b', 'up', none)).toBe('n1-ok');
  });

  it('without notices, Down from the hero is the first rail', () => {
    expect(move(home(false), 'play', 'down', none)).toBe('c1-body');
  });

  it('rails: up or down lands on the card last on in that rail, the first one the first time', () => {
    const memory = new Map<string, string>();
    expect(walk(tree, 'r3', ['down'], memory)).toBe('t1');
    expect(walk(tree, 't1', ['right', 'up'], memory)).toBe('r3');
    expect(walk(tree, 'r3', ['down'], memory)).toBe('t2');
  });

  it("neighbours only: Right from a rail's end is nothing, not the nearest card a row lower", () => {
    expect(move(tree, 'r-all', 'right', none)).toBeNull();
    expect(move(tree, 't3', 'right', none)).toBeNull();
    expect(move(tree, 'r1', 'left', none)).toBeNull();
  });

  it('Continue: arriving lands on the card, never on Remove; Down reaches Remove', () => {
    expect(move(tree, 'n2-a', 'down', none)).toBe('c1-body');
    expect(move(tree, 'c1-body', 'down', none)).toBe('c1-remove');
    expect(move(tree, 'c1-remove', 'right', none)).toBe('c2-body');
    expect(move(tree, 'c1-remove', 'up', none)).toBe('c1-body');
  });

  it('an empty rail is passed over (GOTCHAS: a container that renders nothing is still a place to move to)', () => {
    expect(move(tree, 'c2-remove', 'down', none)).toBe('r1');
    expect(move(tree, 'r2', 'up', none)).toBe('c1-body');
  });

  it('a press nothing answers goes nowhere, not anywhere (GOTCHAS)', () => {
    expect(move(tree, 'play', 'left', none)).toBeNull();
    expect(move(tree, 'nav:home', 'up', none)).toBeNull();
    expect(move(tree, 't2', 'down', none)).toBeNull();
  });

  it('a held key: every press is one move, and the walk ends at the end', () => {
    expect(walk(tree, 'r1', Array<Arrow>(100).fill('right'))).toBe('r-all');
    expect(walk(tree, 'nav:home', Array<Arrow>(100).fill('down'))).toBe('t1');
    expect(walk(tree, 't1', Array<Arrow>(100).fill('up'))).toBe('nav:home');
  });
});

describe('the Movies / TV shows shelf', () => {
  // Ten cards four wide:  g0 g1 g2 g3 / g4 g5 g6 g7 / g8 g9
  const cards = Array.from({ length: 10 }, (_, i) => `g${i}`);
  const tree = build(
    column([
      ['top', row(['nav:home', 'nav:movies', 'nav:tv'], { current: 'nav:movies' })],
      [
        'shelf',
        column([
          ['head', row(['something', 'collection'])],
          ['order', row(['sort:added', 'sort:title', 'sort:year', 'unwatched'], { current: 'sort:title' })],
          ['cards', { area: { kind: 'grid', columns: 4, current: 'g0' }, children: cards }],
        ]),
      ],
    ])
  );

  it('Down from any order button is the first film', () => {
    for (const b of ['sort:added', 'sort:year', 'unwatched']) expect(move(tree, b, 'down', none)).toBe('g0');
  });

  it('Up from the first row is the order in use', () => {
    for (const c of ['g0', 'g2', 'g3']) expect(move(tree, c, 'up', none)).toBe('sort:title');
  });

  it('moves like a grid, by index, and nothing wraps', () => {
    expect(move(tree, 'g1', 'down', none)).toBe('g5');
    expect(move(tree, 'g5', 'up', none)).toBe('g1');
    expect(move(tree, 'g3', 'right', none)).toBeNull();
    expect(move(tree, 'g4', 'left', none)).toBeNull();
    expect(move(tree, 'g6', 'down', none)).toBe('g9');
    expect(move(tree, 'g9', 'down', none)).toBeNull();
  });

  it('two buttons in a heading above the cards: Down is the order row, the same in every engine (GOTCHAS)', () => {
    expect(move(tree, 'collection', 'down', none)).toBe('sort:title');
    expect(move(tree, 'sort:added', 'up', none)).toBe('something');
  });

  it('Up from the heading row is the open section in the top bar', () => {
    expect(move(tree, 'collection', 'up', none)).toBe('nav:movies');
  });

  it('the scroll anchor is the grid on its first row (its heading in sight), else the card', () => {
    expect(scrollAnchor(tree, 'g2')).toBe('cards');
    expect(scrollAnchor(tree, 'g5')).toBe('g5');
    expect(scrollAnchor(tree, 'sort:year')).toBe('order');
  });
});

describe('rows, menus and areas', () => {
  it('a row too wide for the window goes on in reading order (GOTCHAS: a row that wraps)', () => {
    const tree = build(column([['r', row(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])]]));
    expect(walk(tree, 'a', Array<Arrow>(7).fill('right'))).toBe('h');
    expect(move(tree, 'e', 'left', none)).toBe('d');
  });

  it('a menu holds every arrow and goes round where it says', () => {
    const tree = build(
      row([
        'outside',
        ['menu', { area: { kind: 'menu' }, children: ['a', 'b', 'c'] }],
        ['menu2', { area: { kind: 'menu', wrap: 'none' }, children: ['x', 'y'] }],
      ])
    );
    expect(move(tree, 'a', 'up', none)).toBe('c');
    expect(move(tree, 'c', 'down', none)).toBe('a');
    expect(move(tree, 'b', 'left', none)).toBeNull();
    expect(move(tree, 'b', 'right', none)).toBeNull();
    expect(move(tree, 'x', 'up', none)).toBeNull();
    expect(move(tree, 'y', 'down', none)).toBeNull();
  });

  it('`hold` stops an arrow at the edge instead of leaving', () => {
    const tree = build(column([['r', row(['a', 'b'], { hold: ['up'] })], ['s', row(['c'])]]));
    expect(move(tree, 'a', 'up', none)).toBeNull();
    expect(move(tree, 'a', 'down', none)).toBe('c');
  });

  it('a disabled control is passed over, never landed on', () => {
    const tree = build(column([['r', row(['a', { key: 'b', disabled: true }, 'c'], { current: 'b' })], ['s', row(['d'])]]));
    expect(move(tree, 'a', 'right', none)).toBe('c');
    // Its row's current cannot hold the ring: the row's first instead.
    expect(move(tree, 'd', 'up', none)).toBe('a');
  });

  it('an empty area draws no ring and is nowhere to land (GOTCHAS: focusing an empty container)', () => {
    const tree = build(column([['empty', column([])], ['r', row(['a'])]]));
    expect(enter(tree, 'empty', none)).toBeNull();
    expect(canHold(tree, 'empty')).toBe(false);
    expect(enter(tree, 'root', none)).toBe('a');
  });

  it('a current inside a nested area is landed on directly', () => {
    const tree = build(column([['outer', column([['inner', row(['a', 'b'])]], { current: 'b' })]]));
    expect(enter(tree, 'outer', none)).toBe('b');
  });

  it('arriving is decided by the tree, never by stale positions (GOTCHAS: focusing a container picks its "first" child by stale positions)', () => {
    const tree = home();
    expect(enter(tree, 'recent', none)).toBe('r1');
    expect(enter(tree, 'top', none)).toBe('nav:home');
  });
});

describe('recovery when the ring’s control goes', () => {
  const tree = home();
  const path = (key: string) => {
    const out: { area: string; index: number }[] = [];
    let child = key;
    for (let p = tree.get(key)?.parent ?? null; p; p = tree.get(p)?.parent ?? null) {
      out.push({ area: p, index: tree.get(p)!.children.indexOf(child) });
      child = p;
    }
    return out;
  };
  const without = (keys: string[]) => {
    const copy = new Map(tree);
    for (const key of keys) {
      const node = copy.get(key)!;
      copy.delete(key);
      const parent = copy.get(node.parent!)!;
      copy.set(parent.key, { ...parent, children: parent.children.filter((c) => c !== key) });
    }
    return copy;
  };

  it('a card taken off its rail: the ring goes to the one sliding into its place (GOTCHAS: focus parked on an unmounted component)', () => {
    expect(recover(without(['r3']), path('r3'), none)).toBe('r4');
  });

  it('the last card: the one before it', () => {
    expect(recover(without(['r-all']), path('r-all'), none)).toBe('r5');
  });

  it("Continue's Remove takes its card: the next card, on the card itself", () => {
    expect(recover(without(['c1-remove', 'c1-body', 'c1']), path('c1-remove'), none)).toBe('c2-body');
  });

  it('a rail emptied: the next area down, or the one above when it was the last', () => {
    expect(recover(without(['t1', 't2', 't3']), path('t2'), none)).toBe('r1');
    const lastRail = without(['r1', 'r2', 'r3', 'r4', 'r5', 'r-all']);
    expect(recover(lastRail, path('r4'), none)).toBe('t1');
  });

  it('a control turned disabled under the ring: the next one (GOTCHAS)', () => {
    const copy = new Map(tree);
    copy.set('r3', { ...copy.get('r3')!, disabled: true });
    expect(recover(copy, path('r3'), none)).toBe('r4');
  });
});

describe('Tab and Shift+Tab, as on the web', () => {
  const tree = home();

  it('one stop per row, rail or grid, and each lone control', () => {
    expect(tabStops(tree, 'root')).toEqual(['top', 'hero', 'n1', 'n2', 'continue', 'recent', 'tv']);
  });

  it('Tab goes to the next stop’s landing, Shift+Tab back; past the ends is the browser’s', () => {
    expect(tabMove(tree, 'root', 'info', false, none)).toBe('n1-ok');
    expect(tabMove(tree, 'root', 'r4', true, none)).toBe('c1-body');
    expect(tabMove(tree, 'root', 't2', false, none)).toBeNull();
    expect(tabMove(tree, 'root', 'nav:tv', true, none)).toBeNull();
  });

  it('a remembered rail is tabbed back into where it was left', () => {
    const memory = new Map([['recent', 'r4']]);
    expect(tabMove(tree, 'root', 't1', true, memory)).toBe('r4');
  });
});

describe('the scroll anchor', () => {
  const tree = home();
  it('is the area within the page’s column: the rail, the hero, a notice', () => {
    expect(scrollAnchor(tree, 'r3')).toBe('recent');
    expect(scrollAnchor(tree, 'info')).toBe('hero');
    expect(scrollAnchor(tree, 'n2-b')).toBe('n2');
    expect(scrollAnchor(tree, 'c2-remove')).toBe('continue');
    expect(scrollAnchor(tree, 'nav:tv')).toBe('top');
  });
});

/** A title's page as TitleDetail.tsx builds it, under the top bar. */
function titlePage(page: A['children']) {
  return build(
    column([
      ['top', row(['nav:home', 'nav:movies', 'nav:tv'], { current: 'nav:home' })],
      ['detail', column(page)],
    ])
  );
}

/** An episode list of `n`, each a row of three that comes back to the one held. */
const episodes = (n: number): A =>
  column(
    Array.from({ length: n }, (_, i): [string, A] => [
      `e${i + 1}-row`,
      { area: { kind: 'row', remember: true }, children: [`e${i + 1}`, `w${i + 1}`, `a${i + 1}`] },
    ]),
    { remember: true, current: 'e1-row' }
  );

describe('a film’s page (NAV-MAP detail-movie)', () => {
  const actions = ['play', 'list', 'watched', 'playlist', 'poster', 'wrong'];
  const tree = titlePage(['back', ['actions', row(actions, { current: 'play' })], ['file', row(['file-details'])]]);

  it('Down from Back is Play, Up from it the open section; Back holds Left and Right', () => {
    expect(move(tree, 'back', 'down', none)).toBe('play');
    expect(move(tree, 'back', 'up', none)).toBe('nav:home');
    expect(move(tree, 'back', 'left', none)).toBeNull();
    expect(move(tree, 'back', 'right', none)).toBeNull();
  });

  it('every button under the title: Up is Back, Down the file details, along the row by Left and Right', () => {
    for (const b of actions) {
      expect(move(tree, b, 'up', none)).toBe('back');
      expect(move(tree, b, 'down', none)).toBe('file-details');
    }
    expect(walk(tree, 'play', Array<Arrow>(5).fill('right'))).toBe('wrong');
    expect(move(tree, 'wrong', 'right', none)).toBeNull();
    expect(move(tree, 'play', 'left', none)).toBeNull();
  });

  it('Up from the file details is Play, whichever button was last held (a row lands on its current)', () => {
    expect(walk(tree, 'poster', ['down', 'up'])).toBe('play');
    expect(move(tree, 'file-details', 'down', none)).toBeNull();
  });
});

describe('a series’ page of one season (NAV-MAP detail-series)', () => {
  const tree = titlePage([
    'back',
    ['actions', row(['play', 'list', 'show-watched', 'playlist', 'poster', 'wrong'], { current: 'play' })],
    ['seasons', row(['season-watched'], { passOver: ['down'] })],
    ['episodes', episodes(5)],
    ['file', row(['file-details'])],
  ]);

  it('Down from Play passes over “Mark season watched” to the first episode; Up from it reaches it', () => {
    expect(move(tree, 'play', 'down', none)).toBe('e1');
    expect(move(tree, 'wrong', 'down', none)).toBe('e1');
    expect(move(tree, 'e1', 'up', none)).toBe('season-watched');
    expect(move(tree, 'w1', 'up', none)).toBe('season-watched');
    expect(move(tree, 'season-watched', 'up', none)).toBe('play');
    expect(move(tree, 'season-watched', 'down', none)).toBe('e1');
  });

  it('an episode is a row of three: play, watched, playlist', () => {
    expect(walk(tree, 'e3', ['right', 'right'])).toBe('a3');
    expect(move(tree, 'a3', 'right', none)).toBeNull();
    expect(move(tree, 'e3', 'left', none)).toBeNull();
  });

  it('down the list lands on each episode, and back up on what was held in the row above', () => {
    expect(walk(tree, 'e1', ['down', 'down', 'down', 'down'])).toBe('e5');
    expect(walk(tree, 'e1', ['right', 'right', 'down'])).toBe('e2');
    expect(walk(tree, 'e1', ['right', 'right', 'down', 'up'])).toBe('a1');
  });

  it('the last episode: Down is the file details, and Up comes back to it', () => {
    expect(move(tree, 'e5', 'down', none)).toBe('file-details');
    expect(walk(tree, 'e4', ['down', 'down', 'up'])).toBe('e5');
    expect(walk(tree, 'e5', ['right', 'down', 'up'])).toBe('w5');
  });

  it('Up from an episode goes up area by area to the top bar', () => {
    expect(walk(tree, 'e2', ['up', 'up', 'up', 'up', 'up'])).toBe('nav:home');
  });
});

describe('a series’ page of several seasons (NAV-MAP detail-saga)', () => {
  const tree = titlePage([
    'back',
    ['actions', row(['play', 'list', 'show-watched'], { current: 'play' })],
    ['seasons', row(['s1', 's2', 'specials', 'season-watched'], { current: 's1' })],
    ['episodes', episodes(2)],
    ['file', row(['file-details'])],
  ]);

  it('Down from Play is the season shown; Up from any season is Play', () => {
    expect(move(tree, 'play', 'down', none)).toBe('s1');
    expect(move(tree, 'show-watched', 'down', none)).toBe('s1');
    for (const s of ['s1', 's2', 'specials', 'season-watched']) expect(move(tree, s, 'up', none)).toBe('play');
  });

  it('Up from the first episode is the season shown, never the nearest button', () => {
    expect(move(tree, 'e1', 'up', none)).toBe('s1');
    expect(walk(tree, 's1', ['right', 'right', 'right', 'down', 'up'])).toBe('s1');
    expect(move(tree, 'season-watched', 'left', none)).toBe('specials');
    expect(move(tree, 'season-watched', 'down', none)).toBe('e1');
  });
});

describe('an actor’s page and a collection', () => {
  const cards = ['g0', 'g1', 'g2', 'g3', 'g4'];
  const person = build(
    column([
      ['top', row(['nav:home', 'nav:movies'], { current: 'nav:home' })],
      [
        'person',
        column([
          ['head', row(['back'])],
          'imdb',
          ['grid', { area: { kind: 'grid', columns: 4, current: 'g0' }, children: cards }],
        ]),
      ],
    ])
  );

  it('the actor: Up from the first row of titles is IMDb, then Back, then the top bar', () => {
    expect(walk(person, 'g2', ['up'])).toBe('imdb');
    expect(walk(person, 'g2', ['up', 'up'])).toBe('back');
    expect(walk(person, 'g2', ['up', 'up', 'up'])).toBe('nav:home');
    expect(move(person, 'back', 'down', none)).toBe('imdb');
    expect(move(person, 'imdb', 'down', none)).toBe('g0');
  });

  const collection = build(
    column([
      ['top', row(['nav:home', 'nav:movies'], { current: 'nav:movies' })],
      [
        'collection',
        column([
          ['head', row(['back', 'save'])],
          ['traits', row(['t:4k', 't:hdr', 't:atmos'])],
          ['kind', row(['k:movie', 'k:series', 'unwatched', 'r6', 'r7', 'r8'])],
          ['grid', { area: { kind: 'grid', columns: 4, current: 'g0' }, children: cards }],
        ]),
      ],
    ])
  );

  it('a collection: rows of choices one above the other, each landing on its first', () => {
    expect(move(collection, 'save', 'down', none)).toBe('t:4k');
    expect(move(collection, 't:atmos', 'down', none)).toBe('k:movie');
    expect(move(collection, 'r8', 'down', none)).toBe('g0');
    expect(move(collection, 'g3', 'up', none)).toBe('k:movie');
    expect(walk(collection, 'back', ['right'])).toBe('save');
  });
});

describe('dialogs: the card menu, Wrong title?, the poster chooser', () => {
  const menu = (children: A['children'], extra: Partial<AreaSpec> = {}): A => ({
    area: { kind: 'menu', ...extra },
    children,
  });

  it('the card menu holds every arrow and goes round top to bottom', () => {
    const tree = build(
      column([
        ['page', column(['card'])],
        ['m', menu(['play', 'watched', 'list', 'playlist', 'open'], { current: 'play' })],
      ])
    );
    expect(enter(tree, 'm', none)).toBe('play');
    expect(move(tree, 'open', 'down', none)).toBe('play');
    expect(move(tree, 'play', 'up', none)).toBe('open');
    for (const a of ['left', 'right'] as Arrow[]) expect(move(tree, 'list', a, none)).toBeNull();
  });

  it('Wrong title?: opens on the search box; its buttons a row, the results under it, the foot a row', () => {
    const tree = build(
      column([
        ['page', column(['wrong-button'])],
        [
          'wrong',
          menu(
            [['search', row(['input', 'kind', 'search-button'])], 'this-1', 'this-2', ['foot', row(['unlink', 'cancel'])]],
            { current: 'input' }
          ),
        ],
      ])
    );
    expect(enter(tree, 'wrong', none)).toBe('input');
    expect(move(tree, 'input', 'right', none)).toBe('kind');
    expect(move(tree, 'search-button', 'down', none)).toBe('this-1');
    expect(move(tree, 'this-2', 'down', none)).toBe('unlink');
    expect(move(tree, 'unlink', 'right', none)).toBe('cancel');
    expect(move(tree, 'cancel', 'up', none)).toBe('this-2');
    expect(move(tree, 'cancel', 'down', none)).toBe('input');
    expect(move(tree, 'input', 'left', none)).toBeNull();
  });

  it('the poster chooser: one row of posters landing on the one shown now, Cancel under it', () => {
    const tree = build(
      column([['posters', menu([['choices', row(['p0', 'p1', 'p2'], { current: 'p1' })], 'cancel'])]])
    );
    expect(enter(tree, 'posters', none)).toBe('p1');
    expect(move(tree, 'p0', 'down', none)).toBe('cancel');
    expect(move(tree, 'cancel', 'up', none)).toBe('p1');
    expect(move(tree, 'p2', 'right', none)).toBeNull();
  });
});

describe('passing over an area', () => {
  it('only the arrows it names pass over it, and only on the way in', () => {
    const tree = build(column([['a', row(['a1'])], ['b', row(['b1'], { passOver: ['down'] })], ['c', row(['c1'])]]));
    expect(move(tree, 'a1', 'down', none)).toBe('c1');
    expect(move(tree, 'c1', 'up', none)).toBe('b1');
    expect(enter(tree, 'b', none)).toBe('b1');
  });
});

// ---- Settings, first run, Needs attention, playlists, search (round 7, F3) ----

/** The top bar, then a page. */
function screen(page: A) {
  return build(
    column([
      ['top', row(['nav:home', 'nav:settings'], { current: 'nav:settings' })],
      ['page', page],
    ])
  );
}

describe('Settings (NAV-MAP settings-*)', () => {
  const tree = screen(
    column([
      [
        'layout',
        row(
          [
            ['nav', column(['search-box', 'nav:library', 'nav:playback', 'nav:advanced'], { current: 'nav:library' })],
            [
              'content',
              column(
                [
                  'remove',
                  ['folders', row(['add-movies', 'add-tv', 'scan'])],
                  'review',
                  ['choice', row(['ch-a', 'ch-b', 'ch-c'], { current: 'ch-b' })],
                  'field',
                  ['pair', row(['pair-a', 'pair-b'])],
                ],
                { remember: true, current: 'add-movies' }
              ),
            ],
          ],
          { remember: true, current: 'nav' }
        ),
      ],
    ])
  );

  it('Down from the top bar is the open section; Up from the first section is the search box, then the bar', () => {
    expect(move(tree, 'nav:settings', 'down', none)).toBe('nav:library');
    expect(move(tree, 'nav:library', 'up', none)).toBe('search-box');
    expect(move(tree, 'search-box', 'up', none)).toBe('nav:settings');
  });

  it('Right from the list is the section’s landing, Left from the left edge the open section', () => {
    expect(move(tree, 'nav:library', 'right', none)).toBe('add-movies');
    expect(move(tree, 'nav:advanced', 'right', none)).toBe('add-movies');
    expect(move(tree, 'add-movies', 'left', none)).toBe('nav:library');
    expect(move(tree, 'review', 'left', none)).toBe('nav:library');
  });

  it('Right comes back to the control left, and Down walks every control in the order drawn', () => {
    expect(walk(tree, 'field', ['left', 'right'])).toBe('field');
    const seen = ['remove'];
    let at = 'remove';
    for (let i = 0; i < 12; i++) {
      const next = move(tree, at, 'down', none);
      if (!next) break;
      seen.push((at = next));
    }
    expect(seen).toEqual(['remove', 'add-movies', 'review', 'ch-b', 'field', 'pair-a']);
  });

  it('a row of choices lands on the chosen one, holds Right at its end, Left from its start is the list', () => {
    expect(move(tree, 'review', 'down', none)).toBe('ch-b');
    expect(move(tree, 'field', 'up', none)).toBe('ch-b');
    expect(move(tree, 'ch-c', 'right', none)).toBeNull();
    expect(move(tree, 'ch-a', 'left', none)).toBe('nav:library');
    expect(walk(tree, 'ch-b', ['left', 'left', 'right'])).toBe('ch-b');
  });

  it('Right goes only along a row: from Scan now it is nothing, not Remove a row up', () => {
    expect(move(tree, 'scan', 'right', none)).toBeNull();
    expect(move(tree, 'pair-b', 'right', none)).toBeNull();
    expect(move(tree, 'pair-a', 'down', none)).toBeNull();
  });
});

describe('the on-screen keyboard (search)', () => {
  const tree = screen(
    column([
      ['box', row(['search-input'])],
      [
        'osk',
        column(
          [
            ['letters', { area: { kind: 'grid', columns: 4, remember: true }, children: 'abcdefghijkl'.split('') }],
            ['extra', row(['space', 'delete', 'clear'])],
          ],
          { remember: true }
        ),
      ],
      ['results', { area: { kind: 'grid', columns: 3 }, children: ['r0', 'r1', 'r2', 'r3'] }],
    ])
  );

  it('letters move by index, four across; Down from the last row is Space, Up from it the last letter held', () => {
    expect(move(tree, 'a', 'right', none)).toBe('b');
    expect(move(tree, 'a', 'down', none)).toBe('e');
    expect(move(tree, 'd', 'right', none)).toBeNull();
    expect(move(tree, 'i', 'down', none)).toBe('space');
    expect(walk(tree, 'k', ['down', 'up'])).toBe('k');
  });

  it('Down from the box is the keys, Down past them the results', () => {
    expect(move(tree, 'search-input', 'down', none)).toBe('a');
    expect(move(tree, 'clear', 'down', none)).toBe('r0');
    expect(move(tree, 'r0', 'up', none)).toBe('space');
  });
});

describe('a page of its own: first run, the setup pages', () => {
  const pageTree = (questions: boolean) =>
    build(
      column([
        [
          'setup',
          column(
            [
              ['next', row(['forward', 'later'], { current: 'forward' })],
              ['body', { area: { kind: 'column' }, disabled: !questions, children: ['q1', 'q2'] }],
            ],
            { current: 'body', hold: ['up', 'down', 'left', 'right'] }
          ),
        ],
      ])
    );

  it('lands on the first question; a page with none starts on Next', () => {
    expect(enter(pageTree(true), 'setup', none)).toBe('q1');
    expect(enter(pageTree(false), 'setup', none)).toBe('forward');
  });

  it('Up from the first question is Next, and nothing leaves the page by an arrow', () => {
    const tree = pageTree(true);
    expect(move(tree, 'q1', 'up', none)).toBe('forward');
    expect(move(tree, 'forward', 'up', none)).toBeNull();
    expect(move(tree, 'q2', 'down', none)).toBeNull();
    expect(move(tree, 'later', 'right', none)).toBeNull();
    expect(move(tree, 'q1', 'left', none)).toBeNull();
  });
});

describe('Needs attention (groups opened in place)', () => {
  const tree = screen(
    column([
      [
        'queue',
        column([
          'review-button',
          [
            'g1',
            column([
              'g1-summary',
              ['g1-search', row(['g1-input', 'g1-kind', 'g1-go', 'g1-ignore'])],
              ['g1-results', column(['g1-link-0', 'g1-link-1'])],
              ['g1-local', row(['g1-name', 'g1-year', 'g1-keep'])],
            ]),
          ],
          ['g2', column(['g2-summary'])],
          'guide',
        ]),
      ],
    ])
  );

  it('Down from a group’s summary goes into its panel in the order drawn, then on to the next group', () => {
    const order: string[] = [];
    let at = 'g1-summary';
    for (let i = 0; i < 8; i++) {
      const next = move(tree, at, 'down', none);
      if (!next) break;
      order.push((at = next));
    }
    expect(order).toEqual(['g1-input', 'g1-link-0', 'g1-link-1', 'g1-name', 'g2-summary', 'guide']);
  });

  it('along the search row, and Up from its first box is the summary', () => {
    expect(walk(tree, 'g1-input', ['right', 'right', 'right'])).toBe('g1-ignore');
    expect(move(tree, 'g1-ignore', 'right', none)).toBeNull();
    expect(move(tree, 'g1-input', 'up', none)).toBe('g1-summary');
    expect(move(tree, 'g1-name', 'up', none)).toBe('g1-link-1');
  });

  it('a group dealt with: the ring goes to the next group’s summary', () => {
    const gone = screen(column([['queue', column(['review-button', ['g2', column(['g2-summary'])], 'guide'])]]));
    expect(recover(gone, [{ area: 'queue', index: 1 }], none)).toBe('g2-summary');
  });
});

describe('a playlist page', () => {
  const tree = screen(
    column([
      ['head', row(['playlist:back'])],
      ['actions', row(['play', 'shuffle', 'repeat', 'rename', 'delete'], { current: 'play' })],
      [
        'items',
        column(
          [
            ['row1', row(['i1:play', 'i1:up', 'i1:down', 'i1:remove'])],
            ['row2', row(['i2:play', 'i2:up', 'i2:down', 'i2:remove'])],
          ],
          { remember: true }
        ),
      ],
    ])
  );

  it('Back, then Play, then the first item: Down lands on each area’s own landing', () => {
    expect(move(tree, 'playlist:back', 'down', none)).toBe('play');
    expect(move(tree, 'shuffle', 'down', none)).toBe('i1:play');
    expect(move(tree, 'i1:play', 'up', none)).toBe('play');
  });

  it('Down from an item’s buttons is the next row, on its own landing', () => {
    expect(walk(tree, 'i1:up', ['down'])).toBe('i2:play');
  });

  it('Remove on the last item: the ring goes to the item before it', () => {
    const left = screen(
      column([['head', row(['playlist:back'])], ['items', column([['row1', row(['i1:play', 'i1:remove'])]], { remember: true })]])
    );
    expect(recover(left, [{ area: 'items', index: 1 }], none)).toBe('i1:play');
  });
});

describe('tiles that wrap (playlists, Videos)', () => {
  const tree = screen(
    column([
      ['tiles', { area: { kind: 'grid', columns: 3, remember: true }, children: ['t0', 't1', 't2', 't3', 't4'] }],
      ['new', row(['new-button'])],
    ])
  );

  it('three across: Down is the tile below, or the last one from a column the last line does not reach', () => {
    expect(move(tree, 't0', 'down', none)).toBe('t3');
    expect(move(tree, 't2', 'down', none)).toBe('t4');
    expect(move(tree, 't4', 'down', none)).toBe('new-button');
    expect(move(tree, 't2', 'right', none)).toBeNull();
    expect(move(tree, 't0', 'up', none)).toBe('nav:settings');
  });
});
