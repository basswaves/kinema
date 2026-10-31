/**
 * A focus group as an element: `<FocusGroup kind="row" current={PLAY}>…`.
 *
 * The children register inside the group because they are rendered under its
 * provider here, in a component of their own: a hook runs in the area of the
 * component it is called in (docs/GOTCHAS.md, "A control's place in the
 * engine's tree is where its hook runs"). See focusGroups.ts for what each
 * kind does.
 */
import type { ReactNode } from 'react';
import { NavParent } from './focusEngine';
import type { Arrow } from './focusModel';
import { useFocusGroup, type GroupKind, type Wrap } from './focusGroups';

/** A group's children, in the area `value`. */
export function FocusProvider({ value, children }: { value: string; children: ReactNode }) {
  return <NavParent value={value}>{children}</NavParent>;
}

interface Props {
  kind: GroupKind;
  focusKey?: string;
  current?: string;
  focusable?: boolean;
  wrap?: Wrap;
  axis?: 'x' | 'y';
  pageTop?: boolean;
  passOver?: Arrow[];
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
