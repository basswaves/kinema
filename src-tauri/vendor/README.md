# Patched copies of dependencies

Each folder here is a crate from crates.io with small changes, used in its
place through `[patch.crates-io]` in `src-tauri/Cargo.toml`. Remove a folder
(and its patch line) once the change is in a released version.

| Crate | Version | Change | Why |
|---|---|---|---|
| `smb-transport` (part of [smb-rs](https://github.com/afiffon/smb-rs), MIT, see its `LICENSE.md`) | 0.12.1 | `set_nodelay(true)` on the TCP socket, `src/tcp/transport.rs` | Without it every SMB request waited ~40 ms for a delayed acknowledgement: 22 MB/s instead of 368 MB/s reading a file, and a folder listing 150 times slower, on one machine. |
| | | The blocking `receive_exact` (`src/tcp/transport.rs`) and `receive` (`src/traits.rs`) keep what they have read when the receiver's 100 ms poll timeout falls inside a message | `read_exact` dropped the part already read, so the next read began inside the message ("bad magic") and the connection was lost. Happens on any link slow enough to pause mid-message (an Android emulator's did); `netshare::tests::a_slow_link_loses_nothing` makes one and fails without this. |

When the `smb` crate is updated, update the copy to the matching
`smb-transport` version and keep the change, or drop it if upstream has it.
