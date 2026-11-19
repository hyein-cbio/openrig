import { execFile, execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { DESKTOP_TMUX_SOCKET_FLAG, reportTmuxServerLimit, TMUX_SERVER_LIMIT_PREFIX, tmuxServerStartCommand } from "./tmux-server-start.js";

export const DESKTOP_TMUX_SOCKET_ENV = "OPENRIG_TMUX_DESKTOP_SOCKET";
const HOME_OPTION = "@openrig-desktop-home";
const GENERATION = /^[\da-f]{32}$/;
const PROCESS_START = /^[a-z]{3} [a-z]{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/i;
const SOCKET_NAME = "tmux.sock";
const exec = promisify(execFile);

/** Resolve existing parent aliases even when the instance home or socket does not exist yet. */
export function realpathWithMissingParents(file: string): string {
  const absolute = path.resolve(file);
  try { return fs.realpathSync(absolute); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT" || path.dirname(absolute) === absolute) throw err;
    return path.join(realpathWithMissingParents(path.dirname(absolute)), path.basename(absolute));
  }
}

function homeKey(home: string): string {
  return createHash("sha256").update(realpathWithMissingParents(home)).digest("hex").slice(0, 24);
}

function directoryName(home: string, uid: number): string {
  return `openrig-desktop-${uid}-${homeKey(home)}`;
}

/** macOS allow ACLs can grant directory access beyond the POSIX mode; accept only modes and deny ACLs. */
function checkDirectoryAcl(directory: string): void {
  if (process.platform !== "darwin") return;
  const acl = execFileSync("/bin/ls", ["-lde", "--", directory], {
    encoding: "utf8", env: { LC_ALL: "C" }, timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 16 * 1024,
  });
  if (/^\s*\d+:[^\n]*\sallow\s/m.test(acl)) {
    throw new Error(`The desktop tmux socket cannot use a directory with an allow ACL: ${directory}. Use /tmp or a private directory.`);
  }
}

/** Validate the launcher handoff without following a symlink at the private directory or socket. */
export function desktopTmuxSocketPath(socket: string, home: string, uid: number): string {
  const directory = path.dirname(socket);
  if (!path.isAbsolute(socket) || path.normalize(socket) !== socket || /[\x00-\x1f\x7f]/.test(socket)
      || path.basename(socket) !== SOCKET_NAME || path.basename(directory) !== directoryName(home, uid)) {
    throw new Error(`Invalid ${DESKTOP_TMUX_SOCKET_ENV} for this OpenRig home. Start from a local macOS desktop terminal using 'rig daemon start --desktop-tmux'.`);
  }
  // Normalize e.g. /tmp vs /private/tmp without following the private directory or socket.
  const parent = fs.realpathSync(path.dirname(directory));
  const ancestors = [parent];
  while (path.dirname(ancestors[0]!) !== ancestors[0]) ancestors.unshift(path.dirname(ancestors[0]!));
  // Walk root-to-leaf: a sticky directory only protects entries owned by a trusted user.
  for (const ancestor of ancestors) {
    const stat = fs.lstatSync(ancestor);
    if (!stat.isDirectory() || /[\x00-\x1f\x7f]/.test(ancestor) || (stat.uid !== uid && stat.uid !== 0)
        || ((stat.mode & 0o022) && !(stat.mode & 0o1000))) {
      throw new Error("The desktop tmux socket needs trusted ancestor directories. Use /tmp or a private TMUX_TMPDIR under trusted directories.");
    }
    checkDirectoryAcl(ancestor);
  }
  const canonical = path.join(parent, path.basename(directory), SOCKET_NAME);
  if (canonical.includes(",")) throw new Error("A desktop tmux socket path cannot contain commas. Unset TMUX_TMPDIR or use a path without commas.");
  if (Buffer.byteLength(canonical) >= 104) throw new Error("The desktop tmux socket path is too long. Unset TMUX_TMPDIR or use a shorter private directory.");
  return canonical;
}

function checkDirectory(dir: string, uid: number): void {
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.uid !== uid || (stat.mode & 0o077) !== 0) {
    throw new Error("The desktop tmux directory must be a private, owner-only directory. It was not modified.");
  }
  checkDirectoryAcl(dir);
}

export function isDesktopCommandSocket(socket: string, commandSocket: unknown): commandSocket is string {
  return typeof commandSocket === "string" && path.dirname(commandSocket) === path.dirname(socket)
    && /^c[0-9a-f]{8}$/.test(path.basename(commandSocket));
}

/** Bind commands to a socket inode, not the replaceable bootstrap pathname. The alias is never rebound. */
export function linkDesktopCommandSocket(socket: string, home: string, uid: number): string {
  const endpoint = desktopTmuxSocketPath(socket, home, uid);
  const dir = path.dirname(endpoint);
  checkDirectory(dir, uid);
  // Same filename length as tmux.sock, so this also fits the Unix socket limit.
  const alias = path.join(dir, `c${randomUUID().slice(0, 8)}`);
  try {
    const stat = fs.lstatSync(endpoint);
    if (!stat.isSocket() || stat.uid !== uid) throw new Error("Untrusted desktop tmux socket");
    fs.linkSync(endpoint, alias);
    return alias;
  } catch (cause) {
    throw new Error(`Cannot pin the desktop tmux socket at ${JSON.stringify(endpoint)}. No replacement server was started. Check the socket before retrying rig daemon start --desktop-tmux.`, { cause });
  }
}

// Only ordinary shell settings cross into tmux. No OP_*, token, daemon or other client state.
function clientEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { HOME: env.HOME || homedir(), PATH: env.PATH || "/usr/bin:/bin" };
  for (const key of ["SHELL", "USER", "LOGNAME", "LC_ALL", "LC_CTYPE", "LANG"]) if (env[key]) clean[key] = env[key];
  return clean;
}

