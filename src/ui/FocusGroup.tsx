/**
 * A focus group as an element: `<FocusGroup kind="row" current={PLAY}>…`.
 *
 * The children register inside the group because they are rendered under its
 * provider here, in a component of their own — the rule in docs/GOTCHAS.md
 * ("Spatial navigation") that a hook and its own provider in one component
 * would break. See focusGroups.ts for what each kind does.
 */
import { FocusContext } from '@noriginmedia/norigin-spatial-navigation';
import type { ReactNode } from 'react';
import { NavParent } from './focusEngine';
import { useFocusGroup, type GroupKind, type Wrap } from './focusGroups';
import type { Direction } from './navGeometry';

/**
 * A group's children, on whichever engine: the spatial library's provider
 * and Kinema's (focusEngine.tsx) under the one key. In place of
 * `<FocusContext.Provider value={focusKey}>`.
 */
export function FocusProvider({ value, children }: { value: string; children: ReactNode }) {
  return (
    <FocusContext.Provider value={value}>
      <NavParent value={value}>{children}</NavParent>
    </FocusContext.Provider>
  );
}

interface Props {
  kind: GroupKind;
  focusKey?: string;
  current?: string;
  focusable?: boolean;
  wrap?: Wrap;
  stopAt?: Direction[];
  axis?: 'x' | 'y';
  className?: string;
  role?: string;
  'aria-label'?: string;
  children: ReactNode;
}

export default function FocusGroup({
  kind,
  className,
  role,
  'aria-label': ariaLabel,
  children,
  ...options
}: Props) {
  const { ref, focusKey } = useFocusGroup(kind, options);
  return (
    <FocusProvider value={focusKey}>
      <div ref={ref} className={className} role={role} aria-label={ariaLabel}>
        {children}
      </div>
    </FocusProvider>
  );
}
