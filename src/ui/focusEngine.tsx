/**
 * The components of Kinema's own focus engine (focusStore.ts has the store,
 * focusModel.ts the rules): a screen on it, and the area a subtree belongs to.
 */
import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  newScreenId,
  ParentContext,
  ROOT,
  ScreenContext,
  screenArrived,
  screenKeys,
  screenLeft,
} from './focusStore';

/** The area the calling component's controls belong to. */
export function NavParent({ value, children }: { value: string; children: ReactNode }) {
  return <ParentContext.Provider value={value}>{children}</ParentContext.Provider>;
}

/**
 * A whole screen on this engine (Home, a grid, the player). Its controls
 * register here from their first render, and while it is mounted this engine
 * answers the keys — unless `keys` is false: the player's, while the arrows
 * seek.
 */
export function FocusScreen({ children, keys = true }: { children: ReactNode; keys?: boolean }) {
  const [id] = useState(newScreenId);
  // Arriving with the keys it has then; each change after, as it comes.
  const keysNow = useRef(keys);
  useLayoutEffect(() => {
    screenArrived(id, keysNow.current);
    return () => screenLeft(id);
  }, [id]);
  useLayoutEffect(() => {
    keysNow.current = keys;
    screenKeys(id, keys);
  }, [id, keys]);
  return (
    <ScreenContext.Provider value={id}>
      <ParentContext.Provider value={ROOT}>{children}</ParentContext.Provider>
    </ScreenContext.Provider>
  );
}
