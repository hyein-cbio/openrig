import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DaemonClient } from "../src/client.js";
import { terminalCommand, type TerminalDeps } from "../src/commands/terminal.js";
import { openOrcaView, type OrcaDeps } from "../src/terminal-orca.js";

vi.mock("../src/daemon-lifecycle.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/daemon-lifecycle.js")>(),
  getDaemonStatus: async () => ({ state: "running", healthy: true, pid: 1234, port: 7433 }),
  getDaemonUrl: () => "http://localhost:7433",
}));

const pane = (name: string, host?: string) => ({ seat: `${name}@demo`, paneCommand: `tmux -S '/tmp/rig socket' attach -r -t '=${name}@demo'`, host });
const command = (name: string) => `exec /usr/bin/env -u TMUX -u TMUX_PANE ${pane(name).paneCommand}`;
const workspaceId = "repo::/work/project";
const localView = [[pane("a"), pane("b"), pane("c"), pane("d")]];
const wslPath = String.raw`\\wsl.localhost\Ubuntu-24.04\home\dev\project`;
const wslId = `repo::${wslPath}`;
const wslEnv = { WSL_DISTRO_NAME: "Ubuntu-24.04", ORCA_WORKTREE_ID: wslId, ORCA_TERMINAL_HANDLE: "term_caller",
  ORCA_CLI_COMMAND: "orca-ide", ORCA_WSL_CLI_DIR: "/mnt/c/Users/Test User/orca/wsl-managed-cli/example" };

interface WslFixture { workspacePath?: string; callerPath?: string; callerId?: string; shellSupport?: boolean; createdPlatform?: string }
interface Options {
  pages?: typeof localView; host?: string; baseUrl?: string; local?: boolean; env?: NodeJS.ProcessEnv;
  id?: string; noWorkspace?: boolean; noIdentity?: boolean; noDesktop?: boolean; splitTimeout?: boolean; switchRuntime?: boolean;
  disconnected?: boolean; remount?: boolean; platform?: OrcaDeps["platform"]; kernelRelease?: string; uid?: number; wsl?: WslFixture;
}

function fixture({ pages = localView, host = "local", baseUrl = "http://localhost:7433", local = true,
  env = { ORCA_WORKTREE_ID: workspaceId, ORCA_CLI_COMMAND: "/Applications/Orca Dev.app/bin/orca", ORCA_USER_DATA_PATH: "/profiles/dev" },
  id = workspaceId, noWorkspace = false, noIdentity = false, noDesktop = false, splitTimeout = false, switchRuntime = false,
  disconnected = false, remount = false, platform = "darwin", kernelRelease, uid, wsl,
}: Options = {}) {
  const absent = [{ seat: "stopped@demo", host: null, reason: "stopped" }];
  const get = vi.fn(async () => ({ status: 200, data: {
    composed: { pages, absent, degraded: [{ seat: "http@demo", host: "http", reason: "requires SSH" }] },
  } }));
  const isLocalInstance = vi.fn(async () => local);
  const client = { baseUrl, get, isLocalInstance } as unknown as DaemonClient;
  let tab = 0;
  let count = 0;
  let showedFirstPane = false;
  const handles = new Map<string, string>();
  const exec = vi.fn(async (_file: string, args: string[]) => {
    function reply(result: unknown, runtimeId = "orca-dev-runtime") { return JSON.stringify({ ok: true, result, _meta: { runtimeId } }); }
    const [group, verb] = args;
    if (group === "status") return reply({ app: { running: true, desktopWindowStatus: noDesktop ? "openable" : "available" },
      runtime: { reachable: true, capabilities: wsl && wsl.shellSupport !== false ? ["terminal.create-shell-selection.v1"] : [] } });
    if (group === "worktree") {
      if (noWorkspace) throw new Error("target not found");
      return reply({ worktree: { id, path: wsl ? wsl.workspacePath ?? wslPath : "/work/project", hostId: host,
        ...(noIdentity || id.startsWith("folder:") ? {} : { identity: { key: "identity-key", executionHostId: host } }) } });
    }
    if (verb === "create" || verb === "split") {
      if (verb === "create") tab++;
      if (verb === "split" && splitTimeout) throw new Error("timed out after submission");
      const handle = `term_${++count}`;
      const tabId = `tab-${tab}`;
      handles.set(handle, tabId);
      return reply(verb === "create" ? { terminal: { handle, tabId, worktreeId: id, executionHostId: host, hostPlatform: wsl?.createdPlatform ?? platform } } : { split: { handle, tabId } },
        verb === "split" && switchRuntime ? "other-runtime" : undefined);
    }
    if (verb === "show") {
      const handle = args[3]!;
      if (wsl && handle === "term_caller") return reply({ terminal: { handle, worktreeId: wsl.callerId ?? wslId,
        worktreePath: wsl.callerPath ?? wslPath, executionHostId: "local", connected: true, orphaned: false } });
      const orphaned = disconnected || (remount && handle === "term_1" && !showedFirstPane);
      if (handle === "term_1") showedFirstPane = true;
      return reply({ terminal: { handle, tabId: handles.get(handle), worktreeId: id, worktreePath: wsl?.workspacePath ?? wslPath,
        connected: !disconnected, orphaned, executionHostId: host, preview: "never print terminal output" } });
    }
    throw new Error(`unexpected Orca method: ${group} ${verb}`);
  });
  const deps: OrcaDeps = { env, platform, kernelRelease, uid, exec };
  const commands = () => exec.mock.calls.map(([, argv]) => argv);
  const mutations = () => commands().filter(([, command]) => command === "create" || command === "split");
  return { client, get, isLocalInstance, deps, exec, commands, mutations, absent };
}

