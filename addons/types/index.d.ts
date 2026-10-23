// Types for the MD Viewer add-on API (`window.mdviewerAddon`), API version 1
// (protocol: .lab/addon/03-protocol.md, sections 7–13). Reference this file
// from an add-on's jsconfig.json or tsconfig.json ("include") or with
//   /// <reference path=".../addons/types/index.d.ts" />
// Every method returns a Promise that rejects with an AddonError.

declare namespace MdviewerAddon {
  /** The protocol's error (8.5). */
  interface AddonError {
    code: number;
    name:
      | 'InvalidParams'
      | 'InternalError'
      | 'RequestCancelled'
      | 'PermissionDenied'
      | 'NotFound'
      | 'Conflict'
      | 'UserCanceled'
      | 'OutsideProject'
      | 'NotSupported'
      | 'TooLarge';
    message: string;
    data?: unknown;
  }

  type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

  interface Disposable {
    dispose(): void;
  }

  // ---- app (9, 13.10) ----

  interface FrameInfo {
    kind: 'tab' | 'pane' | 'background';
    /** The contributed tab's id (contributes.tabs[].id); tab frames only. */
    tabId?: string | null;
    /** This tab's instance (what tabs.open returns); tab frames only. */
    instanceId?: number | null;
  }

  interface AppInfo {
    apiVersion: 1;
    version: string;
    locale: string;
    theme: 'light' | 'dark';
    platform: string;
    /** Area versions this app has (5.1); check before using a newer method. */
    capabilities: Record<string, number>;
    /** The experimental APIs open to this add-on (5.4). */
    experimentalApi: string[];
    resources: { threadBudget: number };
    addon: { id: string; version: string };
    frame: FrameInfo;
    grantedPermissions: string[];
    activationEvent: string | null;
  }

  interface AppArea extends AppInfo {
    /** Opens an https or mailto address in the default program, after the user agrees. */
    openExternal(params: { url: string }): Promise<null>;
    copyToClipboard(params: { text: string }): Promise<null>;
  }

  // ---- workspace, documents, editor (13.1–13.3) ----

  interface Position {
    /** From 0. */
    line: number;
    /** From 0, in UTF-16 code units. */
    character: number;
  }

  interface Range {
    start: Position;
    end: Position;
  }

  interface WorkspaceArea {
    projects(): Promise<{ root: string; name: string; active: boolean }[]>;
    /** Needs documents.read. */
    listFiles(params: { root: string; extensions?: string[] }): Promise<{ path: string; size: number; mtimeMs: number }[]>;
    openDocument(params: { path: string; line?: number }): Promise<null>;
  }

  interface DocumentsArea {
    /** Needs documents.read. The text being edited if the document is open, unsaved changes included. */
    read(params: { path: string }): Promise<{ path: string; text: string; version: string; dirty: boolean }>;
    /** Needs documents.read. The document on screen in this window, or null. */
    active(): Promise<{ path: string; version: string; editMode: boolean } | null>;
    /** Experimental: documents.sync. Needs documents.write. */
    save?(params?: { paths?: string[] }): Promise<{ path: string; status: string; version?: string }[]>;
    /** Experimental: documents.sync. Needs documents.read. */
    reload?(params?: { paths?: string[]; ifDirty?: 'skip' | 'ask' }): Promise<{ path: string; status: string; version?: string }[]>;
  }

  interface EditorArea {
    /** Needs documents.read. */
    selection(): Promise<{ path: string; range: Range; text: string; version: string; source: 'editor' | 'viewer' } | null>;
  }

  // ---- edit (13.4) ----

  type EditOperation =
    | { kind: 'change'; path: string; baseVersion: string; changes: { range: Range; newText: string }[] }
    | { kind: 'create'; path: string; text: string }
    | { kind: 'rename'; from: string; to: string }
    | { kind: 'delete'; path: string };

  interface EditArea {
    /**
     * Needs documents.write. Shown on the comparison screen, then applied all
     * or nothing. confirm "auto" skips the screen only when the user allows
     * it, never for rename or delete.
     */
    apply(params: { label?: string; confirm?: 'always' | 'auto'; operations: EditOperation[] }): Promise<{ applied: true } | { applied: false; reason: 'rejected' }>;
  }

  // ---- ui (13.5) ----

  interface UiArea {
    /** Resolves to the action clicked, or null. */
    notify(params: { level?: 'info' | 'warning' | 'error'; message: string; actions?: string[] }): Promise<string | null>;
    /** The picked id (ids with multi); rejects with UserCanceled. */
    quickPick(params: { title?: string; placeholder?: string; items: { id: string; label: string; detail?: string }[]; multi?: false }): Promise<string>;
    quickPick(params: { title?: string; placeholder?: string; items: { id: string; label: string; detail?: string }[]; multi: true }): Promise<string[]>;
    /** Rejects with UserCanceled. */
    input(params: { title?: string; prompt?: string; value?: string; password?: boolean }): Promise<string>;
    confirm(params: { message: string; detail?: string; okLabel?: string }): Promise<boolean>;
    progress: {
      start(params: { title: string; cancellable?: boolean; location?: 'status' | 'dialog' }): Promise<{ token: string }>;
      /** cancelled: the user pressed Cancel; stop and call end. */
      report(params: { token: string; message?: string; percent?: number }): Promise<{ cancelled: boolean }>;
      end(params: { token: string }): Promise<null>;
    };
  }

