/**
 * The components of Kinema's own focus engine (focusStore.ts has the store,
 * focusModel.ts the rules): a screen on it, the area a subtree belongs to,
 * and a dialog still on the spatial library over it.
 */
import { useLayoutEffect, useState, type ReactNode } from 'react';
import {
  EngineContext,
  layerClosed,
  layerOpened,
  newScreenId,
  ParentContext,
  ROOT,
  ScreenContext,
  screenArrived,
  screenLeft,
} from './focusStore';

/** The area the calling component's controls belong to. */
export function NavParent({ value, children }: { value: string; children: ReactNode }) {
  return <ParentContext.Provider value={value}>{children}</ParentContext.Provider>;
}

/**
 * A whole screen on this engine (Home, a grid). Its controls register here
 * from their first render, and while it is mounted this engine answers the
 * keys.
 */
export function FocusScreen({ children }: { children: ReactNode }) {
  const [id] = useState(newScreenId);
  useLayoutEffect(() => {
    screenArrived(id);
    return () => screenLeft(id);
  }, [id]);
  return (
    <EngineContext.Provider value="kinema">
      <ScreenContext.Provider value={id}>
        <ParentContext.Provider value={ROOT}>{children}</ParentContext.Provider>
      </ScreenContext.Provider>
    </EngineContext.Provider>
  );
}

/**
 * A dialog still on the spatial library, over a screen on this engine: it
 * takes the keys while it is open, and the ring here comes back when it
 * closes.
 */
export function NoriginLayer({ children }: { children: ReactNode }) {
  useLayoutEffect(() => {
    layerOpened();
    return layerClosed;
  }, []);
  return <EngineContext.Provider value="norigin">{children}</EngineContext.Provider>;
}