const originalExitCode = process.exitCode;
afterEach(() => { vi.restoreAllMocks(); process.exitCode = originalExitCode; });

describe("openOrcaView", () => {
  it("uses the caller's Orca runtime, splitting a new tab by row then column without changing the composed commands", async () => {
    const f = fixture();
    const result = await openOrcaView(f.client, "rig:demo", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, provider: "orca", workspaceId, opened: ["a@demo", "b@demo", "c@demo", "d@demo"], pages: 1, absent: f.absent });
    expect(JSON.stringify(result)).not.toContain("never print terminal output");
    expect(f.get).toHaveBeenCalledWith("/api/terminal/preview?view=rig%3Ademo&provider=herdr", expect.objectContaining({ headers: expect.any(Object) }));
    expect(f.exec.mock.calls.every(([file]) => file === f.deps.env.ORCA_CLI_COMMAND)).toBe(true);
    expect(f.commands().every(argv => argv.slice(-3).join(" ") === "--environment local --json")).toBe(true);
    expect(f.commands()[1]?.slice(0, 4)).toEqual(["worktree", "show", "--worktree", `id:${workspaceId}`]);
    expect(f.mutations().map(argv => argv.slice(0, -3))).toEqual([
      ["terminal", "create", "--worktree", "identity:identity-key", "--title", "OpenRig: rig:demo", "--command", command("a")],
      ["terminal", "split", "--terminal", "term_1", "--direction", "vertical", "--command", command("c")],
      ["terminal", "split", "--terminal", "term_1", "--direction", "horizontal", "--command", command("b")],
      ["terminal", "split", "--terminal", "term_2", "--direction", "horizontal", "--command", command("d")],
    ]);
  });

  it("uses explicit folder workspace and preserves page and remote-seat boundaries", async () => {
    const f = fixture({ id: "folder:demo", env: {}, pages: [[pane("first"), pane("distant", "ssh-host")], [pane("second")]] });
    const result = await openOrcaView(f.client, "demo", "path:/work/folder", f.deps);
    expect(f.commands()[1]?.[3]).toBe("path:/work/folder");
    expect(f.mutations().map(args => args.slice(1, 6))).toEqual([
      ["create", "--worktree", "folder:demo", "--title", "OpenRig: demo (1/2)"],
      ["create", "--worktree", "folder:demo", "--title", "OpenRig: demo (2/2)"],
    ]);
    expect(result).toMatchObject({ ok: true, pages: 2, opened: ["first@demo", "second@demo"], degraded: [
      { seat: "http@demo", host: "http" }, { seat: "distant@demo", host: "ssh-host" },
    ] });
  });

  it("pins a local non-Git project to its canonical id even without a Git identity", async () => {
    const f = fixture({ noIdentity: true, pages: [[pane("only")]] });
    await expect(openOrcaView(f.client, "demo", "path:/work/project", f.deps)).resolves.toMatchObject({ ok: true, opened: ["only@demo"] });
    expect(f.mutations()[0]?.[3]).toBe(`id:${workspaceId}`);
  });

  it.each([
    [{ env: {} }, "orca_workspace_required"],
    [{ baseUrl: "https://example.org:7433" }, "orca_local_daemon_required"],
    [{ local: false }, "orca_local_daemon_required"],
    [{ host: "ssh:other" }, "orca_workspace_not_local"],
    [{ id: "folder:remote", host: "ssh:other" }, "orca_workspace_not_local"],
    [{ noWorkspace: true }, "orca_workspace_unavailable"],
    [{ noDesktop: true }, "orca_unavailable"],
    [{ pages: [[pane("remote", "other")]] }, "orca_no_local_tiles"],
  ] as const)("opens nothing when the preflight refuses (%j)", async (options, code) => {
    const f = fixture({ ...options, ...("pages" in options ? { pages: options.pages.map(page => [...page]) } : {}) });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({ ok: false, code });
    expect(f.mutations()).toEqual([]);
  });

  it.each([{ splitTimeout: true }, { switchRuntime: true }])("does not retry or continue after an unconfirmed split (%j)", async options => {
    const f = fixture({ ...options, pages: [[pane("first"), pane("second")], [pane("third")]] });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({
      ok: true, opened: ["first@demo"], pages: 1, degraded: [
        { seat: "http@demo" }, { seat: "second@demo", code: "pane_unconfirmed" }, { seat: "third@demo", reason: expect.stringContaining("Not attempted") },
      ],
    });
    expect(f.mutations().map(([, op]) => op)).toEqual(["create", "split"]);
  });

  it("rechecks a pane remounted by splitting without creating another pane", async () => {
    const f = fixture({ remount: true, pages: [[pane("first"), pane("second")]] });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({ ok: true, opened: ["first@demo", "second@demo"] });
    expect(f.mutations()).toHaveLength(2);
    expect(f.commands().filter(([, op, , handle]) => op === "show" && handle === "term_1")).toHaveLength(2);
  });

  it("does not count an accepted but unconnected terminal as an opened tile", async () => {
    const f = fixture({ disconnected: true, pages: [[pane("only")]] });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({
      ok: false, opened: [], pages: 0, code: "orca_panes_unconfirmed",
      degraded: [{ seat: "http@demo" }, { seat: "only@demo", code: "pane_unconfirmed" }],
    });
  });
});