async function runTmux(args: string[], env: NodeJS.ProcessEnv, execFailure?: string): Promise<string> {
  // macOS ships bash; execfail lets it attest that exec itself returned.
  // A running tmux replaces this shell, so it cannot reach the attestation.
  const { file, args: argv } = execFailure && process.platform === "darwin"
    ? { file: "/bin/bash", args: ["-c", TMUX_SERVER_LIMIT_PREFIX
      + 'shopt -s execfail; failure=$1; shift; exec "$0" "$@"; rc=$?; printf "%s\\n" "$failure" >&2; exit "$rc"',
      "tmux", execFailure, ...args] }
    : tmuxServerStartCommand("tmux", args);
  try {
    const { stdout, stderr } = await exec(file, argv, {
      env: clientEnvironment(env), timeout: 5_000, encoding: "utf8", killSignal: "SIGKILL",
    });
    reportTmuxServerLimit(stderr);
    return stdout;
  } catch (err) {
    reportTmuxServerLimit((err as { stderr?: unknown }).stderr);
    throw err;
  }
}

export function isDesktopServerPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 1 && value <= 0x7fffffff;
}

export function isDesktopBootId(value: unknown): value is string {
  return typeof value === "string" && /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(value);
}

function desktopBootId(): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const id = execFileSync("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"],
      { encoding: "utf8", env: { LC_ALL: "C" }, timeout: 2_000, killSignal: "SIGKILL" }).trim().toLowerCase();
    return isDesktopBootId(id) ? id : undefined;
  } catch { return undefined; }
}

