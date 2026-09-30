//! Photographing the page through WebKitGTK: the Linux side of overlay.rs.
//!
//! A WebKitGTK window covered by mpv's stops producing snapshots after about
//! a second, because the compositor stops asking it to draw.
//! `WEBKIT_DISABLE_DMABUF_RENDERER`, set at start in lib.rs, keeps them coming.

use gtk::cairo::ImageSurface;
use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

type Pixels = (i32, i32, i32, Vec<u8>);

/// The visible page with a transparent background: width, height, stride and
/// premultiplied BGRA bytes.
pub async fn snapshot(window: &tauri::WebviewWindow) -> Result<Pixels, String> {
    let (tx, rx) = tokio::sync::oneshot::channel::<Result<Pixels, String>>();
    window
        .with_webview(move |webview| {
            webview.inner().snapshot(
                SnapshotRegion::Visible,
                SnapshotOptions::TRANSPARENT_BACKGROUND,
                None::<&gtk::gio::Cancellable>,
                move |result| {
                    let _ = tx.send(result.map_err(|e| e.to_string()).and_then(pixels));
                },
            );
        })
        .map_err(crate::util::to_string_err)?;
    rx.await.map_err(|_| "the snapshot was never delivered".to_string())?
}

fn pixels(surface: gtk::cairo::Surface) -> Result<Pixels, String> {
    let image = ImageSurface::try_from(surface).map_err(|_| "not an image surface".to_string())?;
    image.flush();
    let mut bytes = Vec::new();
    image
        .with_data(|data| bytes.extend_from_slice(data))
        .map_err(crate::util::to_string_err)?;
    Ok((image.width(), image.height(), image.stride(), bytes))
}
