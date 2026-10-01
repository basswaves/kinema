"""GNOME's view of the screens, and HDR on or off, through Mutter's DisplayConfig.

  python3 display.py state           -> JSON: every monitor, its modes, its properties
  python3 display.py hdr on|off      -> asks Mutter for the HDR colour mode (its number varies by
                                        GNOME version: 50 lists 2) or the default (0)
                                        on every monitor that lists it as supported

Written for the Linux test stick: what it prints is the raw material for
Kinema's own Linux screen code. Nothing here is kept; the live session forgets.
"""
import json
import sys

from gi.repository import Gio, GLib

BUS = 'org.gnome.Mutter.DisplayConfig'
PATH = '/org/gnome/Mutter/DisplayConfig'


def proxy():
    return Gio.DBusProxy.new_for_bus_sync(
        Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE, None, BUS, PATH, BUS, None)


def plain(value):
    """GLib.Variant contents to JSON-friendly values."""
    if isinstance(value, GLib.Variant):
        value = value.unpack()
    if isinstance(value, dict):
        return {k: plain(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [plain(v) for v in value]
    return value


def state():
    serial, monitors, logical, props = proxy().call_sync(
        'GetCurrentState', None, Gio.DBusCallFlags.NONE, -1, None).unpack()
    out = {'serial': serial, 'properties': plain(props), 'monitors': [], 'logical': []}
    for (connector, vendor, product, mserial), modes, mprops in monitors:
        out['monitors'].append({
            'connector': connector, 'vendor': vendor, 'product': product, 'serial': mserial,
            'properties': plain(mprops),
            'modes': [{'id': m[0], 'width': m[1], 'height': m[2], 'refresh': m[3],
                       'preferred_scale': m[4], 'properties': plain(m[6])} for m in modes],
        })
    for x, y, scale, transform, primary, mons, lprops in logical:
        out['logical'].append({'x': x, 'y': y, 'scale': scale, 'transform': transform,
                               'primary': primary, 'monitors': [list(m) for m in mons],
                               'properties': plain(lprops)})
    return out


def set_hdr(on):
    s = state()
    current = {}
    for m in s['monitors']:
        mode = next((x for x in m['modes'] if x['properties'].get('is-current')), None)
        if mode:
            current[m['connector']] = (mode['id'], m['properties'])
    logical = []
    for lm in s['logical']:
        mons = []
        for connector, *_ in lm['monitors']:
            mode_id, mprops = current[connector]
            props = {}
            # The HDR mode is whichever non-default one the monitor lists:
            # its number is not the same in every GNOME (50 says 2).
            hdr_modes = [c for c in (mprops.get('supported-color-modes') or []) if c != 0]
            if hdr_modes:
                props['color-mode'] = GLib.Variant('u', hdr_modes[0] if on else 0)
            mons.append((connector, mode_id, props))
        logical.append((lm['x'], lm['y'], lm['scale'], lm['transform'], lm['primary'], mons))
    args = GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', (s['serial'], 1, logical, {}))
    proxy().call_sync('ApplyMonitorsConfig', args, Gio.DBusCallFlags.NONE, -1, None)
    after = state()
    return {m['connector']: m['properties'].get('color-mode') for m in after['monitors']}


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'state':
            print(json.dumps(state(), indent=1, default=str))
        elif sys.argv[1] == 'hdr':
            print(json.dumps({'color-mode-now': set_hdr(sys.argv[2] == 'on')}))
    except Exception as e:  # recorded, never fatal: the kit carries on
        print(json.dumps({'error': f'{type(e).__name__}: {e}'}))
        sys.exit(1)
