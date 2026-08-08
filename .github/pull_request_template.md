<!--
Thanks for the patch. Please read CONTRIBUTING.md if you have not — in
particular GOTCHAS.md, which is required reading before touching the
player or D-pad navigation. Nearly every entry in it describes a failure that
produces no error at all.
-->

## What this changes

<!-- One or two sentences. Why, not just what. -->

## Verification

<!--
Both of these, please. `check` passing while `build` is broken is a real state
this project has been in for months, which is why they are separate.
-->

- [ ] `npm run check`
- [ ] `npm run build`
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` (if the change touches Rust)
- [ ] Tested in the real app, not only over HMR

<!--
Two failure modes this codebase specialises in. Tick whichever applies, or
delete the section if neither does.
-->

- [ ] **mpv change:** tested after a full app restart, not over HMR. Observed
      properties are registered once at init, so a new one added and tested with
      a hot reload looks correct and simply never receives an event.
- [ ] **UI change:** tested with the mouse *physically untouched*. A bare
      `<button>` renders, styles, hovers and clicks perfectly while being absent
      from the focus tree — use `FocusButton` / `FocusInput` from `src/ui/`. One
      stray hover repairs focus and hides the failure completely.

## Anything you are unsure about

<!-- Optional. A question here is more useful than a guess in the code. -->
