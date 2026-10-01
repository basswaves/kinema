"""GNOME's view of the screens, and HDR on or off, through Mutter's DisplayConfig.

  python3 display.py state           -> JSON: every monitor, its modes, its properties
  python3 display.py hdr on|off      -> asks Mutter for the HDR colour mode (1, BT.2100) or the
                                        default (0) on every monitor that lists it as supported
  python3 display.py mode W H HZ     -> the W x H mode nearest HZ, HDR mode kept
  python3 display.py current         -> "W H HZ" of the first screen's current mode

Written for the Linux test stick: what it prints is the raw material for
Kinema's own Linux screen code. Nothing here is kept; the live session forgets.
"""
import json
import sys

from gi.repository import Gio, GLib

BUS = 'org.gnome.Mutter.DisplayConfig'
PATH = '/org/gnome/Mutter/DisplayConfig'
HDR = 1  # META_COLOR_MODE_BT2100


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


def current_modes(s):
    return {m['connector']: next((x for x in m['modes'] if x['properties'].get('is-current')), None)
            for m in s['monitors']}


def apply(hdr=None, size=None, refresh=None):
    """Re-apply the current layout, changing the HDR mode (hdr True/False) and/or
    the screen mode (size (w, h) and the nearest refresh rate). What is not
    asked for is kept. Temporary (method 1): the live session forgets it."""
    s = state()
    current = current_modes(s)
    monitors = {m['connector']: m for m in s['monitors']}
    logical = []
    for lm in s['logical']:
        mons = []
        for connector, *_ in lm['monitors']:
            m = monitors[connector]
            mode = current[connector]
            if size:
                fits = [x for x in m['modes'] if (x['width'], x['height']) == size]
                if fits:
                    mode = min(fits, key=lambda x: abs(x['refresh'] - refresh))
            mprops = m['properties']
            props = {}
            # Mutter's colour modes: 0 default, 1 BT.2100 (HDR), 2 sdr-native
            # (GNOME 50: wide-gamut SDR from the EDID's primaries — not HDR,
            # which the second round mistook for it).
            supported = mprops.get('supported-color-modes') or []
            if supported:
                want = mprops.get('color-mode', 0) if hdr is None else (
                    HDR if hdr and HDR in supported else 0)
                props['color-mode'] = GLib.Variant('u', want)
            mons.append((connector, mode['id'], props))
        logical.append((lm['x'], lm['y'], lm['scale'], lm['transform'], lm['primary'], mons))
    args = GLib.Variant('(uua(iiduba(ssa{sv}))a{sv})', (s['serial'], 1, logical, {}))
    proxy().call_sync('ApplyMonitorsConfig', args, Gio.DBusCallFlags.NONE, -1, None)
    after = state()
    now = current_modes(after)
    return {m['connector']: {'color-mode': m['properties'].get('color-mode'),
                             'mode': now[m['connector']] and '%dx%d@%.3f' % (
                                 now[m['connector']]['width'], now[m['connector']]['height'],
                                 now[m['connector']]['refresh'])}
            for m in after['monitors']}


def set_hdr(on):
    return {c: v['color-mode'] for c, v in apply(hdr=on).items()}


if __name__ == '__main__':
    try:
        if sys.argv[1] == 'state':
            print(json.dumps(state(), indent=1, default=str))
        elif sys.argv[1] == 'hdr':
            print(json.dumps({'color-mode-now': set_hdr(sys.argv[2] == 'on')}))
        elif sys.argv[1] == 'mode':
            size = (int(sys.argv[2]), int(sys.argv[3]))
            print(json.dumps({'now': apply(size=size, refresh=float(sys.argv[4]))}))
        elif sys.argv[1] == 'current':
            for mode in current_modes(state()).values():
                if mode:
                    print(mode['width'], mode['height'], round(mode['refresh'], 3))
                    break
    except Exception as e:  # recorded, never fatal: the kit carries on
        print(json.dumps({'error': f'{type(e).__name__}: {e}'}))
        sys.exit(1)