function desktopProcessStart(pid: number): string | undefined {
  if (process.platform !== "darwin") return undefined;
  try {
    const stamp = execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="],
      { encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC0" }, timeout: 2_000, killSignal: "SIGKILL" }).trim();
    return PROCESS_START.test(stamp) ? stamp : undefined;
  } catch { return undefined; }
}

/** A missing socket is not proof of exit. A confirmed change of boot or PID's start time is. */
export function desktopServerExited(pid?: number, bootId?: string, startId?: string): boolean {
  if (pid !== undefined) {
    try { process.kill(pid, 0); }
    catch (err) { if ((err as NodeJS.ErrnoException).code === "ESRCH") return true; }
  }
  const current = isDesktopBootId(bootId) ? desktopBootId() : undefined;
  if (current && current !== bootId?.toLowerCase()) return true;
  const observed = pid !== undefined && typeof startId === "string" && PROCESS_START.test(startId)
    ? desktopProcessStart(pid) : undefined;
  return observed !== undefined && observed !== startId;
}

interface DesktopBootstrap { socketPath: string; pid?: number; bootId?: string; startId?: string; generation?: string }

function bootstrapRecord(home: string): string {
  return path.join(home, "tmux-desktop-bootstrap.json");
}

function readDesktopBootstrap(home: string): DesktopBootstrap | undefined {
  const file = bootstrapRecord(home);
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<DesktopBootstrap> | null;
    if (typeof record?.socketPath === "string" && path.isAbsolute(record.socketPath)
        && (record.pid === undefined || isDesktopServerPid(record.pid))
        && (record.bootId === undefined || isDesktopBootId(record.bootId))
        && (record.startId === undefined || typeof record.startId === "string")
        && (record.generation === undefined || (typeof record.generation === "string" && GENERATION.test(record.generation)))) {
      return { socketPath: record.socketPath, pid: record.pid, bootId: record.bootId, startId: record.startId, generation: record.generation };
    }
  } catch (err) { if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined; }
  throw new Error(`Cannot read the desktop tmux bootstrap record ${file}. Inspect it before bootstrapping.`);
}

function rememberDesktopBootstrap(home: string, record: DesktopBootstrap): void {
  const file = bootstrapRecord(home);
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temp, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, file);
  } finally { fs.rmSync(temp, { force: true }); }
}

function requireDesktopProcessExit(record: DesktopBootstrap, home: string): void {
  if (desktopServerExited(record.pid, record.bootId, record.startId)) return;
  if (record.pid === undefined) {
    throw new Error(`The previous desktop tmux bootstrap at ${JSON.stringify(record.socketPath)} did not confirm a PID. Inspect the endpoint and archive ${JSON.stringify(bootstrapRecord(home))} only after confirming that no server started or that the identified server exited, and that the selected-server record identifies no live desktop server. A missing socket is not enough. No replacement server was started.`);
  }
  throw new Error(`The previous desktop tmux PID ${record.pid} has not been confirmed exited. Check ${JSON.stringify(record.socketPath)} and recover its socket if that server is still running. No replacement server was started.`);
}

function requirePreviousDesktopExit(home: string): void {
  const file = path.join(home, "tmux-server.json");
  let record: { version?: unknown; home?: unknown; socketPath?: unknown; desktopBootstrapSocket?: unknown; desktopServerPid?: unknown;
    desktopBootId?: unknown; desktopStartId?: unknown } | null;
  try { record = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && !fs.existsSync(path.join(home, "tmux-server.initialized"))) return;
    throw new Error("Cannot confirm the previous tmux selection. Inspect the instance's tmux server record before bootstrapping.");
  }
  if (record?.version === 1 && record.desktopBootstrapSocket === undefined) return;
  const socketPath = record?.version === 1 ? record.desktopBootstrapSocket : record?.socketPath;
  if ((record?.version !== 1 && record?.version !== 2) || record.home !== realpathWithMissingParents(home)
      || typeof socketPath !== "string" || !path.isAbsolute(socketPath)
      || !isDesktopServerPid(record.desktopServerPid) || (record.desktopBootId !== undefined && !isDesktopBootId(record.desktopBootId))
      || (record.desktopStartId !== undefined && typeof record.desktopStartId !== "string")) {
    throw new Error("Cannot confirm the previous desktop tmux process. Inspect the instance's tmux server record before bootstrapping.");
  }
  requireDesktopProcessExit({ socketPath, pid: record.desktopServerPid, bootId: record.desktopBootId,
    startId: record.desktopStartId }, home);
}

