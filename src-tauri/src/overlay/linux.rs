//! Photographing the page through WebKitGTK: the Linux side of overlay.rs.
//!
//! On some desktops a WebKitGTK window covered by mpv's stops producing
//! snapshots when WebKit draws with the graphics card, because the compositor
//! stops asking it to draw: the callback simply never runs. So a snapshot is
//! given `STALLED` to come back, and one that does not is the sign
//! webkit_drawing.rs remembers, so the next start draws on the processor.

use gtk::cairo::ImageSurface;
use webkit2gtk::{SnapshotOptions, SnapshotRegion, WebViewExt};

type Pixels = (i32, i32, i32, Vec<u8>);

/// Longer than any photo was seen to take: 820 ms on a weak computer already
/// overloaded by a 4K film decoded on its processor; 30-70 ms is usual.
const STALLED: std::time::Duration = std::time::Duration::from_secs(3);

/// The error a stalled snapshot gives; the page (overlay.ts) knows it.
pub const STOPPED: &str = "photos stopped";

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
    match tokio::time::timeout(STALLED, rx).await {
        Ok(delivered) => delivered.map_err(|_| "the snapshot was never delivered".to_string())?,
        Err(_) => {
            crate::webkit_drawing::photos_stopped(STALLED);
            Err(STOPPED.to_string())
        }
    }
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
