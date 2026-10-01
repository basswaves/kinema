"""The desktop's view of the screens, and HDR on or off: GNOME through Mutter's
DisplayConfig, KDE Plasma through kscreen-doctor (chosen by XDG_CURRENT_DESKTOP,
as Kinema chooses).

  python3 display.py state           -> JSON: every monitor, its modes, its properties
  python3 display.py hdr on|off      -> GNOME: the HDR colour mode (1, BT.2100) or the default (0)
                                        on every monitor that lists it as supported; Plasma: HDR
                                        on or off on every screen that offers it
  python3 display.py mode W H HZ     -> the W x H mode nearest HZ, HDR mode kept
  python3 display.py current         -> "W H HZ" of the first screen's current mode (Plasma: the
                                        primary screen's)

Written for the Linux test stick: what it prints is the raw material for
Kinema's own Linux screen code. GNOME's changes are temporary; Plasma keeps
its in the home folder, which the stick's persistence keeps — so the kit
always puts the screen back itself.
"""
import json
import os
import subprocess
import sys
import time

from gi.repository import Gio, GLib

BUS ='org.gnome.Mutter.DisplayConfig'
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


# ---- KDE Plasma ---------------------------------------------------------------
# kscreen-doctor, as Kinema's kscreen.rs uses it: `-j` to read (anything
# before the first brace is a Qt warning, skipped), `output.<name>.mode.<id>`
# and `output.<name>.hdr.enable|disable` to change. `hdr` is in an output's
# JSON only when Plasma can show HDR on it — which this stick run confirms.

def is_plasma():
    return any(p.lower() == 'kde' for p in os.environ.get('XDG_CURRENT_DESKTOP', '').split(':'))


def kscreen(*args):
    done = subprocess.run(['kscreen-doctor', *args], capture_output=True, text=True, timeout=20)
    if done.returncode != 0 or 'not found' in done.stdout:
        raise RuntimeError(f'kscreen-doctor {" ".join(args)}: exit {done.returncode}: '
                           f'{(done.stderr or done.stdout).strip()[-300:]}')
    return done.stdout


def kde_state():
    # Once more after a pause: in a fresh session the first call can come
    # while KScreen's service is still starting (seen in a nested KWin).
    for attempt in range(2):
        try:
            out = kscreen('-j')
            return json.loads(out[out.index('{'):])
        except (RuntimeError, ValueError, subprocess.TimeoutExpired):
            if attempt:
                raise
            time.sleep(2)


def kde_screens(s):
    """The connected, switched-on outputs, the primary one (priority 1) first."""
    on = [o for o in s.get('outputs', []) if o.get('connected') and o.get('enabled')]
    return sorted(on, key=lambda o: o.get('priority') != 1)


def kde_current(o):
    return next((m for m in o.get('modes', []) if m['id'] == o.get('currentModeId')), None)


def kde_now():
    return {o['name']: {'hdr': o.get('hdr'),
                        'mode': (m := kde_current(o)) and '%dx%d@%.3f' % (
                            m['size']['width'], m['size']['height'], m['refreshRate'])}
            for o in kde_screens(kde_state())}


def kde_apply(hdr=None, size=None, refresh=None):
    """One kscreen-doctor call for every screen that has what is asked for."""
    changes = []
    for o in kde_screens(kde_state()):
        if size:
            fits = [m for m in o.get('modes', [])
                    if (m['size']['width'], m['size']['height']) == size]
            if fits:
                best = min(fits, key=lambda m: abs(m['refreshRate'] - refresh))
                changes.append(f"output.{o['name']}.mode.{best['id']}")
        if hdr is not None and 'hdr' in o:
            changes.append(f"output.{o['name']}.hdr.{'enable' if hdr else 'disable'}")
    if changes:
        kscreen(*changes)
    return {'asked': changes, 'now': kde_now()}


def run(argv):
    plasma = is_plasma()
    if argv[1] == 'state':
        print(json.dumps(kde_state() if plasma else state(), indent=1, default=str))
    elif argv[1] == 'hdr':
        on = argv[2] == 'on'
        print(json.dumps(kde_apply(hdr=on) if plasma else {'color-mode-now': set_hdr(on)}))
    elif argv[1] == 'mode':
        size, refresh = (int(argv[2]), int(argv[3])), float(argv[4])
        print(json.dumps(kde_apply(size=size, refresh=refresh) if plasma
                         else {'now': apply(size=size, refresh=refresh)}))
    elif argv[1] == 'current':
        if plasma:
            modes = [kde_current(o) for o in kde_screens(kde_state())]
            modes = [(m['size']['width'], m['size']['height'], m['refreshRate'])
                     for m in modes if m]
        else:
            modes = [(m['width'], m['height'], m['refresh'])
                     for m in current_modes(state()).values() if m]
        if modes:
            w, h, hz = modes[0]
            print(w, h, round(hz, 3))


if __name__ == '__main__':
    try:
        run(sys.argv)
    except Exception as e:  # recorded, never fatal: the kit carries on
        print(json.dumps({'error': f'{type(e).__name__}: {e}'}))
        sys.exit(1)