/** Read identity and optional inventory from one client connection, never from two socket lookups. */
export async function observeDesktopTmuxServer(socket: string, home: string, uid: number, env = process.env,
  inventory = false, commandSocket?: string): Promise<{ pid: number; generation: string; bootId?: string; startId?: string; rows: string[] }> {
  try {
    const bootstrapSocket = desktopTmuxSocketPath(socket, home, uid);
    const endpoint = commandSocket ?? bootstrapSocket;
    if (commandSocket !== undefined && !isDesktopCommandSocket(bootstrapSocket, commandSocket)) throw new Error("Invalid desktop command socket");
    checkDirectory(path.dirname(endpoint), uid);
    const stat = fs.lstatSync(endpoint);
    if (stat.isSocket() && stat.uid === uid) {
      const identityArgs = ["-u", DESKTOP_TMUX_SOCKET_FLAG, endpoint, "show-options", "-gqv", HOME_OPTION,
        ";", "display-message", "-p", "#{pid}"];
      const [marker, pid, ...rows] = (await runTmux([...identityArgs,
        ...(inventory ? [";", "list-sessions", "-F", "#{session_name}\t#{OPENRIG_HOME}"] : [])], env))
        .split(/\r?\n/).filter(Boolean);
      const prefix = `${homeKey(home)}:`;
      const generation = marker?.startsWith(prefix) ? marker.slice(prefix.length) : "";
      if (GENERATION.test(generation) && isDesktopServerPid(Number(pid))) {
        const startId = desktopProcessStart(Number(pid));
        if (startId) {
          // Confirm that ps did not observe a different process after the tmux PID was reused.
          const [confirmedMarker, confirmedPid] = (await runTmux(identityArgs, env)).split(/\r?\n/).filter(Boolean);
          if (confirmedMarker !== marker || confirmedPid !== pid) throw new Error("Desktop tmux identity changed during observation");
        }
        return { pid: Number(pid), generation, bootId: desktopBootId(), startId, rows };
      }
    }
  } catch { /* An unreachable or untrusted endpoint is never selected. */ }
  throw new Error(`The desktop tmux server at ${JSON.stringify(socket)} is not confirmed. If the socket exists, check with 'tmux -NS <socketPath> list-sessions' and 'lsof -nP -U'. Only remove it if the connection is refused and you can confirm no live process owns that exact socket. Leave live or unconfirmed sockets alone. No replacement server was started. After resolving the socket, retry 'rig daemon start --desktop-tmux' from a local macOS desktop terminal.`);
}

async function hasAquaSession(): Promise<boolean> {
  try {
    // The macOS window launcher uses the same Aqua check for a local GUI login context.
    const { stdout } = await exec("/bin/launchctl", ["managername"], {
      encoding: "utf8", env: { LC_ALL: "C" }, timeout: 2_000, killSignal: "SIGKILL",
    });
    return stdout.trim() === "Aqua";
  } catch { return false; }
}

