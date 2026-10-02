/**
 * A picture-and-sound setting with its three answers — off, every device
 * that can, only these — and, for "only these", the devices it means
 * (`devicePolicy.ts`).
 *
 * The list is every device the equipment check has seen, connected or not,
 * so a TV at home can be chosen from a laptop at a desk. Each is a button
 * that adds or removes it, marked like a chosen choice, so the whole thing
 * works from a remote. Choosing "only these" with nothing listed starts from
 * what is connected now and can use it: the answer most people mean by it.
 */
import type { ReactNode } from 'react';
import ChoiceRow from './ChoiceRow';
import FocusButton from './FocusButton';
import type { DevicePolicy, Policy } from '../player/devicePolicy';

export interface DeviceOption {
  id: string;
  name: string;
  /** What it can do, or when it was last seen: one short phrase. */
  detail: string;
  connected: boolean;
  /** Whether this setting can do anything for it. */
  able: boolean;
}

interface Props {
  label: string;
  /** "Every device that can", "Every screen". */
  allLabel: string;
  policy: DevicePolicy;
  devices: DeviceOption[];
  onChange: (next: DevicePolicy) => void;
  note?: ReactNode;
  hint?: ReactNode;
}

export default function DeviceChoice({ label, allLabel, policy, devices, onChange, note, hint }: Props) {
  const choose = (next: Policy) => {
    if (next === 'these' && policy.devices.length === 0) {
      const here = devices.filter((d) => d.connected && d.able).map((d) => d.id);
      onChange({ policy: next, devices: here });
      return;
    }
    onChange({ ...policy, policy: next });
  };
  const toggle = (id: string) => {
    const devicesNow = policy.devices.includes(id)
      ? policy.devices.filter((d) => d !== id)
      : [...policy.devices, id];
    onChange({ ...policy, devices: devicesNow });
  };

  return (
    <ChoiceRow
      label={label}
      choices={[
        { value: 'off', label: 'Off' },
        { value: 'all', label: allLabel },
        { value: 'these', label: 'Only these' },
      ]}
      value={policy.policy}
      onChange={choose}
      note={note}
      hint={hint}
    >
      {policy.policy === 'these' && (
        <div className="device-choice">
          {devices.length === 0 && (
            <p className="muted">No device has been seen yet. Connect one, and it is listed here.</p>
          )}
          {devices.map((d) => {
            const on = policy.devices.includes(d.id);
            return (
              <FocusButton
                key={d.id}
                className={`choice ${on ? 'chosen' : ''}`}
                keepInView="nearest"
                onSelect={() => toggle(d.id)}
              >
                <span className="choice-tick">{on ? '✓' : '+'}</span>
                <span className="device-choice-name">{d.name}</span>
                <span className="device-choice-detail">
                  {d.connected ? d.detail : `${d.detail}, not connected now`}
                </span>
              </FocusButton>
            );
          })}
        </div>
      )}
    </ChoiceRow>
  );
}
