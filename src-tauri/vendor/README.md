# Patched copies of dependencies

Each folder here is a crate from crates.io with one small change, used in its
place through `[patch.crates-io]` in `src-tauri/Cargo.toml`. Remove a folder
(and its patch line) once the change is in a released version.

| Crate | Version | Change | Why |
|---|---|---|---|
| `smb-transport` (part of [smb-rs](https://github.com/afiffon/smb-rs), MIT, see its `LICENSE.md`) | 0.12.1 | `set_nodelay(true)` on the TCP socket, `src/tcp/transport.rs` | Without it every SMB request waited ~40 ms for a delayed acknowledgement: 22 MB/s instead of 368 MB/s reading a file, and a folder listing 150 times slower, on one machine. |

When the `smb` crate is updated, update the copy to the matching
`smb-transport` version and keep the change, or drop it if upstream has it.
