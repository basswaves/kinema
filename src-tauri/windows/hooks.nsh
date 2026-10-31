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

; A newer setup run by hand updates in place.
;
; Tauri's "already installed" page pre-selects "uninstall before installing"
; for an upgrade, and then runs the old uninstaller as a real uninstall: the
; taskbar pin and the shortcuts go (Tauri's UnpinShortcut) and so does the
; default-player registration (--uninstall-cleanup). Only /UPDATE makes it
; an update, and the page cannot be told to pass it. So when this setup is
; newer than what is installed and was not started as an update already, it
; starts itself again as one ("/P /UPDATE /R", what Tauri's own updater
; passes: no pages, files replaced in place, Kinema started at the end) and
; quits (MUI calls it as .onGUIInit). Silent installs (winget) never reach it and are unchanged.
;
; This file is read before the template's variables and defines exist, so it
; uses registers, literal names and its own version from the file header.
!insertmacro VersionCompare
!define MUI_CUSTOMFUNCTION_GUIINIT KinemaUpdateInPlace
Function KinemaUpdateInPlace
  ${GetOptions} $CMDLINE "/UPDATE" $0
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  ${GetOptions} $CMDLINE "/P" $0
  ${IfNot} ${Errors}
    Return
  ${EndIf}
  ReadRegStr $2 HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\Kinema" "DisplayVersion"
  ${If} $2 == ""
    Return
  ${EndIf}
  GetDLLVersion "$EXEPATH" $0 $1
  IntOp $3 $0 >> 16
  IntOp $4 $0 & 0xFFFF
  IntOp $5 $1 >> 16
  ${VersionCompare} "$3.$4.$5" "$2" $0
  ${If} $0 = 1
    Exec '"$EXEPATH" /P /UPDATE /R'
    Quit
  ${EndIf}
FunctionEnd
