//! Real mouse input for the web view: the Linux side of pointer.rs.
//!
//! A GDK event is built and handed to GTK's own dispatch, the way WebKit's
//! test runner drives WebKitGTK (EventSenderProxyGtk). It never passes
//! through the desktop, so it reaches the web view although mpv's window
//! covers it, and WebKit takes it as the user's own — `:hover`, a range
//! input's thumb, its own double-click counting.

use super::PointerKind;
use gtk::gdk;
use gtk::glib::translate::ToGlibPtr;
use gtk::prelude::*;

pub fn send(
    window: &tauri::WebviewWindow,
    kind: PointerKind,
    x: f64,
    y: f64,
    time: u32,
    held: bool,
) -> Result<(), String> {
    window
        .with_webview(move |webview| {
            let view = webview.inner();
            let Some(target) = view.window() else { return };
            // Relative to the view's own window; a view drawn into its
            // parent's is offset by where it sits in it.
            let (x, y) = if view.has_window() {
                (x, y)
            } else {
                let at = view.allocation();
                (x + at.x() as f64, y + at.y() as f64)
            };
            let Some(pointer) = view.display().default_seat().and_then(|seat| seat.pointer()) else {
                return;
            };
            unsafe { dispatch(&target, &pointer, kind, x, y, time, held) };
        })
        .map_err(crate::util::to_string_err)
}

/// Build the event in GDK's own memory and dispatch it. Through the C
/// functions rather than `gdk::Event::new`, which copies the new event and
/// leaves the original behind — one leak per mouse move.
unsafe fn dispatch(
    target: &gdk::Window,
    pointer: &gdk::Device,
    kind: PointerKind,
    x: f64,
    y: f64,
    time: u32,
    held: bool,
) {
    use gdk::ffi;
    let window: *mut ffi::GdkWindow = target.to_glib_none().0;
    let device: *mut ffi::GdkDevice = pointer.to_glib_none().0;
    let (_, ox, oy) = target.origin();
    let (rx, ry) = (x + ox as f64, y + oy as f64);
    // The button's state before the event, as GDK reports it: held during a
    // drag and in the release that ends it.
    let state = if held { ffi::GDK_BUTTON1_MASK } else { 0 };

    let event = match kind {
        PointerKind::Move => {
            let e = ffi::gdk_event_new(ffi::GDK_MOTION_NOTIFY);
            let m = &mut (*e).motion;
            (m.x, m.y, m.x_root, m.y_root, m.state, m.device) = (x, y, rx, ry, state, device);
            m.time = time;
            e
        }
        PointerKind::Down | PointerKind::Up => {
            let down = kind == PointerKind::Down;
            let e = ffi::gdk_event_new(if down { ffi::GDK_BUTTON_PRESS } else { ffi::GDK_BUTTON_RELEASE });
            let b = &mut (*e).button;
            (b.x, b.y, b.x_root, b.y_root, b.device) = (x, y, rx, ry, device);
            b.state = if down { 0 } else { ffi::GDK_BUTTON1_MASK };
            b.button = 1;
            b.time = time;
            e
        }
        PointerKind::WheelUp | PointerKind::WheelDown => {
            let e = ffi::gdk_event_new(ffi::GDK_SCROLL);
            let s = &mut (*e).scroll;
            (s.x, s.y, s.x_root, s.y_root, s.state, s.device) = (x, y, rx, ry, state, device);
            s.direction = if kind == PointerKind::WheelUp { ffi::GDK_SCROLL_UP } else { ffi::GDK_SCROLL_DOWN };
            s.time = time;
            e
        }
        PointerKind::Leave => {
            let e = ffi::gdk_event_new(ffi::GDK_LEAVE_NOTIFY);
            let c = &mut (*e).crossing;
            (c.x, c.y, c.x_root, c.y_root, c.state) = (x, y, rx, ry, state);
            c.mode = ffi::GDK_CROSSING_NORMAL;
            c.detail = ffi::GDK_NOTIFY_ANCESTOR;
            c.time = time;
            e
        }
    };
    // Every kind starts with the same fields; the event owns a reference to
    // its window, which `gdk_event_free` gives back.
    (*event).any.window = gtk::glib::gobject_ffi::g_object_ref(window.cast()).cast();
    (*event).any.send_event = 1;
    ffi::gdk_event_set_device(event, device);
    gtk::ffi::gtk_main_do_event(event);
    ffi::gdk_event_free(event);
}
