import { release } from "node:os";
import { posix } from "node:path";
import { setTimeout as wait } from "node:timers/promises";
import { terminalAuthHeaders, type DaemonClient } from "./client.js";
import type { OpenViewResult } from "./commands/terminal.js";
import { shellQuote } from "./cross-host-executor.js";
import { defaultWindowDeps, type WindowDeps } from "./terminal-window.js";
import { isLocalTmuxHost } from "./tmux-attachment.js";

interface OrcaReply<T> { ok: boolean; _meta?: { runtimeId?: string }; result?: T }
interface Workspace { id: string; path?: string; hostId?: string; identity?: { key?: string; executionHostId?: string } }
interface Terminal {
  handle: string; tabId: string; worktreeId: string; worktreePath?: string; connected?: boolean; orphaned?: boolean;
  executionHostId?: string; hostPlatform?: string;
}
interface Tile { seat: string; paneCommand: string; host?: string }
interface Preview {
  composed: { pages: Tile[][]; columns?: number; absent: OpenViewResult["absent"]; degraded: OpenViewResult["degraded"] };
}

interface WslCaller { distro: string; uid: number; terminal: string; workspace: string }
const WSL_SHELL_CAPABILITY = "terminal.create-shell-selection.v1";
const TILE_EXEC = "exec /usr/bin/env -u TMUX -u TMUX_PANE";

export type OrcaDeps = Pick<WindowDeps, "platform" | "env" | "exec"> & { kernelRelease?: string; uid?: number };

/** A Windows-drive path is not a pinned WSL workspace, even if accessed via a distro's /mnt/c. */
function inWslDistro(path: string | undefined, distro: string): boolean {
  const match = /^\/\/(?:wsl\.localhost|wsl\$)\/([^/]+)(\/.*)?$/i.exec(path?.replaceAll("\\", "/") ?? "");
  return !!match && match[1]!.toLowerCase() === distro.toLowerCase() && !/^\/mnt\/[a-z](?:\/|$)/i.test(match[2] ?? "");
}

function tileCommand(pane: Tile, wsl?: WslCaller): string {
  if (!wsl) return `${TILE_EXEC} ${pane.paneCommand}`;
  // The CLI serializes through Windows interop. Keep the POSIX script opaque across that boundary,
  // and have every pane check its distro and user before doing anything with tmux. Split has no --shell flag.
  const script = `if [ "\${WSL_DISTRO_NAME-}" != ${shellQuote(wsl.distro)} ] || [ "$(/usr/bin/id -u)" != ${wsl.uid} ]; then\n`
    + `  /usr/bin/printf '%s\\n' 'OpenRig: wrong WSL distribution or user; no tmux attachment.' >&2; exit 1\nfi\nexec ${pane.paneCommand}`;
  const payload = Buffer.from(script, "utf8").toString("base64");
  return `${TILE_EXEC} /bin/sh -c 'script=$(/usr/bin/printf %s "$1" | /usr/bin/base64 -d) && exec /bin/sh -c "$script"' openrig-orca ${payload}`;
}

