/**
 * The few kinds of focus group a screen is built from, each with fixed
 * behaviour (TV-FEEL.md, "Proposal"), as areas of Kinema's focus engine
 * (focusModel.ts has the rules, focusStore.ts the store):
 *
 * - **menu** — a panel, dialog or picker: a dialog that holds the ring while
 *   it is open and gives it back to the control that opened it. Up on the top
 *   item goes round to the bottom one and back (`wrap`). Back closing it
 *   stays with the component that owns it, which knows what closing means.
 * - **row** — the detail page's buttons, a season row, the top bar. Left and
 *   Right move inside it and stop at its ends (the owner's "neighbours only",
 *   NAV-MAP 2026-10-11); Up and Down leave it. Arriving from anywhere lands
 *   on its `current` item (Play, the active season, the open section, a
 *   setting's chosen choice).
 * - **panel** — an area laid out top to bottom: a Settings section.
 * - **list** — a list or rail (`axis: 'x'`). Arriving lands on the item last
 *   focused there, or `current` the first time.
 *
 * Before round 7 these were groups of the spatial library, which answered
 * every press by measuring the controls on screen (docs/GOTCHAS.md, "Spatial
 * navigation", before round 7); the library is gone since F4.
 */
import { useEffect, useId, useRef, type RefObject } from 'react';
import { useFocusWithin, useNavArea, useNavLeaf } from './focusStore';
import type { AreaSpec, Arrow } from './focusModel';

export type GroupKind = 'menu' | 'row' | 'panel' | 'list';

export type Wrap = 'vertical' | 'horizontal' | 'both' | 'none';

interface Options {
  focusKey?: string;
  /** Where arriving lands: the row's current item, a list's first-time item,
   *  a menu's selected option. */
  current?: string;
  /** False when the group has nothing to land on (an empty rail). */
  focusable?: boolean;
  /** Menus only: which arrows go round at the ends. Up/Down by default. */
  wrap?: Wrap;
  /** A list's axis (a rail is `x`); `y` unless said. */
  axis?: 'x' | 'y';
  /** The page goes to its top when the ring is here (the top bar). */
  pageTop?: boolean;
  /** Arrows that pass over this group from outside (focusModel.ts). */
  passOver?: Arrow[];
  /** A menu that is not a dialog (the details panel on `i`, beside the film). */
  modal?: boolean;
}

/** The area of the focus engine a group of `kind` is (focusModel.ts). */
function areaFor(kind: GroupKind, current: string | undefined, wrap: Wrap, axis: 'x' | 'y'): AreaSpec {
  if (kind === 'row') return { kind: 'row', current };
  if (kind === 'menu') return { kind: 'menu', current, wrap };
  if (kind === 'list') {
    return axis === 'x'
      ? { kind: 'row', current, remember: true }
      : { kind: 'column', current, remember: true };
  }
  return { kind: 'column', current };
}

/** A focus key for a control or area: the one given, else one of its own for its whole life. */
export function useNavKey(focusKey?: string): string {
  const own = `nav${useId()}`;
  return focusKey ?? own;
}

/**
 * An area: `ref` for its element, `focusKey` for `FocusProvider`
 * (FocusGroup.tsx) around its children, and whether the ring is inside.
 */
export function useNavGroup<E extends HTMLElement = HTMLDivElement>(
  area: AreaSpec & { disabled?: boolean; pageTop?: boolean; modal?: boolean },
  config: { focusKey?: string; focusable?: boolean } = {}
): { ref: RefObject<E | null>; focusKey: string; hasFocusedChild: boolean } {
  const ref = useRef<E>(null);
  const focusKey = useNavKey(config.focusKey);
  const { disabled, pageTop, modal, ...spec } = area;
  useNavArea(focusKey, ref, {
    on: true,
    spec,
    disabled: disabled || config.focusable === false,
    pageTop,
    modal,
  });
  const hasFocusedChild = useFocusWithin(focusKey, true);
  return { ref, focusKey, hasFocusedChild };
}

/**
 * A control (cards, Continue's cards, a stats group; FocusButton has its
 * own): whether it holds the ring, and `navProps` for its element.
 */
export function useFocusLeaf<E extends HTMLElement = HTMLDivElement>(config: {
  focusKey?: string;
  onSelect?: () => void;
  disabled?: boolean;
}): { ref: RefObject<E | null>; focusKey: string; focused: boolean; navProps: Record<string, unknown> } {
  const ref = useRef<E>(null);
  const focusKey = useNavKey(config.focusKey);
  const leaf = useNavLeaf(focusKey, ref, { on: true, disabled: config.disabled, onSelect: config.onSelect });
  return { ref, focusKey, focused: leaf.focused, navProps: leaf.props };
}

/** For a group nothing leaves by arrows: the player, a page of its own. */
export const ALL_ARROWS: Arrow[] = ['up', 'down', 'left', 'right'];

/**
 * Make a component a focus group of `kind`: put `ref` on the group's element
 * and wrap its children in `<FocusProvider value={focusKey}>`.
 *
 * The element is marked `data-focus-group` with its kind, which the
 * navigation checker reads.
 */
export function useFocusGroup<E extends HTMLElement = HTMLDivElement>(
  kind: GroupKind,
  { focusKey, current, focusable = true, wrap = 'vertical', axis = 'y', pageTop, passOver, modal }: Options = {}
): { ref: RefObject<E | null>; focusKey: string; hasFocusedChild: boolean } {
  // A menu is a dialog: it holds the ring while it is open, and gives it
  // back to the control that opened it (focusStore.ts).
  const area = {
    ...areaFor(kind, current, wrap, axis),
    passOver,
    disabled: !focusable,
    pageTop,
    modal: modal ?? kind === 'menu',
  };
  const result = useNavGroup<E>(area, { focusKey });

  const { ref } = result;
  useEffect(() => {
    ref.current?.setAttribute('data-focus-group', kind);
  }, [ref, kind]);

  return result;
}
