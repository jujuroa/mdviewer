; Custom NSIS steps for MD Viewer:
;  1. Add the install directory to the current user's PATH, so `mdviewer`
;     can be run from a shell (e.g. `mdviewer .` to open the current folder).
;  2. Register Explorer "Open with MD Viewer" context menu entries for
;     folders and .md/.markdown files.
;
; This is a per-user install (perMachine: false), so everything below is
; scoped to the current user (HKCU) and requires no elevation. PATH edits are
; done with plain NSIS string ops (no PowerShell/subprocess): on some locked
; -down machines, spawning powershell.exe for something this small can get
; stuck for a long time behind endpoint-security script scanning, which would
; stall the installer/uninstaller.

Var RDFP_Target
Var RDFP_Src
Var RDFP_Result
Var RDFP_Token
Var RDFP_Char
Var RDFP_Idx
Var RDFP_TokStart
Var RDFP_TokLen

; Removes every exact "$RDFP_Target" entry from the semicolon-delimited
; "$RDFP_Src" list, returning the cleaned string in $RDFP_Result. Also
; collapses empty entries (e.g. from "a;;b").
!macro RemoveDirFromPathListImpl
  StrCpy $RDFP_Char $RDFP_Src 1 -1
  StrCmp $RDFP_Char ";" RDFP_have_trailing_semi
    StrCpy $RDFP_Src "$RDFP_Src;"
  RDFP_have_trailing_semi:

  StrCpy $RDFP_Result ""
  StrCpy $RDFP_TokStart 0
  StrCpy $RDFP_Idx 0

  RDFP_loop:
    StrCpy $RDFP_Char $RDFP_Src 1 $RDFP_Idx
    StrCmp $RDFP_Char "" RDFP_done
    StrCmp $RDFP_Char ";" 0 RDFP_advance

    IntOp $RDFP_TokLen $RDFP_Idx - $RDFP_TokStart
    StrCpy $RDFP_Token $RDFP_Src $RDFP_TokLen $RDFP_TokStart
    StrCmp $RDFP_Token $RDFP_Target RDFP_skip_token
    StrCmp $RDFP_Token "" RDFP_skip_token
    StrCmp $RDFP_Result "" RDFP_first_token
      StrCpy $RDFP_Result "$RDFP_Result;$RDFP_Token"
      Goto RDFP_skip_token
    RDFP_first_token:
      StrCpy $RDFP_Result $RDFP_Token
    RDFP_skip_token:
    IntOp $RDFP_TokStart $RDFP_Idx + 1

    RDFP_advance:
    IntOp $RDFP_Idx $RDFP_Idx + 1
    Goto RDFP_loop

  RDFP_done:
!macroend

!macro customInstall
  DetailPrint "Adding $INSTDIR to PATH"
  ReadRegStr $RDFP_Src HKCU "Environment" "Path"
  StrCpy $RDFP_Target "$INSTDIR"
  ; Remove any existing occurrence first (covers repair/upgrade installs)
  ; then append fresh, so we never end up with duplicate entries.
  !insertmacro RemoveDirFromPathListImpl
  ${If} $RDFP_Result == ""
    WriteRegExpandStr HKCU "Environment" "Path" "$INSTDIR"
  ${Else}
    WriteRegExpandStr HKCU "Environment" "Path" "$RDFP_Result;$INSTDIR"
  ${EndIf}
  ; Deliberately not broadcasting WM_SETTINGCHANGE here: SendMessageTimeout
  ; against HWND_BROADCAST waits on every top-level window in turn, and on a
  ; machine with many windows open that can take minutes even with a short
  ; per-window timeout. New shells read the registry directly at process
  ; start regardless, so this is only a minor convenience (already-open
  ; windows picking up the change without a restart) not worth that risk.

  DetailPrint "Registering Explorer context menu entries"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\shell\MDViewer" "" "Open with MD Viewer"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\shell\MDViewer" "Icon" "$appExe"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\shell\MDViewer\command" "" '"$appExe" "%1"'

  WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\Background\shell\MDViewer" "" "Open with MD Viewer"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\Background\shell\MDViewer" "Icon" "$appExe"
  WriteRegStr SHELL_CONTEXT "Software\Classes\Directory\Background\shell\MDViewer\command" "" '"$appExe" "%V"'

  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.md\shell\MDViewer" "" "Open with MD Viewer"
  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.md\shell\MDViewer" "Icon" "$appExe"
  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.md\shell\MDViewer\command" "" '"$appExe" "%1"'

  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.markdown\shell\MDViewer" "" "Open with MD Viewer"
  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.markdown\shell\MDViewer" "Icon" "$appExe"
  WriteRegStr SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.markdown\shell\MDViewer\command" "" '"$appExe" "%1"'

  ; Deliberately not calling SHChangeNotify here either: on this class of
  ; machine, any API that waits on the shell to acknowledge a broadcast has
  ; been observed to hang for a very long time (see the WM_SETTINGCHANGE
  ; note above). Explorer resolves right-click verbs live from the registry
  ; on each invocation rather than caching them, so skipping the notify still
  ; leaves the new menu entries working immediately.
!macroend

!macro customUnInstall
  DetailPrint "Removing $INSTDIR from PATH"
  ReadRegStr $RDFP_Src HKCU "Environment" "Path"
  StrCpy $RDFP_Target "$INSTDIR"
  !insertmacro RemoveDirFromPathListImpl
  WriteRegExpandStr HKCU "Environment" "Path" "$RDFP_Result"
  ; See customInstall for why we don't broadcast WM_SETTINGCHANGE here.

  DetailPrint "Removing Explorer context menu entries"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Directory\shell\MDViewer"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\Directory\Background\shell\MDViewer"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.md\shell\MDViewer"
  DeleteRegKey SHELL_CONTEXT "Software\Classes\SystemFileAssociations\.markdown\shell\MDViewer"

  ; Deliberately not calling SHChangeNotify here either: on this class of
  ; machine, any API that waits on the shell to acknowledge a broadcast has
  ; been observed to hang for a very long time (see the WM_SETTINGCHANGE
  ; note above). Explorer resolves right-click verbs live from the registry
  ; on each invocation rather than caching them, so skipping the notify still
  ; leaves the new menu entries working immediately.
!macroend
