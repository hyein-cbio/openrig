import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execArgvCommand } from "../adapters/tmux-exec.js";
import { tmuxServerArgs } from "../adapters/tmux-server.js";
import { DESKTOP_TMUX_SOCKET_ENV, desktopServerExited, desktopTmuxSocketPath, isDesktopBootId, isDesktopCommandSocket,
  isDesktopServerPid, linkDesktopCommandSocket, observeDesktopTmuxServer, realpathWithMissingParents } from "../tmux-desktop-server.js";
import { DESKTOP_TMUX_SOCKET_FLAG } from "../tmux-server-start.js";

export type TmuxServerMode = "inherit" | "isolated";

export interface TmuxServerSelection {
  requestedMode: TmuxServerMode;
  mode: TmuxServerMode;
  socketPath?: string;
  /** Attachment metadata: inherited non-default servers still need their flags. */
  serverArgs: string[];
  /** Native commands inherit normally unless isolation or migration pins a server. */
  executionArgs: string[];
  requestedSource?: "desktop";
  source?: "desktop";
  remoteMode?: TmuxServerMode;
  /** Local teardown can confirm process exit without starting a substitute server. Not serialized. */
  confirmDesktopExit?: () => boolean;
  migrationPending: boolean;
  blockingSessions: string[];
  note?: string;
}

interface ServerRecord {
  // Older binaries must refuse v2 rather than start the desktop server themselves.
  version: 1 | 2;
  home: string;
  mode: TmuxServerMode;
  pinned: boolean;
  socketPath: string;
  isolatedSocketPath?: string;
  /** v1 may remember an opted-out endpoint for reuse/cleanup, not for selection. */
  desktopBootstrapSocket?: string;
  desktopServerPid?: number;
  desktopBootId?: string;
  desktopStartId?: string;
  desktopCommandSocket?: string;
  desktopGeneration?: string;
}

// Unlike the old "1" marker (also written by inherit), this denotes an active
// explicit selection. The record remains the authority for a completed opt-out.
const PINNED_MARKER = "openrig-tmux-pinned-v1\n";

export type ServerInspection =
  | { state: "available"; sessions: Array<{ name: string; home?: string }> }
  | { state: "absent" }
  | { state: "unavailable" };

interface SelectionOptions {
  home: string;
  mode: TmuxServerMode;
  registeredSessions: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** In-memory compositions do not leave a durable instance record. */
  persist?: boolean;
  platform?: NodeJS.Platform;
  uid?: number;
  inspect?: (socket: string) => Promise<ServerInspection>;
}

function canonical(file: string): string {
  try { return fs.realpathSync(file); }
  catch { return path.resolve(file); }
}

export function sameSocketInode(left: string, right: string): boolean {
  try {
    const a = fs.statSync(left);
    const b = fs.statSync(right);
    return a.isSocket() && b.isSocket() && a.dev === b.dev && a.ino === b.ino;
  } catch { return false; }
}

/** TMUX appends two numeric fields; a socket path itself may contain commas. */
export function inheritedTmuxSocket(env: NodeJS.ProcessEnv, uid: number): string {
  const inherited = env.TMUX?.replace(/,\d+,\d+$/, "");
  if (inherited && path.isAbsolute(inherited)) return inherited;
  return path.join(canonical(env.TMUX_TMPDIR?.trim() || "/tmp"), `tmux-${uid}`, "default");
}

function sessionInventory(lines: string[]): ServerInspection {
  if (lines.some(line => !line.includes("\t"))) return { state: "unavailable" };
  return { state: "available", sessions: lines.map(line => {
    const [name, ...home] = line.split("\t");
    const owner = home.join("\t");
    return { name: name!, ...(owner ? { home: owner } : {}) };
  }) };
}

/** Listing the old server is observation only; it never starts or stops a server. */
export async function inspectTmuxServer(socket: string): Promise<ServerInspection> {
  try {
    // Outside tmux, a C locale otherwise sanitizes the tab to '_', losing both
    // the names and their ownership. This is a machine-readable protocol.
    const output = await execArgvCommand(["tmux", "-u", "-S", socket, "list-sessions", "-F", "#{session_name}\t#{OPENRIG_HOME}"]);
    return sessionInventory(output.split(/\r?\n/).filter(Boolean));
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    if (!/permission denied|operation not permitted|EACCES|EPERM/i.test(message)
      && (/no server running/i.test(message)
        || (/error connecting to/i.test(message) && /No such file or directory|Connection refused/i.test(message)))) {
      return { state: "absent" };
    }
    return { state: "unavailable" };
  }
}