/** The desktop CLI calls this under the per-home daemon start reservation, before spawning the daemon. */
export async function startDesktopTmuxServer(home: string, options: {
  env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform; hasDesktopSession?: () => Promise<boolean>;
} = {}): Promise<{ socketPath: string }> {
  const uid = process.getuid?.();
  if ((options.platform ?? process.platform) !== "darwin" || uid === undefined) {
    throw new Error("Desktop tmux bootstrap is supported only on macOS.");
  }
  const env = options.env ?? process.env;
  const bootstrap = readDesktopBootstrap(home);
  // Keep the recorded endpoint across terminal changes, even if the current TMUX_TMPDIR differs.
  const fallback = path.resolve(env.TMUX_TMPDIR?.trim() || "/tmp", directoryName(home, uid), SOCKET_NAME);
  let socket: string;
  try { socket = desktopTmuxSocketPath(bootstrap?.socketPath ?? fallback, home, uid); }
  catch (err) {
    if (!bootstrap || (err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    requireDesktopProcessExit(bootstrap, home);
    socket = desktopTmuxSocketPath(fallback, home, uid);
  }
  const dir = path.dirname(socket);
  try { await runTmux(["-N", "-V"], env); }
  catch { throw new Error("Desktop tmux bootstrap requires tmux with the '-N' (do not start a server) option on PATH."); }
  try { fs.mkdirSync(dir, { mode: 0o700 }); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err; }
  checkDirectory(dir, uid);

  // The per-home start reservation serializes this check and start across OpenRig invocations.
  // Verify any endpoint left by an earlier start instead of replacing it. Only a new server reads -f.
  let pendingGeneration = bootstrap?.pid === undefined ? bootstrap?.generation : undefined;
  if (!fs.lstatSync(socket, { throwIfNoEntry: false })) {
    if (env.TMUX || env.TMUX_PANE || env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) {
      throw new Error("Create the desktop tmux server from a fresh local macOS desktop terminal, outside tmux and SSH.");
    }
    if (!await (options.hasDesktopSession ?? hasAquaSession)()) {
      throw new Error("Could not confirm a local macOS desktop (Aqua) session. Run rig daemon start --desktop-tmux from a desktop terminal.");
    }
    requirePreviousDesktopExit(home);
    if (bootstrap) requireDesktopProcessExit(bootstrap, home);
    const generation = randomUUID().replaceAll("-", "");
    pendingGeneration = generation;
    const config = path.join(dir, `bootstrap-${generation}.conf`);
    fs.writeFileSync(config, `set-option -g exit-empty off\nset-option -g ${HOME_OPTION} ${homeKey(home)}:${generation}\n`, { mode: 0o600, flag: "wx" });
    try { rememberDesktopBootstrap(home, { socketPath: socket, bootId: desktopBootId(), generation }); }
    catch (err) { fs.rmSync(config, { force: true }); throw err; }
    const execFailure = `openrig-tmux-exec-failed:${generation}`;
    try {
      await runTmux(["-S", socket, "-f", config, "start-server"], env, execFailure);
    } catch (err) {
      const failure = err as NodeJS.ErrnoException & { stderr?: string; signal?: string };
      // Only a pre-spawn or attested exec failure rules out a server start.
      if (failure.syscall?.startsWith("spawn ")
          || (process.platform === "darwin" && !failure.signal && failure.stderr?.split(/\r?\n/).includes(execFailure))) {
        fs.rmSync(config, { force: true });
        if (bootstrap) rememberDesktopBootstrap(home, bootstrap);
        else fs.rmSync(bootstrapRecord(home), { force: true });
      }
      throw new Error("Desktop tmux bootstrap did not confirm a start. Inspect the dedicated socket before retrying; no existing server was stopped.");
    }
  }
  const observed = await observeDesktopTmuxServer(socket, home, uid, env);
  const { pid, generation } = observed;
  if (pendingGeneration && pendingGeneration !== generation) {
    throw new Error("The desktop tmux socket does not match the pending bootstrap. Inspect the original server before retrying.");
  }
  const same = bootstrap?.pid === pid && bootstrap.generation === generation;
  if (bootstrap?.pid !== undefined && !same) requireDesktopProcessExit(bootstrap, home);
  const bootId = observed.bootId ?? (same ? bootstrap.bootId : undefined);
  const startId = observed.startId ?? (same ? bootstrap.startId : undefined);
  if (!same || bootstrap.socketPath !== socket || bootstrap.bootId !== bootId || bootstrap.startId !== startId) {
    // The daemon may defer selection and keep its existing record. Save bootstrap evidence independently.
    rememberDesktopBootstrap(home, { socketPath: socket, pid, generation, bootId, startId });
  }
  // A verified generation proves its config was read. A timed-out client alone does not.
  fs.rmSync(path.join(dir, `bootstrap-${generation}.conf`), { force: true });
  return { socketPath: socket };
}
