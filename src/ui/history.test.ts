import { describe, expect, it } from 'vitest';
import { back, current, navigate, open, replace, type Entry } from './history';

const home: Entry<string>[] = [{ view: 'home', returnFocus: null }];

describe('view history', () => {
  it('goes back to the grid a title was opened from, with the card to refocus', () => {
    let stack = open(home, 'grid', 'rail:Movies:see-all');
    stack = open(stack, 'detail', 'grid:7');
    stack = back(stack);
    expect(current(stack)).toBe('grid');
    expect(stack[stack.length - 1].returnFocus).toBe('grid:7');
    stack = back(stack);
    expect(current(stack)).toBe('home');
    expect(stack[0].returnFocus).toBe('rail:Movies:see-all');
  });

  it('comes back from the player to the page Play was pressed on', () => {
    let stack = open(home, 'detail', 'rail:TV shows:3');
    stack = open(stack, 'player', 'detail-play');
    stack = replace(stack, 'player next episode');
    stack = back(stack);
    expect(current(stack)).toBe('detail');
    expect(stack[stack.length - 1].returnFocus).toBe('detail-play');
  });

  it('starts again from Home for a top-bar destination', () => {
    const deep = open(open(home, 'grid', 'a'), 'detail', 'b');
    expect(navigate('home', 'search', false).map((e) => e.view)).toEqual(['home', 'search']);
    expect(navigate('home', 'home', true).map((e) => e.view)).toEqual(['home']);
    expect(back(navigate('home', 'settings', false)).map((e) => e.view)).toEqual(['home']);
    expect(deep).toHaveLength(3);
  });

  it('stays on Home when there is nowhere further back', () => {
    expect(back(home)).toBe(home);
  });
});
