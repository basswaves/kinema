# USB test for a machine that only runs releases

How the native-output work was verified on hardware that is not on the
development PC (the test TV + receiver, see docs/ROADMAP.md). Build a stick with:

    Kinema\                   kinema.exe, libmpv-2.dll, libmpv-wrapper.dll from dist-app\
    Automatic test\           run.ps1, ..\selftest.ps1, and one folder per plan.json
    3. Run automatic test.cmd
    2. Copy logs to USB.cmd   (for manual runs)

`run.ps1` runs every `plan.json` beside it through `selftest.ps1` against the
Kinema on the stick, on a fresh copy of that machine's library each time, and
copies each run's report, screenshots and logs to `Logs from the TV PC\auto-*`.
The person at the other end sets Windows up once, double-clicks, and waits.

The plans name files by the paths they have on that machine's shares. For a
dry run here without disturbing the main screen, add
`{ "at": 0.6, "do": "call", "fn": "moveToScreen", "args": [-1] }` before
`setFullscreen` - it moves the window to the first screen that is not primary.
