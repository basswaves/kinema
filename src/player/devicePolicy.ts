/**
 * Which devices a picture-and-sound setting applies to.
 *
 * Sending sound straight to the receiver, matching the refresh rate and
 * turning HDR on each describe equipment, and a PC is not always connected to
 * the same equipment: a laptop goes from a desk to a home cinema and back. So
 * each of the three has one of three answers (agreed 2026-10-02):
 *
 *  - **every device that can** — what "On" always meant, stored as `on` so a
 *    library from before keeps its setting, and an older Kinema reading this
 *    one's still understands it;
 *  - **only these** — the screens or sound devices listed beside it, by the
 *    stable ids the equipment check gives them. A device connected later is
 *    left as it is until it is added, which the Home notice offers;
 *  - **off**.
 *
 * What "can" means is each rule's own business (`audioOutput.ts`,
 * `displayMode.ts`); this only says whether a device is covered at all.
 */
import { getSetting, setSetting } from '../metadata/api';

export type Policy = 'all' | 'these' | 'off';

export interface DevicePolicy {
  policy: Policy;
  /** The devices "only these" means. Kept when the policy changes, so
   * switching away from "only these" and back loses nothing. */
  devices: string[];
}

export const POLICY_OFF: DevicePolicy = { policy: 'off', devices: [] };

/** Where a setting keeps its list of devices. */
export const devicesKey = (key: string) => `${key}_devices`;

export function parsePolicy(value: string | null, list: string | null): DevicePolicy {
  let devices: string[] = [];
  try {
    const parsed: unknown = list ? JSON.parse(list) : [];
    if (Array.isArray(parsed)) devices = parsed.filter((d): d is string => typeof d === 'string');
  } catch {
    // A damaged list covers nothing, which is the safe way to be wrong.
  }
  const policy: Policy = value === 'on' ? 'all' : value === 'these' ? 'these' : 'off';
  return { policy, devices };
}

/** Whether the setting applies to the device `id` (null: not known). */
export function covers(p: DevicePolicy, id: string | null | undefined): boolean {
  if (p.policy === 'all') return true;
  if (p.policy === 'these') return id != null && p.devices.includes(id);
  return false;
}

export async function readPolicy(key: string): Promise<DevicePolicy> {
  const [value, list] = await Promise.all([getSetting(key), getSetting(devicesKey(key))]);
  return parsePolicy(value, list);
}

export async function savePolicy(key: string, p: DevicePolicy): Promise<void> {
  await setSetting(devicesKey(key), JSON.stringify(p.devices));
  await setSetting(key, p.policy === 'all' ? 'on' : p.policy);
}

/** `p` with `id` added to its list, and set to "only these" if it was off. */
export function withDevice(p: DevicePolicy, id: string): DevicePolicy {
  const devices = p.devices.includes(id) ? p.devices : [...p.devices, id];
  return { policy: p.policy === 'all' ? 'all' : 'these', devices };
}