describe("Orca desktop on Linux and Windows", () => {
  const nativeLinux = "6.8.12-generic";
  const wsl2 = "6.6.87.2-microsoft-standard-WSL2";
  const wslFixture = (options: Options = {}) => fixture({ platform: "linux", kernelRelease: wsl2,
    uid: 1000, env: wslEnv, id: wslId, wsl: {}, pages: [[pane("a"), pane("b")]], ...options });
  const startupCommands = (f: ReturnType<typeof fixture>) => f.mutations().map(args => args[args.indexOf("--command") + 1]!);

  it("uses orca-ide on native Linux and does not insert a Windows shell option", async () => {
    const f = fixture({ platform: "linux", kernelRelease: nativeLinux, env: { ORCA_ENVIRONMENT: "other-server" } });
    await expect(openOrcaView(f.client, "demo", "path:/work/project", f.deps)).resolves.toMatchObject({ ok: true, pages: 1 });
    expect(f.exec.mock.calls.every(([file, args]) => file === "orca-ide" && args.includes("local"))).toBe(true);
    expect(f.mutations().every(args => !args.includes("--shell"))).toBe(true);
  });

  it("honors a pinned Linux Orca launcher path even if its basename is orca", async () => {
    const executable = "/home/dev/.config/orca/cli/orca";
    const f = fixture({ platform: "linux", kernelRelease: nativeLinux, env: { ORCA_CLI_COMMAND: executable } });
    expect((await openOrcaView(f.client, "demo", "path:/work/project", f.deps)).ok).toBe(true);
    expect(f.exec.mock.calls.every(([file]) => file === executable)).toBe(true);
  });

  it("does not fall back to another launcher when orca-ide is missing", async () => {
    const f = fixture({ platform: "linux", kernelRelease: nativeLinux, env: {} });
    f.exec.mockRejectedValueOnce(Object.assign(new Error("launcher not found"), { code: "ENOENT" }));
    await expect(openOrcaView(f.client, "demo", "path:/work/project", f.deps)).resolves.toMatchObject({ ok: false, code: "orca_unavailable" });
    expect(f.exec.mock.calls.map(([file]) => file)).toEqual(["orca-ide"]);
  });

  it.each(["orca", "/usr/bin/orca"])("does not invoke the possible Linux screen reader %s", async executable => {
    const f = fixture({ platform: "linux", kernelRelease: nativeLinux, env: { ORCA_CLI_COMMAND: executable } });
    await expect(openOrcaView(f.client, "demo", "path:/work/project", f.deps)).resolves.toMatchObject({ ok: false, code: "orca_cli_unsafe" });
    expect(f.exec).not.toHaveBeenCalled();
  });

  it("uses the caller's managed WSL bridge and confirms its shell before splitting", async () => {
    const f = wslFixture({ wsl: { workspacePath: "//wsl$/ubuntu-24.04/home/dev/alternate" } });
    const result = await openOrcaView(f.client, "demo", undefined, f.deps);
    expect(result).toMatchObject({ ok: true, opened: ["a@demo", "b@demo"], pages: 1 });
    expect(f.exec.mock.calls.every(([file]) => file === `${wslEnv.ORCA_WSL_CLI_DIR}/orca-ide`)).toBe(true);
    expect(f.commands()[1]?.slice(0, 4)).toEqual(["terminal", "show", "--terminal", "term_caller"]);
    expect(f.commands()[2]?.slice(0, 4)).toEqual(["worktree", "show", "--worktree", `id:${wslId}`]);
    expect(f.mutations()[0]?.slice(6, 8)).toEqual(["--shell", "wsl.exe"]);
    expect(f.mutations()[1]).not.toContain("--shell");
    for (const [index, cmd] of startupCommands(f).entries()) {
      expect(cmd).not.toContain("tmux -S");
      const body = Buffer.from(cmd.split(" ").at(-1)!, "base64").toString("utf8");
      expect(body).toContain(`exec ${pane(index === 0 ? "a" : "b").paneCommand}`);
    }
  });

  it.each([
    [{ platform: "win32" }, "orca_unsupported_platform"],
    [{ kernelRelease: "4.4.0-19041-Microsoft" }, "orca_wsl2_required"],
    [{ kernelRelease: nativeLinux }, "orca_wsl2_required"],
    [{ env: { WSL_DISTRO_NAME: wslEnv.WSL_DISTRO_NAME } }, "orca_wsl_context_required"],
    [{ env: { ...wslEnv, ORCA_WSL_CLI_DIR: "relative/launcher" } }, "orca_wsl_context_required"],
    [{ wsl: { shellSupport: false } }, "orca_wsl_shell_unsupported"],
    [{ wsl: { callerId: "other::/project" } }, "orca_wsl_caller_unconfirmed"],
    [{ wsl: { callerPath: "//wsl.localhost/Debian/home/dev/project" } }, "orca_wsl_caller_unconfirmed"],
    [{ wsl: { workspacePath: "//wsl.localhost/Debian/home/dev/project" } }, "orca_workspace_wrong_distro"],
    [{ wsl: { workspacePath: String.raw`C:\Users\dev\project` } }, "orca_workspace_wrong_distro"],
    [{ wsl: { workspacePath: "//wsl.localhost/Ubuntu-24.04/mnt/c/project" } }, "orca_workspace_wrong_distro"],
  ] as const)("refuses a Windows/WSL mismatch before mutation (%j)", async (options, code) => {
    const f = wslFixture(options);
    await expect(openOrcaView(f.client, "demo", "name:target", f.deps)).resolves.toMatchObject({ ok: false, code });
    expect(f.mutations()).toEqual([]);
  });

  it("does not split or call a Windows shell a connected WSL tab", async () => {
    const f = wslFixture({ wsl: { createdPlatform: "win32" } });
    await expect(openOrcaView(f.client, "demo", undefined, f.deps)).resolves.toMatchObject({ ok: false, code: "orca_outcome_unknown", opened: [] });
    expect(f.mutations().map(([, op]) => op)).toEqual(["create"]);
  });

  it.skipIf(process.platform === "win32")("executes the guarded POSIX payload only for the calling distro and user", async () => {
    const uid = process.getuid!();
    const probe = { seat: "fixture", host: undefined,
      paneCommand: `/bin/sh -c '[ -z "\${TMUX+x}" ] && printf "%s" "$1"' probe 'read only: O'"'"'Brien'` };
    const f = wslFixture({ pages: [[probe]], uid });
    expect((await openOrcaView(f.client, "demo", undefined, f.deps)).ok).toBe(true);
    const run = (cmd: string, distro: string | undefined) => spawnSync("/bin/sh", ["-c", cmd], {
      env: { PATH: process.env.PATH, ...(distro === undefined ? {} : { WSL_DISTRO_NAME: distro }), TMUX: "wrong" }, encoding: "utf8",
    });
    const [cmd] = startupCommands(f);
    expect(run(cmd!, wslEnv.WSL_DISTRO_NAME)).toMatchObject({ status: 0, stdout: "read only: O'Brien" });
    expect(run(cmd!, "Debian")).toMatchObject({ status: 1, stdout: "", stderr: expect.stringContaining("no tmux attachment") });
    expect(run(cmd!, undefined)).toMatchObject({ status: 1, stdout: "" });
    const wrongUser = wslFixture({ pages: [[probe]], uid: uid + 1 });
    await openOrcaView(wrongUser.client, "demo", undefined, wrongUser.deps);
    expect(run(startupCommands(wrongUser)[0]!, wslEnv.WSL_DISTRO_NAME)).toMatchObject({ status: 1, stdout: "" });
  });
});

