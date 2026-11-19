import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execArgvCommand, execTmuxCommand } from "../src/adapters/tmux-exec.js";
import { TmuxAdapter } from "../src/adapters/tmux.js";
import { selectTmuxServer } from "../src/domain/tmux-server-selection.js";
import { DESKTOP_TMUX_SOCKET_ENV, desktopServerExited, observeDesktopTmuxServer, startDesktopTmuxServer } from "../src/tmux-desktop-server.js";

const canRun = process.platform !== "win32" && (() => {
  try {
    execFileSync("tmux", ["-N", "-V"], { stdio: "ignore", timeout: 2_000, killSignal: "SIGKILL" });
    return !!execFileSync("ps", ["-p", String(process.pid), "-o", "lstart=", "-o", "comm="],
      { encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL" }).trim();
  }
  catch { return false; }
})();

describe.skipIf(!canRun)("launcher-owned server with native tmux", () => {
  let root = "";
  let home: string;
  let socket: string | undefined;
  let retainRoot = false;
  let attempted = false;
  const sockets = new Map<string, { pid: number; stamp?: string } | undefined>();
  let env: NodeJS.ProcessEnv;
  beforeEach(() => {
    root = "";
    sockets.clear();
    retainRoot = false;
    attempted = false;
    // Do not inherit an arbitrary TMPDIR: the launcher requires trusted ancestors.
    root = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "od"));
    root = fs.realpathSync(root);
    home = path.join(root, "instance");
    fs.mkdirSync(home, { mode: 0o700 });
    env = { PATH: process.env.PATH, HOME: root, SHELL: "/bin/sh", TMUX_TMPDIR: root,
      LC_ALL: process.env.LC_ALL, LC_CTYPE: process.env.LC_CTYPE, LANG: process.env.LANG,
      OP_SESSION_fixture: "synthetic", OPENRIG_AUTH_BEARER_TOKEN: "synthetic", TERM_PROGRAM: "fixture" };
  });
  const native = (args: string[], endpoint = socket!, timeout = 5_000) => execFileSync("tmux", ["-NS", endpoint, ...args], {
    encoding: "utf8", timeout, stdio: ["ignore", "pipe", "pipe"], env,
  }).trim();
  const pidAtSocket = (endpoint = socket!) => {
    try { return Number(native(["display-message", "-p", "#{pid}"], endpoint, 1_000)) || undefined; }
    catch { return undefined; }
  };
  const stamp = (pid: number) => {
    try { return execFileSync("ps", ["-p", String(pid), "-o", "lstart=", "-o", "comm="],
      { env, encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL" }).trim(); }
    catch { return undefined; }
  };
  // A container's PID 1 may leave a terminated tmux as a zombie. The socket
  // is checked separately before fixture cleanup removes it.
  const fixtureProcessEnded = (pid: number) => {
    if (desktopServerExited(pid)) return true;
    try {
      return /^Z/.test(execFileSync("ps", ["-p", String(pid), "-o", "stat="],
        { env, encoding: "utf8", timeout: 2_000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] }).trim());
    } catch { return false; }
  };
  const rememberSocket = (endpoint: string) => {
    const pid = pidAtSocket(endpoint);
    sockets.set(endpoint, pid ? { pid, stamp: stamp(pid) } : undefined);
  };
  const stopDisconnected = async (record: { pid: number; stamp?: string }) => {
    if (fixtureProcessEnded(record.pid)) return;
    if (!record.stamp || stamp(record.pid) !== record.stamp) throw new Error("Fixture tmux process identity unconfirmed");
    process.kill(record.pid, "SIGTERM");
    await expect.poll(() => fixtureProcessEnded(record.pid), { timeout: 5_000 }).toBe(true);
  };
  const assertFixtureSocket = (endpoint: string) => {
    if (!/^openrig-desktop-\d+-[0-9a-f]{24}\/tmux\.sock$/.test(path.relative(root, endpoint))
        || !fs.lstatSync(endpoint).isSocket() || fs.realpathSync(endpoint) !== endpoint) {
      throw new Error(`Refusing to use a tmux socket outside this fixture: ${endpoint}`);
    }
  };
  const stopFixtureServer = async (endpoint = socket!, pid = pidAtSocket(endpoint)) => {
    assertFixtureSocket(endpoint);
    if (!pid) throw new Error(`Cannot identify the fixture server at ${endpoint}`);
    for (let attempt = 0; attempt < 2 && !fixtureProcessEnded(pid); attempt++) {
      if (pidAtSocket(endpoint) === pid) {
        try { native(["kill-server"], endpoint, 1_500); } catch { /* Shutdown still needs confirmation. */ }
      }
      await expect.poll(() => fixtureProcessEnded(pid), { timeout: 1_200 }).toBe(true).catch(() => {});
    }
    if (!fixtureProcessEnded(pid) || pidAtSocket(endpoint)) throw new Error(`Fixture tmux shutdown unconfirmed at ${endpoint}`);
    // The original process is gone; only this private fixture may remove its stale socket.
    fs.rmSync(endpoint, { force: true });
  };
  afterEach(async () => {
    if (!root) return; // This test did not allocate the fixture.
    const unresolved: string[] = [];
    const receipt = attempted ? path.join(home, "tmux-desktop-bootstrap.json") : undefined;
    if (receipt && fs.existsSync(receipt)) {
      try {
        const { socketPath, generation } = JSON.parse(fs.readFileSync(receipt, "utf8"));
        if (!sockets.has(socketPath)) {
          assertFixtureSocket(socketPath);
          const observed = await observeDesktopTmuxServer(socketPath, home, process.getuid!(), env);
          if (observed.generation !== generation) throw new Error("Fixture bootstrap generation unconfirmed");
          rememberSocket(socketPath);
        }
      } catch { unresolved.push(receipt); }
    }
    for (const [endpoint, recorded] of sockets) {
      if (!endpoint.startsWith(root + path.sep)) throw new Error("Refusing to stop a tmux server outside this fixture");
      const pid = pidAtSocket(endpoint);
      try {
        if (pid) await stopFixtureServer(endpoint, pid);
        else if (recorded) {
          await stopDisconnected(recorded);
          if (fs.existsSync(endpoint)) {
            assertFixtureSocket(endpoint);
            let absent = false;
            try { native(["list-sessions"], endpoint, 1_000); }
            catch (err) { absent = /^(?:no server running on |error connecting to .*\(Connection refused\))/.test(String((err as { stderr?: unknown }).stderr ?? "")); }
            if (!absent) throw new Error("Fixture socket ownership is unconfirmed");
            fs.rmSync(endpoint);
          }
        } else throw new Error("Fixture socket ownership is unconfirmed");
      } catch { unresolved.push(endpoint); }
    }
    sockets.clear();
    if (!retainRoot && !unresolved.length) fs.rmSync(root, { recursive: true, force: true });
    socket = undefined;
    retainRoot = false;
    if (unresolved.length) throw new Error(`Fixture shutdown unconfirmed; retained ${root}: ${unresolved.join(", ")}`);
  });
  const launcher = async (launchEnv = env, desktop = true) => {
    attempted = true;
    const result = await startDesktopTmuxServer(home, { platform: "darwin", env: launchEnv, hasDesktopSession: async () => desktop });
    assertFixtureSocket(result.socketPath);
    rememberSocket(result.socketPath);
    return result;
  };
  const select = (scope = home, launchEnv = env) => selectTmuxServer({
    home: scope, mode: "inherit", platform: "darwin", env: launchEnv, registeredSessions: [],
  });
  const refusesMissingLiveSocket = async (pid: number, whileMissing?: () => Promise<void>) => {
    const original = stamp(pid);
    fs.unlinkSync(socket!);
    try {
      await expect(launcher()).rejects.toThrow("has not been confirmed exited");
      expect(fs.existsSync(socket!)).toBe(false);
      await whileMissing?.();
    } finally {
      try {
        const replacement = pidAtSocket();
        if (replacement && replacement !== pid) await stopFixtureServer(socket!, replacement);
        // Signal only the confirmed original fixture server to restore its socket for cleanup.
        if (!original || stamp(pid) !== original) throw new Error("Original fixture tmux process is no longer confirmed");
        process.kill(pid, "SIGUSR1");
        await expect.poll(() => pidAtSocket()).toBe(pid);
      } catch (error) {
        retainRoot = !desktopServerExited(pid);
        if (retainRoot && original && stamp(pid) === original) {
          await stopDisconnected({ pid, stamp: original });
          retainRoot = false;
        }
        throw error;
      }
    }
  };

  it("requires desktop context for bootstrap, then reuses the server's PID and sessions", async () => {
    await expect(launcher(env, false)).rejects.toThrow("Could not confirm a local macOS desktop");
    ({ socketPath: socket } = await launcher());
    const pid = native(["display-message", "-p", "#{pid}"]);
    expect(pid).toMatch(/^\d+$/);
    expect(native(["list-sessions"])).toBe("");
    expect(native(["show-environment", "-g"])).not.toMatch(/OP_SESSION_|OPENRIG_AUTH_BEARER_TOKEN|TERM_PROGRAM/);
    await refusesMissingLiveSocket(Number(pid)); // Even before daemon selection has committed.
    native(["new-session", "-d", "-s", "existing", "sleep 60"]);
    expect(await launcher({ ...env, TMUX_TMPDIR: path.join(root, "not-used") }, false)).toEqual({ socketPath: socket });
    expect(native(["display-message", "-p", "#{pid}"])).toBe(pid);
    expect(native(["list-sessions", "-F", "#{session_name}"])).toBe("existing");
  });

  it("pins a verified server, won't switch homes, and doesn't recreate a missing server", async () => {
    ({ socketPath: socket } = await launcher());
    const request = { ...env, [DESKTOP_TMUX_SOCKET_ENV]: socket };
    const selected = await select(home, request);
    expect(selected).toMatchObject({ mode: "isolated", source: "desktop", requestedSource: "desktop", socketPath: socket,
      executionArgs: ["-NS", expect.stringMatching(/\/c[0-9a-f]{8}$/)], serverArgs: selected.executionArgs, migrationPending: false });
    const pid = Number(native(["display-message", "-p", "#{pid}"]));
    expect(JSON.parse(fs.readFileSync(path.join(home, "tmux-server.json"), "utf8"))).toMatchObject({ version: 2, pinned: true, desktopServerPid: pid });
    expect(await select()).toMatchObject({ source: "desktop", socketPath: socket, serverArgs: selected.serverArgs });
    await refusesMissingLiveSocket(pid, async () => {
      expect(native(["display-message", "-p", "#{pid}"], selected.executionArgs[1]!)).toBe(String(pid));
    });
    await expect(select(path.join(root, "another-home"), request)).rejects.toThrow("Invalid OPENRIG_TMUX_DESKTOP_SOCKET");
    // SIGUSR1 can recreate the listener; daemon selection must verify its socket again.
    const recovered = await select();
    expect(native(["display-message", "-p", "#{pid}"], recovered.executionArgs[1]!)).toBe(String(pid));
    const tmux = new TmuxAdapter(execTmuxCommand, undefined, execArgvCommand, recovered.executionArgs);
    expect(await tmux.startServer()).toMatchObject({ ok: true });
    await stopFixtureServer();
    expect(await tmux.startServer()).toMatchObject({ ok: false, code: "tmux_unavailable" });
    expect(await tmux.createSession("must-not-start")).toMatchObject({ ok: false, code: "tmux_unavailable" });
    await expect(select()).rejects.toThrow("No replacement server was started");
    expect(fs.existsSync(socket!)).toBe(false);
    await expect(launcher({ ...env, TMUX: "/synthetic/old,1,0" })).rejects.toThrow("outside tmux and SSH");
    expect(fs.existsSync(socket!)).toBe(false);
  });

  it("never guesses an old server for registered seats, and keeps an uninspectable recorded server selected", async () => {
    ({ socketPath: socket } = await launcher());
    const request = { home, mode: "inherit" as const, platform: "darwin" as const, registeredSessions: ["seat"],
      env: { ...env, [DESKTOP_TMUX_SOCKET_ENV]: socket } };
    await expect(selectTmuxServer(request)).rejects.toThrow("No previous tmux server record");
    const old = await select();
    await expect(selectTmuxServer({ ...request, inspect: async () => ({ state: "absent" }) })).rejects.toThrow("Restore the original socket");
    expect(await selectTmuxServer({ ...request, inspect: async () => ({ state: "unavailable" }) })).toMatchObject({
      requestedSource: "desktop", mode: "inherit", socketPath: old.socketPath, migrationPending: true, blockingSessions: [],
    });
    expect(native(["list-sessions"])).toBe("");
  });

  it("keeps a live desktop seat selected during explicit opt-out until the seat stops", async () => {
    ({ socketPath: socket } = await launcher());
    const original = await select(home, { ...env, [DESKTOP_TMUX_SOCKET_ENV]: socket });
    native(["new-session", "-d", "-s", "seat", "sleep 60"]);
    const off = { home, mode: "inherit" as const, platform: "darwin" as const, registeredSessions: ["seat"],
      env: { ...env, [DESKTOP_TMUX_SOCKET_ENV]: "off" } };
    await expect(selectTmuxServer({ ...off, registeredSessions: [],
      env: { ...off.env, TMUX: `${original.executionArgs[1]},1,0` } })).rejects.toThrow("outside that server");
    expect(await selectTmuxServer(off)).toMatchObject({ source: "desktop", socketPath: socket, migrationPending: true,
      blockingSessions: ["seat"], executionArgs: original.executionArgs });
    native(["kill-session", "-t", "=seat"]);
    const selected = await selectTmuxServer(off);
    expect(selected).toMatchObject({ mode: "inherit", executionArgs: [], migrationPending: false });
    expect(selected.source).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(home, "tmux-server.json"), "utf8"))).toMatchObject({ version: 1, pinned: false });
    expect(native(["list-sessions"])).toBe("");
  });

  it("refuses symlinks and a live unmarked server instead of relabeling it", async () => {
    ({ socketPath: socket } = await launcher());
    await stopFixtureServer();
    fs.symlinkSync(path.join(root, "untouched"), socket);
    await expect(launcher()).rejects.toThrow("not confirmed");
    expect(fs.lstatSync(socket).isSymbolicLink()).toBe(true);
    fs.unlinkSync(socket);
    execFileSync("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "unrelated", "sleep 60"], { env, timeout: 5_000 });
    rememberSocket(socket);
    await expect(launcher()).rejects.toThrow("not confirmed");
    await expect(select(home, { ...env, [DESKTOP_TMUX_SOCKET_ENV]: socket })).rejects.toThrow("not confirmed");
    expect(native(["show-options", "-gqv", "@openrig-desktop-home"])).toBe("");
    expect(native(["list-sessions", "-F", "#{session_name}"])).toBe("unrelated");
  });
});

it("preserves inheritance away from macOS even when the launcher environment is present", async () => {
  await expect(startDesktopTmuxServer("unused", { platform: "linux" })).rejects.toThrow("only on macOS");
  const selected = await selectTmuxServer({ home: "unused", mode: "inherit", platform: "linux", uid: 1000, persist: false,
    env: { [DESKTOP_TMUX_SOCKET_ENV]: "/irrelevant.sock", TMUX: "/tmp/legacy.sock,1,0" }, registeredSessions: [] });
  expect(selected).toMatchObject({ mode: "inherit", socketPath: "/tmp/legacy.sock", executionArgs: [], migrationPending: false });
  expect(selected.requestedSource).toBeUndefined();
});