function readRecord(file: string, home: string): ServerRecord | null {
  let value: unknown;
  try { value = JSON.parse(fs.readFileSync(file, "utf8")); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new Error(`Cannot read the tmux server record ${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const record = value as Partial<ServerRecord> | null;
  const pinned = record?.pinned === true || record?.mode === "isolated" || record?.version === 2;
  if (!record || (record.version !== 1 && record.version !== 2) || record.home !== home
    || !["inherit", "isolated"].includes(record.mode ?? "")
    || (record.pinned !== undefined && typeof record.pinned !== "boolean")
    || (record.mode === "isolated" && record.pinned === false)
    || typeof record.socketPath !== "string" || !path.isAbsolute(record.socketPath) || record.socketPath.includes("\0")
    || (record.version === 2 && (record.mode !== "isolated" || !isDesktopServerPid(record.desktopServerPid)
      || !isDesktopCommandSocket(record.socketPath, record.desktopCommandSocket)
      || typeof record.desktopGeneration !== "string" || !/^[\da-f]{32}$/.test(record.desktopGeneration)
      || (record.desktopBootId !== undefined && !isDesktopBootId(record.desktopBootId))
      || (record.desktopStartId !== undefined && typeof record.desktopStartId !== "string")))
    || (record.isolatedSocketPath !== undefined
      && (typeof record.isolatedSocketPath !== "string" || !path.isAbsolute(record.isolatedSocketPath) || record.isolatedSocketPath.includes("\0")))) {
    throw Object.assign(new Error(`Invalid tmux server record ${file}; inspect it before changing this instance's server.`), { pinned });
  }
  // Legacy isolated records were pinned; legacy inherit records were advisory.
  return { ...record, pinned } as ServerRecord;
}

function readPinMarker(home: string): { active: boolean; legacy?: boolean; error?: Error } {
  const file = path.join(home, "tmux-server.initialized");
  try {
    const value = fs.readFileSync(file, "utf8").trim();
    return { active: value === PINNED_MARKER.trim(), legacy: value === "1" };
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { active: false };
    return { active: false, error: new Error(`Cannot read the tmux pin marker ${file}: ${error instanceof Error ? error.message : String(error)}`) };
  }
}

function atomicWrite(file: string, content: string): void {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, file);
  } catch (error) {
    try { fs.unlinkSync(temporary); }
    catch { /* Best effort: preserve the original persistence error. */ }
    throw error;
  }
}