describe("rig terminal open --provider orca", () => {
  function cli(f: ReturnType<typeof fixture>) {
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const deps = { clientFactory: () => f.client, lifecycleDeps: {}, windowDeps: f.deps } as TerminalDeps;
    const run = async (...args: string[]) => {
      await terminalCommand(deps).parseAsync(["open", ...args, "--json"], { from: "user" });
      return JSON.parse(String(output.mock.calls.at(-1)?.[0]));
    };
    return run;
  }

  it("routes the explicit provider to Orca using the workspace supplied by the user", async () => {
    const f = fixture({ env: {} });
    await expect(cli(f)("demo", "--provider", "orca", "--orca-workspace", "path:/work/project")).resolves.toMatchObject({ provider: "orca", ok: true });
    expect(f.commands()[1]?.[3]).toBe("path:/work/project");
  });

  it.each([["demo", "--window"], ["demo", "--follow"], ["demo", "--expected-plan", "old"], ["--all"]])("rejects unsupported combinations before reading or changing Orca (%s)", async (...args) => {
    const f = fixture();
    await expect(cli(f)(...args, "--provider", "orca")).resolves.toMatchObject({ provider: "orca", ok: false });
    expect(f.get).not.toHaveBeenCalled();
    expect(f.exec).not.toHaveBeenCalled();
  });
});
