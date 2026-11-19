// The desktop owns this server. -N is client-only; combining it with -S keeps the option/value pair.
export const DESKTOP_TMUX_SOCKET_FLAG = "-NS";

export interface DesktopTmuxMigration {
  requestedSource?: "desktop";
  migrationPending?: boolean;
  blockingSessions?: readonly string[];
}

/** A view may still attach to the old server. Neither the CLI nor the TUI initiates a switch. */
export function desktopTmuxMigrationNotes(selection?: DesktopTmuxMigration): string[] {
  if (selection?.requestedSource !== "desktop" || !selection.migrationPending) return [];
  if (!selection.blockingSessions?.length) return [
    "The desktop tmux switch is deferred: the previous server could not be inspected.",
    "Check rig terminal status --json and restore access to the previous socket before acting on any seats.",
    "Run rig daemon stop, then rig daemon start --desktop-tmux from a local macOS desktop terminal to inspect the previous server again.",
  ];
  return [
    "The desktop tmux switch is deferred: live seats still use the previous server.",
    "Opening a view on the previous server does not change the seat's startup context or desktop authentication.",
    "After approving downtime, check rig terminal status --json and stop the affected rigs with rig down <rig>.",
    "If down releases a claimed session, have its owner stop it. Run rig down <rig> again on the previous server and confirm the stop was recorded.",
    "Run rig daemon stop, then rig daemon start --desktop-tmux from a local macOS desktop terminal. Verify the selection before rig up <rig> --existing.",
  ];
}

/** tmux 3.3a–3.6 inherits its creating client's limits. This runs in that child only:
 * never lower an already higher soft limit, change the hard limit, or restart a server. */
export const TMUX_SERVER_LIMIT_WARNING = "[tmux] Could not raise the open-file limit for a new terminal server; continuing with the inherited limit.";
export const TMUX_SERVER_LIMIT_PREFIX = `
openrig_tmux_nofile() {
  openrig_tmux_soft=$(ulimit -S -n) || return 1
  case "$openrig_tmux_soft" in unlimited) return 0;; ''|*[!0-9]*) return 1;; esac
  openrig_tmux_hard=$(ulimit -H -n) || return 1
  openrig_tmux_target=8192
  case "$openrig_tmux_hard" in
    unlimited) ;;
    ''|*[!0-9]*) return 1;;
    *) if [ "$openrig_tmux_hard" -lt "$openrig_tmux_target" ]; then openrig_tmux_target=$openrig_tmux_hard; fi;;
  esac
  [ "$openrig_tmux_soft" -ge "$openrig_tmux_target" ] || ulimit -S -n "$openrig_tmux_target"
}
openrig_tmux_nofile 2>/dev/null || printf '%s\\n' '${TMUX_SERVER_LIMIT_WARNING}' >&2
`;

/** Production callers use full command names. A matching data argument merely gets the same harmless child limit. */
export function mayStartTmuxServer(args: readonly string[]): boolean {
  return args[0] !== DESKTOP_TMUX_SOCKET_FLAG && args.some(arg => ["new-session", "start-server", "attach-session", "-D"].includes(arg));
}

export function tmuxServerStartCommand(file: string, args: string[]): { file: string; args: string[] } {
  if (process.platform === "win32" || !mayStartTmuxServer(args)) return { file, args };
  return { file: "/bin/sh", args: ["-c", TMUX_SERVER_LIMIT_PREFIX + 'exec "$0" "$@"', file, ...args] };
}

let warned = false;
/** execFile captures stderr even on success; surface this advisory once per process. */
export function reportTmuxServerLimit(stderr: unknown): void {
  if (!warned && String(stderr ?? "").includes(TMUX_SERVER_LIMIT_WARNING)) {
    warned = true;
    console.warn(TMUX_SERVER_LIMIT_WARNING);
  }
}