function writeRecord(file: string, record: ServerRecord, rollbackInitialPin = false): void {
  const marker = path.join(record.home, "tmux-server.initialized");
  // Establish pin evidence before the record or any session operation. A completed
  // opt-out commits pinned:false first, then removes that evidence. The caller
  // must not start on another server if either part of a pin transition fails.
  let oldMarker: string | undefined;
  if (rollbackInitialPin && record.pinned) {
    try { oldMarker = fs.readFileSync(marker, "utf8"); }
    catch (err) { if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err; }
  }
  if (record.pinned) atomicWrite(marker, PINNED_MARKER);
  try { atomicWrite(file, JSON.stringify(record, null, 2) + "\n"); }
  catch (err) {
    if (rollbackInitialPin && record.pinned) {
      try {
        if (oldMarker === undefined) fs.unlinkSync(marker);
        else atomicWrite(marker, oldMarker);
      } catch { /* Preserve the original write error. */ }
    }
    throw err;
  }
  if (!record.pinned) {
    try { fs.unlinkSync(marker); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}

/**
 * Choose once, before reconciliation or launch. A different requested server is
 * deferred while registered sessions survive on the previous one, or while that
 * server cannot be inspected. No pane is moved, restarted or killed here.
 */
export async function selectTmuxServer(options: SelectionOptions): Promise<TmuxServerSelection> {
  const env = options.env ?? process.env;
  const uid = options.uid ?? process.getuid?.();
  const platform = options.platform ?? process.platform;
  const desktopRequest = platform === "darwin" ? env[DESKTOP_TMUX_SOCKET_ENV] : undefined;
  const launcherSocket = desktopRequest === "off" ? undefined : desktopRequest || undefined;
  // A desktop link is durable across daemon and viewer lifetimes. In-memory
  // compositions have no durable owner for it and must not create one.
  if (launcherSocket && options.persist === false) throw new Error("Desktop tmux selection requires a persistent OpenRig instance.");
  const requiresRecord = options.mode === "isolated" || launcherSocket !== undefined;
  if (platform === "win32" || uid === undefined) {
    // Don't interpret a restored desktop-pinned home as psmux inheritance.
    let recordedVersion: unknown;
    if (options.persist !== false) {
      try { recordedVersion = JSON.parse(fs.readFileSync(path.join(options.home, "tmux-server.json"), "utf8"))?.version; }
      catch {
        const marker = readPinMarker(options.home);
        if (marker.active || marker.error) throw new Error("Cannot read the pinned tmux server record; inspect it before starting on Windows.");
      }
    }
    if (recordedVersion === 2) throw new Error("This OpenRig home is pinned to a macOS desktop tmux server.");
    return {
      requestedMode: options.mode, mode: "inherit", serverArgs: [], executionArgs: [],
      migrationPending: options.mode === "isolated", blockingSessions: [],
      ...(options.mode === "isolated" ? { note: "Dedicated tmux servers require POSIX tmux; psmux keeps its current server." } : {}),
    };
  }

  // A new home beneath a symlinked parent must exist before hashing its real path.
  // Normal inheritance still has no writable-home prerequisite: it tries, so the record it writes names the real path
  // a later boot (or a later switch to isolation) reads it back by, and goes on without the home if it can't.
  if (requiresRecord) fs.mkdirSync(options.home, { recursive: true });
  else if (options.persist !== false) {
    try { fs.mkdirSync(options.home, { recursive: true }); } catch { /* inheritance is advisory; see the write below */ }
  }
  const home = canonical(options.home);
  const stateFile = path.join(home, "tmux-server.json");
  const marker: ReturnType<typeof readPinMarker> = options.persist === false ? { active: false } : readPinMarker(home);
  let previous: ServerRecord | null = null;
  let readableRecord = true;
  if (options.persist !== false) {
    try { previous = readRecord(stateFile, home); }
    catch (error) {
      if (requiresRecord || marker.active || marker.error || (error as { pinned?: boolean }).pinned) throw error;
      // Default inheritance never depended on this file. Do not turn an old
      // advisory record into a boot refusal, or overwrite it while unreadable.
      readableRecord = false;
    }
    if (!previous && (marker.active || (marker.legacy && requiresRecord))) {
      throw new Error(`Missing tmux server record ${stateFile} after server selection; restore it before starting this instance.`);
    }
    if (marker.error && (!previous || previous.pinned || requiresRecord)) throw marker.error;
  }
  const inherited = inheritedTmuxSocket(env, uid);
  const namespace = "openrig-" + createHash("sha256").update(home).digest("hex").slice(0, 20);
  const isolated = previous?.isolatedSocketPath
    ?? path.join(canonical(env.TMUX_TMPDIR?.trim() || "/tmp"), `tmux-${uid}`, namespace);
  const previousDesktop = previous?.version === 2 ? previous.socketPath : undefined;
  let trackedDesktop = previousDesktop;
  const dormant = previous?.desktopBootstrapSocket;
  if (!trackedDesktop && platform === "darwin" && typeof dormant === "string"
      && isDesktopServerPid(previous?.desktopServerPid) && isDesktopCommandSocket(dormant, previous?.desktopCommandSocket)
      && typeof previous?.desktopGeneration === "string" && /^[\da-f]{32}$/.test(previous.desktopGeneration)) {
    try {
      if (desktopTmuxSocketPath(dormant, home, uid) === dormant) trackedDesktop = dormant;
    } catch { /* Invalid or lost dormant endpoint cannot affect ordinary selection. */ }
  }
  const previousDesktopPid = trackedDesktop ? previous?.desktopServerPid : undefined;
  const previousDesktopBootId = trackedDesktop ? previous?.desktopBootId : undefined;
  const previousDesktopStartId = trackedDesktop ? previous?.desktopStartId : undefined;
  const previousDesktopCommandSocket = trackedDesktop ? previous?.desktopCommandSocket : undefined;
  const previousDesktopGeneration = trackedDesktop ? previous?.desktopGeneration : undefined;
  const previousDesktopAlive = () => previousDesktopPid !== undefined
    && !desktopServerExited(previousDesktopPid, previousDesktopBootId, previousDesktopStartId);
  const desktop = launcherSocket ?? (desktopRequest !== "off" ? previousDesktop : undefined);
  if (desktop && platform !== "darwin") throw new Error("This OpenRig home is pinned to a macOS desktop tmux server.");
  const desktopSocket = desktop && desktopTmuxSocketPath(desktop, home, uid);
  if (desktopSocket && !previous && options.registeredSessions.length > 0) {
    throw new Error("No previous tmux server record for this instance's registered seats. First boot without the desktop launcher on the original server to establish its record; no seats were moved.");
  }
  const requestedMode = desktopSocket ? "isolated" : options.mode;
  const desired = desktopSocket ?? (requestedMode === "isolated" ? isolated : inherited);
  const oldSocket = previous?.socketPath ?? inherited;
  let mode: TmuxServerMode = requestedMode;
  let socketPath = desired;
  let useDesktop = desktopSocket !== undefined;
  let migrationPending = false;
  let blockingSessions: string[] = [];
  let note: string | undefined;

  const inspectOld = (requestedMode === "isolated" || previous?.pinned) && options.registeredSessions.length > 0;
  const leavingDesktop = previousDesktop !== undefined && desktopSocket === undefined;
  let sameSocket = oldSocket === desired;
  if (!sameSocket && (desktopSocket || previousDesktop) && (inspectOld || leavingDesktop)) {
    try { sameSocket = realpathWithMissingParents(oldSocket) === realpathWithMissingParents(desired); }
    catch { /* Let inspection classify the old endpoint; its pathname may no longer resolve. */ }
  }
  if (inspectOld && desktopSocket && previous?.version === 1 && (sameSocket || sameSocketInode(oldSocket, desired))) {
    throw new Error("The previous record names the desktop socket but cannot verify its server identity. Reconcile the registered seats on the original server before starting with --desktop-tmux.");
  }
  if (!desktopSocket && trackedDesktop && ((leavingDesktop && sameSocket) || desired === trackedDesktop
      || desired === previousDesktopCommandSocket || sameSocketInode(trackedDesktop, desired)
      || (previousDesktopCommandSocket && sameSocketInode(previousDesktopCommandSocket, desired)))) {
    throw new Error("To leave the desktop tmux server, start the daemon from outside that server.");
  }
  if (inspectOld && !sameSocket) {
    let observation: ServerInspection;
    if (previousDesktop !== undefined && previousDesktopPid !== undefined) {
      if (previousDesktopAlive()) {
        const observed = await observeDesktopTmuxServer(oldSocket, home, uid, env, true, previousDesktopCommandSocket).catch(() => undefined)
          ?? await observeDesktopTmuxServer(oldSocket, home, uid, env, true).catch(() => undefined);
        observation = observed && observed.pid === previousDesktopPid && observed.generation === previousDesktopGeneration
          ? sessionInventory(observed.rows) : { state: "unavailable" };
      } else observation = { state: "absent" };
    } else {
      observation = await (options.inspect ?? inspectTmuxServer)(oldSocket);
    }
    const registered = new Set(options.registeredSessions);
    if (observation.state === "available") {
      // Legacy sessions without an owner marker remain conservative blockers.
      // An explicit other home can reuse our canonical names without owning our seats.
      blockingSessions = observation.sessions
        .filter(session => registered.has(session.name) && (!session.home || canonical(session.home) === home))
        .map(session => session.name);
    }
    // v1 stores a pathname, not a server identity. Its inventory can show a
    // blocker but cannot prove that no registered seats remain on the original server.
    if (desktopSocket && previous?.version === 1 && observation.state !== "unavailable" && !blockingSessions.length) {
      throw new Error(`The previous tmux server at ${JSON.stringify(oldSocket)} cannot be verified for this instance's registered seats. Restore the original socket or verify the previous server stopped and reconcile the registered seats before switching.`);
    }
    if (observation.state === "unavailable" || blockingSessions.length > 0) {
      socketPath = oldSocket;
      mode = previous?.mode ?? "inherit";
      useDesktop = previousDesktop !== undefined;
      migrationPending = true;
      note = observation.state === "unavailable"
        ? "The previous tmux server could not be inspected; it remains selected. Retry the daemon restart when it is reachable."
        : "Registered sessions still use the previous tmux server. Stop those sessions deliberately, then restart the daemon to apply the requested server.";
    }
  }

  const fixed = mode === "isolated" || migrationPending;
  let desktopServerPid: number | undefined;
  let desktopBootId: string | undefined;
  let desktopStartId: string | undefined;
  let desktopCommandSocket: string | undefined;
  let createdDesktopCommandSocket: string | undefined;
  let desktopGeneration: string | undefined;
  if (useDesktop) {
    const kept = trackedDesktop === socketPath && previousDesktopCommandSocket
      ? await observeDesktopTmuxServer(socketPath, home, uid, env, false, previousDesktopCommandSocket).catch(() => undefined) : undefined;
    if (kept && kept.pid === previousDesktopPid && kept.generation === previousDesktopGeneration && previousDesktopAlive()) {
      ({ pid: desktopServerPid, bootId: desktopBootId, startId: desktopStartId, generation: desktopGeneration } = kept);
      desktopCommandSocket = previousDesktopCommandSocket;
    } else {
      const linked = linkDesktopCommandSocket(socketPath, home, uid);
      try {
        // Verify through the link itself, so the checked inode is exactly the one commands will use.
        ({ pid: desktopServerPid, bootId: desktopBootId, startId: desktopStartId, generation: desktopGeneration } =
          await observeDesktopTmuxServer(socketPath, home, uid, env, false, linked));
        if ((desktopServerPid !== previousDesktopPid || desktopGeneration !== previousDesktopGeneration) && previousDesktopAlive()) {
          throw new Error(`The previous desktop tmux PID ${previousDesktopPid} may still be running. Recover its socket before selecting another server.`);
        }
        desktopCommandSocket = createdDesktopCommandSocket = linked;
      } catch (err) {
        fs.rmSync(linked, { force: true });
        throw err;
      }
    }
    if (desktopServerPid === previousDesktopPid && desktopGeneration === previousDesktopGeneration) {
      desktopBootId ??= previousDesktopBootId;
      desktopStartId ??= previousDesktopStartId;
    }
  } else if (fixed) {
    // -S does not create tmux's usual per-user directory. The inherited path
    // keeps tmux's own directory and length handling, as it did before selection.
    const socketLimit = platform === "darwin" ? 104 : 108;
    if (Buffer.byteLength(socketPath) >= socketLimit) {
      throw new Error("The selected tmux socket path is too long. Use a shorter TMUX_TMPDIR before first enabling isolation.");
    }
    fs.mkdirSync(path.dirname(socketPath), { recursive: true, mode: 0o700 });
  }
  const executionArgs = fixed ? [useDesktop ? DESKTOP_TMUX_SOCKET_FLAG : "-S", desktopCommandSocket ?? socketPath] : [];
  if (options.persist !== false && readableRecord) {
    // The old bootstrap pathname can already point at a new generation. Only
    // retire the private recorded link, and only if its inode hasn't changed.
    const relinkedSameServer = useDesktop && desktopServerPid === previousDesktopPid
      && desktopGeneration === previousDesktopGeneration;
    const retired = previousDesktopCommandSocket && previousDesktopPid !== undefined
      && previousDesktopCommandSocket !== desktopCommandSocket && (!previousDesktopAlive() || relinkedSameServer)
      ? previousDesktopCommandSocket : undefined;
    let retiredInode: fs.Stats | undefined;
    if (retired) {
      try { retiredInode = fs.lstatSync(retired); } catch { /* Optional cleanup. */ }
    }
    let committed = false;
    const pinned = executionArgs.length > 0;
    const strict = pinned || previous?.pinned || marker.active;
    try {
      writeRecord(stateFile, { version: useDesktop ? 2 : 1, home, mode, pinned, socketPath,
        ...(useDesktop ? { desktopServerPid, desktopBootId, desktopStartId, desktopCommandSocket, desktopGeneration }
          : trackedDesktop ? { desktopBootstrapSocket: trackedDesktop, desktopServerPid: previousDesktopPid,
            desktopBootId: previousDesktopBootId, desktopStartId: previousDesktopStartId,
            desktopCommandSocket: previousDesktopCommandSocket, desktopGeneration: previousDesktopGeneration } : {}),
        ...(mode === "isolated" && !useDesktop ? { isolatedSocketPath: socketPath }
          : previous?.isolatedSocketPath ? { isolatedSocketPath: previous.isolatedSocketPath } : {}) }, useDesktop && !previous?.pinned);
      committed = true;
    } catch (error) {
      if (createdDesktopCommandSocket) {
        try { fs.unlinkSync(createdDesktopCommandSocket); } catch { /* Preserve the original write error. */ }
      }
      if (strict) throw error;
      // Inherited selection is advisory; an unwritable home must not change it.
    }
    if (committed && retired && retiredInode?.isSocket() && (await inspectTmuxServer(retired)).state === "absent") {
      try {
        const current = fs.lstatSync(retired);
        if (current.isSocket() && current.uid === uid && current.dev === retiredInode.dev && current.ino === retiredInode.ino) {
          fs.unlinkSync(retired);
        }
      } catch { /* The new selection is already committed; stale-link cleanup is optional. */ }
    }
  }
  return {
    requestedMode, mode, socketPath, executionArgs,
    ...(desktopSocket ? { requestedSource: "desktop" } : {}),
    ...(useDesktop ? { source: "desktop", remoteMode: options.mode,
      confirmDesktopExit: () => desktopServerExited(desktopServerPid, desktopBootId, desktopStartId) } : {}),
    serverArgs: executionArgs.length > 0 ? [...executionArgs] : tmuxServerArgs(env, uid),
    migrationPending, blockingSessions, ...(note ? { note } : {}),
  };
}
