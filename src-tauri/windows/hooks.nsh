; Kinema's additions to Tauri's NSIS installer (tauri.installer.conf.json).
;
; Uninstalling leaves nothing of Kinema's behind: Tauri's own uninstaller
; takes the program, its shortcuts and its Apps entry, and asks with a
; checkbox before deleting the library and settings. These hooks add what
; Tauri does not know about. None of them runs for an update (/UPDATE), when
; the old version is removed only to be replaced.

!macro NSIS_HOOK_PREUNINSTALL
  ${If} $UpdateMode <> 1
    ; Kinema must be closed first, so the clean-up is not undone by a
    ; Kinema that keeps running, or wasted on an uninstall that is cancelled.
    !insertmacro CheckIfAppIsRunning "${MAINBINARYNAME}.exe" "${PRODUCTNAME}"
    ; "Offer Kinema as a video player" (default_player.rs): the same Remove
    ; as in Settings, plus Windows' cached name for the program.
    ExecWait '"$INSTDIR\${MAINBINARYNAME}.exe" --uninstall-cleanup'
  ${EndIf}
!macroend

!macro NSIS_HOOK_POSTUNINSTALL
  ${If} $UpdateMode <> 1
    ; Where Kinema was installed. Tauri keeps it unless the library is
    ; deleted too, to suggest the same folder next time; a program that has
    ; been removed should not leave its address behind.
    DeleteRegKey HKCU "${MANUPRODUCTKEY}"
    DeleteRegKey /ifempty HKCU "${MANUKEY}"
    ; What Windows' shell wrote about Kinema by itself, keyed by its app id:
    ; the Start menu's tile and the jump list (seen in Windows Sandbox).
    DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Start\TileProperties\W~${BUNDLEID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Search\JumplistData" "${BUNDLEID}"
    ; And Windows' cached name for this uninstaller, which runs from a copy
    ; in the temporary folder (Kinema's own is cleared by --uninstall-cleanup).
    DeleteRegValue HKCU "Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache" "$EXEPATH.FriendlyAppName"
    DeleteRegValue HKCU "Software\Classes\Local Settings\Software\Microsoft\Windows\Shell\MuiCache" "$EXEPATH.ApplicationCompany"
  ${EndIf}
!macroend
