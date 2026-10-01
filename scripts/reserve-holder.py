"""A stand-in for the sound server's hold on a sound card, for testing
audio_reserve.rs without one: owns org.freedesktop.ReserveDevice1.Audio7 at
WirePlumber's default priority (-20) and lets go when a higher priority asks,
taking the card back once it is free — what WirePlumber and PulseAudio do.

  dbus-run-session -- bash -c 'python3 scripts/reserve-holder.py & sleep 1;
    cargo test --manifest-path src-tauri/Cargo.toml takes_the_card -- --ignored --nocapture'

Linux only (python3-gi). Runs until killed.
"""
from gi.repository import Gio, GLib

CARD = 7
NAME = f'org.freedesktop.ReserveDevice1.Audio{CARD}'
PATH = f'/org/freedesktop/ReserveDevice1/Audio{CARD}'
PRIORITY = -20

XML = """
<node>
  <interface name="org.freedesktop.ReserveDevice1">
    <method name="RequestRelease">
      <arg name="priority" type="i" direction="in"/>
      <arg name="result" type="b" direction="out"/>
    </method>
    <property name="Priority" type="i" access="read"/>
    <property name="ApplicationName" type="s" access="read"/>
    <property name="ApplicationDeviceName" type="s" access="read"/>
  </interface>
</node>
"""


def call(_conn, _sender, _path, _iface, method, params, invocation):
    if method == 'RequestRelease':
        (priority,) = params.unpack()
        agree = priority > PRIORITY
        print(f'holder: asked to release at priority {priority}: {agree}', flush=True)
        invocation.return_value(GLib.Variant('(b)', (agree,)))


def get(_conn, _sender, _path, _iface, prop):
    return {
        'Priority': GLib.Variant('i', PRIORITY),
        'ApplicationName': GLib.Variant('s', 'Stand-in sound server'),
        'ApplicationDeviceName': GLib.Variant('s', f'hw:{CARD}'),
    }[prop]


def acquired(conn, _name):
    print('holder: holds the card', flush=True)


def lost(conn, _name):
    print('holder: card taken', flush=True)


def on_bus(conn, _name):
    node = Gio.DBusNodeInfo.new_for_xml(XML)
    conn.register_object(PATH, node.interfaces[0], call, get, None)


# Allow replacement, and queue (no DO_NOT_QUEUE): once replaced, the bus
# gives the name back by itself when the new owner lets it go.
Gio.bus_own_name(Gio.BusType.SESSION, NAME, Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT,
                 on_bus, acquired, lost)
GLib.MainLoop().run()