/** CLI-local: the daemon only composes the view. It cannot launch terminals in an Orca profile. */
export async function openOrcaView(client: DaemonClient, view: string, selector?: string, deps: OrcaDeps = defaultWindowDeps()): Promise<OpenViewResult> {
  const result: OpenViewResult = { provider: "orca", ok: false, opened: [], remote: [], absent: [], degraded: [], pages: 0 };
  const fail = (code: string, error: string) => ({ ...result, code, error });
  if (deps.platform !== "darwin" && deps.platform !== "linux") {
    return fail("orca_unsupported_platform", "Use the Mac or Linux desktop, or run OpenRig inside an Orca-managed WSL2 terminal on Windows. Native Windows is not supported.");
  }
  const env = deps.env;
  const caller = env.ORCA_WORKSPACE_ID?.trim() || env.ORCA_WORKTREE_ID?.trim();
  const kernel = deps.platform === "linux" ? (deps.kernelRelease ?? release()) : "";
  const wslLike = deps.platform === "linux" && (/microsoft|wsl/i.test(kernel) || env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  const override = env.ORCA_CLI_COMMAND?.trim();
  let orca = override || (env.ORCA_DEV_REPO_ROOT ? "orca-dev" : deps.platform === "linux" ? "orca-ide" : "orca");
  let wsl: WslCaller | undefined;
  if (wslLike) {
    if (!/microsoft.*wsl2/i.test(kernel)) return fail("orca_wsl2_required", "An identifiable WSL2 kernel is required for the Windows Orca bridge.");
    const distro = env.WSL_DISTRO_NAME;
    const dir = env.ORCA_WSL_CLI_DIR;
    const terminal = env.ORCA_TERMINAL_HANDLE;
    const uid = deps.uid ?? process.getuid?.();
    // Orca supplies this directory inside the guest; its launcher pins the Windows user-data profile.
    if (!distro || !caller || !terminal || !/^term_[\w-]+$/.test(terminal) || uid === undefined || !dir || !posix.isAbsolute(dir)
      || (override !== "orca-ide" && override !== "orca-dev")) {
      return fail("orca_wsl_context_required", "Run this from an Orca-managed WSL2 terminal with Orca's managed CLI bridge available.");
    }
    orca = posix.join(dir, override);
    wsl = { distro, uid, terminal, workspace: caller };
  } else if (deps.platform === "linux" && (orca === "orca" || orca === "/usr/bin/orca")) {
    return fail("orca_cli_unsafe", "Use Orca IDE's orca-ide launcher on Linux; orca may be the GNOME screen reader.");
  }
  const target = selector === undefined ? (caller?.startsWith("folder:") ? caller : caller && `id:${caller}`) : selector.trim();
  if (!target) return fail("orca_workspace_required", "Run inside an Orca terminal or pass --orca-workspace <selector>.");

  // The preview includes shell commands. Require the selected local daemon's identity, not merely a loopback URL.
  if (!isLocalTmuxHost(client.baseUrl) || !await client.isLocalInstance()) {
    return fail("orca_local_daemon_required", "Open Orca views on the machine running this OpenRig instance, using its OpenRig home.");
  }
  const preview = await client.get<Preview | OpenViewResult>(`/api/terminal/preview?view=${encodeURIComponent(view)}&provider=herdr`, { headers: terminalAuthHeaders() });
  if (preview.status >= 400 || !preview.data || !("composed" in preview.data)) {
    return fail("orca_preview_failed", (preview.data as OpenViewResult | undefined)?.error ?? "The daemon did not return a terminal view.");
  }
  // The ordinary desktop launcher uses this same provider-neutral preview even when Herdr is absent.
  const { composed } = preview.data;
  result.absent.push(...composed.absent);
  result.degraded.push(...composed.degraded);
  const pages = composed.pages.map(page => page.filter(pane => {
    if (!pane.host) return true;
    result.degraded.push({ seat: pane.seat, host: pane.host, reason: "The experimental Orca provider does not open remote seats." });
    return false;
  })).filter(page => page.length > 0);
  if (!pages.length) return fail("orca_no_local_tiles", "No local conversations are attachable.");

  let runtimeId: string | undefined;
  let interrupted = false;
  const openTimeout = wsl ? 25_000 : 15_000;
  // WSL invokes the desktop CLI through PowerShell; allow for its startup without retrying writes.
  async function call<T>(args: string[], timeoutMs = wsl ? 8_000 : 4_000): Promise<T> {
    const reply = JSON.parse(await deps.exec(orca, [...args, "--environment", "local", "--json"], timeoutMs)) as OrcaReply<T>;
    const actual = reply._meta?.runtimeId;
    if (runtimeId && actual !== runtimeId) {
      interrupted = true;
      throw new Error("Orca runtime changed or could not be confirmed");
    }
    if (!reply.ok || !reply.result || !actual) throw new Error("Orca reply unconfirmed");
    runtimeId = actual;
    return reply.result;
  }
  try {
    const status = await call<{ app?: { running?: boolean; desktopWindowStatus?: string }; runtime?: { reachable?: boolean; capabilities?: string[] } }>(["status"]);
    if (!status.app?.running || status.app.desktopWindowStatus !== "available" || !status.runtime?.reachable) throw new Error("No Orca desktop");
    if (wsl && !status.runtime.capabilities?.includes(WSL_SHELL_CAPABILITY)) {
      return fail("orca_wsl_shell_unsupported", "Update Orca on Windows: its CLI must be able to explicitly select a WSL shell.");
    }
  } catch {
    return fail("orca_unavailable", "The local Orca desktop did not answer. Open Orca and make its CLI available before retrying.");
  }
  if (wsl) {
    try {
      const { terminal } = await call<{ terminal: Terminal }>(["terminal", "show", "--terminal", wsl.terminal]);
      if (terminal.handle !== wsl.terminal || terminal.worktreeId !== wsl.workspace || terminal.connected !== true
        || terminal.executionHostId !== "local" || !inWslDistro(terminal.worktreePath, wsl.distro)) throw new Error("Orca WSL caller unconfirmed");
    } catch {
      return fail("orca_wsl_caller_unconfirmed", "Orca did not confirm the calling terminal in a workspace inside this WSL2 distribution.");
    }
  }
  let workspace: Workspace | undefined;
  try { ({ worktree: workspace } = await call<{ worktree?: Workspace }>(["worktree", "show", "--worktree", target])); }
  catch { return fail("orca_workspace_unavailable", `Orca could not resolve the destination workspace. Pass an exact selector from \`${deps.platform === "linux" ? "orca-ide" : "orca"} worktree ps --json\`.`); }
  const workspaceId = workspace?.id;
  const identity = workspace?.identity;
  const host = identity?.executionHostId ?? workspace?.hostId;
  if (!workspaceId || host !== "local" || (workspace?.hostId !== undefined && workspace.hostId !== "local")) {
    return fail("orca_workspace_not_local", "The destination must be an existing local Orca workspace.");
  }
  if (wsl && !inWslDistro(workspace?.path, wsl.distro)) {
    return fail("orca_workspace_wrong_distro", "Choose an Orca workspace inside the calling WSL2 distribution, not another distro or a Windows drive.");
  }
  // Non-Git projects may have a host id and a canonical id, but no Git identity key.
  const exact = workspaceId.startsWith("folder:") ? workspaceId : identity?.key ? `identity:${identity.key}` : `id:${workspaceId}`;
  // Titles are only for display and recovery, never used to choose a pane or workspace.
  const label = `OpenRig: ${view.replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 100)}`;
  const confirmed = new Set<Tile>();
  const notes: string[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    const title = pages.length === 1 ? label : `${label} (${pageIndex + 1}/${pages.length})`;
    const handles = new Map<number, string>();
    let tabId: string | undefined;
    const columns = Math.min(page.length, composed.columns || Math.ceil(Math.sqrt(page.length)));
    const indices = page.map((_, index) => index);
    // Establish rows first; splitting each row then keeps the columns within that row.
    const order = [...indices.filter(i => i % columns === 0), ...indices.filter(i => i % columns !== 0)];
    for (const index of order) {
      const pane = page[index]!;
      if (interrupted) {
        result.degraded.push({ seat: pane.seat, host: "local", reason: "Not attempted after an unconfirmed Orca operation." });
        continue;
      }
      const command = tileCommand(pane, wsl);
      try {
        let handle: string;
        if (index === 0) {
          const shell = wsl ? ["--shell", "wsl.exe"] : [];
          const { terminal } = await call<{ terminal: Terminal }>(["terminal", "create", "--worktree", exact, "--title", title, ...shell, "--command", command], openTimeout);
          if (terminal.worktreeId !== workspaceId || !terminal.tabId || (terminal.executionHostId !== undefined && terminal.executionHostId !== "local")
            || (wsl ? terminal.hostPlatform !== "linux" : terminal.hostPlatform !== undefined && terminal.hostPlatform !== deps.platform)) throw new Error("Orca tab unconfirmed");
          ({ tabId, handle } = terminal);
        } else {
          const across = index % columns !== 0;
          const anchor = handles.get(index - (across ? 1 : columns));
          if (!anchor) throw new Error("Orca split anchor unconfirmed");
          const { split } = await call<{ split: Pick<Terminal, "handle" | "tabId"> }>(["terminal", "split", "--terminal", anchor, "--direction", across ? "horizontal" : "vertical", "--command", command], openTimeout);
          if (split.tabId !== tabId) throw new Error("Orca split unconfirmed");
          handle = split.handle;
        }
        if (!/^term_[\w-]+$/.test(handle) || [...handles.values()].includes(handle)) throw new Error("Orca terminal handle unconfirmed");
        handles.set(index, handle);
      } catch {
        interrupted = true;
        result.degraded.push({ seat: pane.seat, host: "local", code: "pane_unconfirmed", reason: "Orca did not confirm this tab or split; it may still have been created." });
        notes.push(`Inspect the Orca workspace for ${JSON.stringify(title)} before retrying. No command was retried.`);
      }
    }
    let placed = false;
    for (const [index, handle] of handles) {
      const pane = page[index]!;
      try {
        async function connected(): Promise<boolean> {
          // `show` may include a terminal output preview. Inspect only identity and connection fields.
          const { terminal } = await call<{ terminal: Terminal }>(["terminal", "show", "--terminal", handle]);
          if (terminal.handle !== handle || terminal.worktreeId !== workspaceId || terminal.tabId !== tabId
            || (terminal.executionHostId !== undefined && terminal.executionHostId !== "local")
            || (wsl && !inWslDistro(terminal.worktreePath, wsl.distro))) throw new Error("Orca pane identity changed");
          return terminal.connected === true && terminal.orphaned === false;
        }
        if (!await connected()) {
          // Splitting can remount an existing pane; allow its renderer to reconnect. Only retry the read.
          await wait(250);
          if (!await connected()) throw new Error("Orca pane not connected");
        }
        confirmed.add(pane);
        placed = true;
      } catch {
        result.degraded.push({ seat: pane.seat, host: "local", code: "pane_unconfirmed", reason: `Orca did not confirm a connected pane for ${handle}; inspect ${JSON.stringify(title)} before retrying.` });
      }
    }
    if (placed) result.pages++;
  }
  result.opened = pages.flat().filter(pane => confirmed.has(pane)).map(pane => pane.seat);
  result.ok = result.opened.length > 0;
  result.workspaceId = workspaceId;
  if (result.ok) notes.push("Connected Orca panes were confirmed. Check them in Orca to verify the seat view; no tab was explicitly focused.");
  if (notes.length) result.notes = notes;
  return result.ok ? result : fail(interrupted ? "orca_outcome_unknown" : "orca_panes_unconfirmed", "No connected Orca panes could be confirmed.");
}
