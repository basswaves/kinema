/**
 * The test probe (`__nav`, src/dev/navProbe.ts) answers from the engine, not
 * from the page: the focus key and the tree agree with what is drawn, and a
 * press moves the key by the structure. Waits for states only.
 */
import { expect, test } from '@playwright/test';
import { expectFocusKey, focusKey, focusTree, open, press } from './kb';

test('the probe names the focused control and the tree it sits in', async ({ page }) => {
  await open(page, 'windows');
  const key = await focusKey(page);
  expect(key).not.toBeNull();
  // The same control is the one drawn with the ring.
  expect(await page.locator('.focused').first().getAttribute('data-nav-key')).toBe(key);

  const tree = await focusTree(page);
  const me = tree.find((n) => n.key === key);
  expect(me?.kind).toBe('control');
  expect(me?.disabled).toBe(false);
  // Its parent is an area of the tree, and the chain ends at the root.
  let at = me;
  for (let i = 0; i < 20 && at && at.parent !== 'nav-root'; i++) at = tree.find((n) => n.key === at!.parent);
  expect(at?.parent).toBe('nav-root');

  await press(page, 'ArrowDown');
  await expect.poll(() => focusKey(page)).not.toBe(key);
  const moved = (await focusKey(page))!;
  expect(tree.some((n) => n.key === moved) || (await focusTree(page)).some((n) => n.key === moved)).toBe(true);
  await expectFocusKey(page, moved);
});