  // ---- tabs (7.5, 13.6) ----

  interface RestoreState {
    reason: 'new' | 'moved' | 'reloaded' | 'restored';
    /** The snapshot (lifecycle.onSnapshot) or, after a relaunch, tabs.setState's value. */
    state: Json | null;
  }

  interface TabsArea {
    open(params: { tabId: string; args?: Json; reveal?: boolean }): Promise<{ instanceId: number }>;
    close(params: { tabId: string; instanceId?: number }): Promise<null>;
    reveal(params: { tabId: string; instanceId?: number }): Promise<null>;
    /** This tab's own strip entry. dirty: the user is asked before it closes. */
    update(params: { title?: string | null; icon?: string | null; dirty?: boolean }): Promise<null>;
    /** At most 64 KiB of JSON, kept for after a relaunch. */
    setState(params: { state: Json | null }): Promise<null>;
    getState(): Promise<Json | null>;
    /** Synchronous: why this page loaded, and what it gets back. */
    getRestoreState(): RestoreState;
    /** Synchronous: the args tabs.open was given for this tab. */
    getArgs(): Json | null;
  }

  // ---- secrets, settings, context (13.7–13.9) ----

  interface SecretsArea {
    get(params: { key: string }): Promise<string | null>;
    set(params: { key: string; value: string }): Promise<null>;
    delete(params: { key: string }): Promise<null>;
  }

  interface SettingsArea {
    /** One setting (contributes.settings), or all of them without key. */
    get(params: { key: string }): Promise<Json>;
    get(params?: {}): Promise<Record<string, Json>>;
    update(params: { key: string; value: Json }): Promise<null>;
  }

  interface ContextArea {
    /** For when conditions, as <add-on id>.<key>. null clears it. */
    set(params: { key: string; value: string | number | boolean | null }): Promise<null>;
  }

  // ---- storage (13.13) ----

  type StorageScope = { scope: 'global' } | { scope: 'project'; root: string };

  interface StorageArea {
    readFile(params: StorageScope & { path: string; encoding?: 'utf8' }): Promise<string>;
    readFile(params: StorageScope & { path: string; encoding: 'binary' }): Promise<Uint8Array>;
    /** Written whole or not at all; at most 64 MiB. */
    writeFile(params: StorageScope & { path: string; data: string | Uint8Array }): Promise<null>;
    list(params: StorageScope & { path?: string }): Promise<{ name: string; kind: 'file' | 'dir'; size: number; mtime: number }[]>;
    /** Without path, the whole scope. */
    delete(params: StorageScope & { path?: string }): Promise<null>;
    /** Real folders, only to hand to an external program. */
    paths(params?: { root?: string }): Promise<{ global: string; project?: string }>;
  }

  // ---- messaging (13.14) ----

  interface MessageFrom {
    kind: 'tab' | 'pane' | 'background';
    tabId?: string | null;
    instanceId?: number;
  }

  interface MessagingArea {
    /** To the add-on's other frames that are running (the sender left out). */
    post(params: { to: 'background' | 'tabs' | 'all'; message: Json }): Promise<null>;
    /** The background frame's answer (it is started if need be). */
    request(params: { to: 'background'; message: Json }): Promise<Json>;
    /** A request is answered by the first handler that returns something other than undefined. */
    onMessage(handler: (message: Json, from: MessageFrom) => unknown): Disposable;
  }

  // ---- the page's own (7.4–7.6) ----

  interface Api {
    app: AppArea;
    workspace: WorkspaceArea;
    documents: DocumentsArea;
    editor: EditorArea;
    edit: EditArea;
    ui: UiArea;
    tabs: TabsArea;
    secrets: SecretsArea;
    settings: SettingsArea;
    context: ContextArea;
    storage: StorageArea;
    messaging: MessagingArea;
    /** Any method by its protocol name, e.g. call('documents/read', { path }). */
    call(method: string, params?: object): Promise<unknown>;
    /** The page has set up what it handles (within 10 s of loading). */
    ready(): void;
    commands: {
      /** Handles a command of contributes.commands run in this frame. */
      register(command: string, handler: (ctx: Record<string, unknown>) => unknown): Disposable;
    };
    lifecycle: {
      /** Before the tab moves or reloads: what to get back (2 s, at most 1 MiB of JSON). */
      onSnapshot(handler: () => Json | Promise<Json>): void;
      /** Before the frame closes (3 s at most; it cannot be refused). */
      onWillClose(handler: () => void | Promise<void>): void;
    };
  }
}

interface Window {
  /** Present in an add-on's frames only. */
  readonly mdviewerAddon: MdviewerAddon.Api;
}

declare const mdviewerAddon: MdviewerAddon.Api;
