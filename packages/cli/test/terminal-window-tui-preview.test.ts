// The TUI's "Open terminals" path end to end: the TUI's preview, its planId passed as the expected plan, and the CLI
// window opener with the provider omitted (`rig terminal open --window --expected-plan <planId> -- <view>`).
// Real: the daemon's terminal routes and TerminalService (provider selection, composition, plan hashing) over
// localhost, the TUI and CLI daemon clients, and the window opener's plain-tmux fallback on an isolated tmux server.
// Stubbed: the provider adapters' status and liveness, the Herdr binary probe, and the macOS desktop launcher
// (osascript), which records its command instead of opening a window.
import { afterEach, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { DaemonClient as CliClient } from "../src/client.js";
import { openTerminalWindow, type WindowDeps } from "../src/terminal-window.js";
import { DaemonClient as TuiClient } from "../../tui/src/daemon-client.js";
import { terminalRoutes } from "../../daemon/src/routes/terminal.js";
import { TerminalService } from "../../daemon/src/domain/terminal/terminal-service.js";
import { HERDR_PANES_PER_PAGE } from "../../daemon/src/domain/terminal/herdr-adapter.js";
import type { TerminalProvider } from "../../daemon/src/domain/terminal/terminal-provider.js";
import { setDaemonTmuxServer } from "../../daemon/src/adapters/tmux-server.js";

vi.mock("../src/local-origin.js", () => ({ readLocalOrigin: () => "window-fixture" }));

const env = { ...process.env }; delete env["TMUX"];
const desktopSupported = (() => {
  try { execFileSync("tmux", ["-N", "-V"], { env, stdio: "ignore", timeout: 2_000, killSignal: "SIGKILL" }); return true; }
  catch { return false; }
})();
const sockets: string[] = [];
const dirs: string[] = [];
const servers: Array<{ close(): void }> = [];
function tmux(socket: string, args: string[]): string {
  return execFileSync("tmux", ["-L", socket, "-f", "/dev/null", ...args], { encoding: "utf8", env, timeout: 5000 });
}
afterEach(() => {
  setDaemonTmuxServer([]);
  for (const server of servers.splice(0)) server.close();
  for (const socket of sockets.splice(0)) { try { tmux(socket, ["kill-server"]); } catch { /* already gone */ } }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function fixture(herdrAvailable: boolean, selection?: "desktop" | "pending") {
  const id = randomUUID().slice(0, 12);
  const source = `src-${id}`, viewer = `view-${id}`;
  sockets.push(source, viewer);
  const dir = mkdtempSync(path.join(tmpdir(), "tui-window-"));
  dirs.push(dir);
  const wrapper = path.join(dir, "tmux");
  writeFileSync(wrapper, `#!/bin/sh\nexec tmux -L ${source} -f /dev/null "$@"\n`, { mode: 0o755 });
  const seats = ["seat0", "seat1"];
  for (const seat of seats) tmux(source, ["new-session", "-d", "-s", seat, "sleep 120"]);
  tmux(viewer, ["new-session", "-d", "-s", "viewer-fixture", "sleep 120"]);
  tmux(viewer, ["set-option", "-g", "default-size", "120x40"]);
  const socketPath = selection ? tmux(source, ["display-message", "-p", "#{socket_path}"]).trim() : undefined;
  const serverArgs = socketPath ? [selection === "desktop" ? "-NS" : "-S", socketPath] : [];
  if (selection) setDaemonTmuxServer(serverArgs, { requestedMode: "isolated", requestedSource: "desktop", socketPath,
    serverArgs, executionArgs: serverArgs, ...(selection === "desktop" ? { mode: "isolated", source: "desktop",
      migrationPending: false, blockingSessions: [] } : { mode: "inherit", migrationPending: true, blockingSessions: seats }) });
  const providerOpens: string[] = [];
  const provider = (name: string, available: boolean, panesPerPage?: number): TerminalProvider => ({
    name, ...(panesPerPage ? { panesPerPage } : {}),
    status: async () => ({ provider: name, available, capabilities: { layout: true } }),
    liveness: async () => ({ alive: available }),
    openView: async (view) => {
      providerOpens.push(name);
      return { provider: name, ok: true, opened: view.opened.map(p => p.seat), absent: view.absent, degraded: view.degraded, pages: view.pages.length };
    },
  });
  const providers: Record<string, TerminalProvider> = { herdr: provider("herdr", herdrAvailable, HERDR_PANES_PER_PAGE), cmux: provider("cmux", true) };
  const saved = { id: "fixture", name: "Fixture", members: seats.map(seat => ({ seat, tmuxSession: seat })) };
  const service = new TerminalService({
    resolveProvider: name => providers[name] ?? null,
    viewsStore: { get: viewId => (viewId === "fixture" ? saved : null), list: () => [saved] },
    listRigSeats: () => null, listPodSeats: () => null, listScopeSeats: () => null, listRigNames: () => [],
    resolveHost: () => null, hasSession: () => true, resolveLocalTmux: () => wrapper,
    tmuxServerArgs: () => serverArgs,
  } as ConstructorParameters<typeof TerminalService>[0]);
  const app = new Hono();
  app.get("/healthz", c => c.json({ selfHostId: "window-fixture" }));
  app.use("*", async (c, next) => { (c.set.bind(c) as (k: string, v: unknown) => void)("terminalService", service); await next(); });
  app.route("/api/terminal", terminalRoutes());
  const port = await new Promise<number>(resolve => {
    servers.push(serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 }, info => resolve(info.port)));
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const launched: string[] = [];
  const deps: WindowDeps = {
    herdrConfig: () => { throw new Error("tmux must not prepare Herdr config"); },
    platform: "darwin", env: { TERM_PROGRAM: "Apple_Terminal", HOME: dir }, exists: () => false,
    exec: async (file, args) => {
      if (file === "herdr" || file.endsWith("/herdr")) throw new Error("herdr: not installed");
      if (file === "/bin/sh") return "tmux";
      if (file === "/usr/bin/osascript") { launched.push(args.join(" ")); return "window"; }
      if (file === "tmux") return tmux(viewer, args);
      throw new Error(`unexpected executable ${file}`);
    },
    launch: async () => {}, sleep: async () => {}, id: () => id,
  };
  const sessions = (socket: string) => tmux(socket, ["list-sessions", "-F", "#{session_name}"]).trim().split("\n");
  const viewCreated = () => sessions(socketPath ? source : viewer).includes(`openrig-view-${id}`);
  return { baseUrl, saved, deps, launched, providerOpens, viewCreated, socketPath, otherSessions: () => sessions(viewer) };
}

it("with no Herdr and a live cmux, Open terminals reaches the plain-tmux window", async () => {
  const f = await fixture(false);
  const preview = await new TuiClient({ baseUrl: f.baseUrl }).previewTerminal("saved:fixture");
  const result = await openTerminalWindow(new CliClient(f.baseUrl), "saved:fixture", undefined, f.deps, preview.planId);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, provider: "tmux", opened: ["seat0", "seat1"] });
  expect(f.viewCreated()).toBe(true);
  expect(f.launched).toHaveLength(1);
  expect(f.providerOpens).toEqual([]);
});

it.skipIf(!desktopSupported)("passes the launcher-owned endpoint through the TUI preview and tmux viewer, without using another server", async () => {
  const f = await fixture(false, "desktop");
  const preview = await new TuiClient({ baseUrl: f.baseUrl }).previewTerminal("saved:fixture");
  expect(preview).toMatchObject({ tmux: { source: "desktop", migrationPending: false } });
  const result = await openTerminalWindow(new CliClient(f.baseUrl), "saved:fixture", undefined, f.deps, preview.planId);
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true, provider: "tmux", opened: ["seat0", "seat1"] });
  expect(f.viewCreated()).toBe(true);
  expect(f.otherSessions()).toEqual(["viewer-fixture"]);
  expect(f.launched).toHaveLength(1);
  expect(f.launched[0]).toContain("-NS");
  expect(f.launched[0]).toContain(f.socketPath!);
  expect(result.notes?.join("\n")).not.toContain("switch is deferred");
});

it("keeps existing attachments and explains a deferred switch without a launcher environment", async () => {
  const f = await fixture(false, "pending");
  const client = new CliClient(f.baseUrl);
  const preview = await new TuiClient({ baseUrl: f.baseUrl }).previewTerminal("saved:fixture");
  const result = await openTerminalWindow(client, "saved:fixture", undefined, f.deps, preview.planId);
  expect(result).toMatchObject({ ok: true, opened: ["seat0", "seat1"] });
  expect(result.notes?.join("\n")).toMatch(/switch is deferred: live seats.*\n[\s\S]*rig daemon start --desktop-tmux/);
  expect(f.viewCreated()).toBe(true);
  expect(f.otherSessions()).toEqual(["viewer-fixture"]);
  expect(f.launched[0]).toContain(f.socketPath!);
  const direct = await client.post<typeof result>("/api/terminal/open", { view: "saved:fixture", provider: "cmux" });
  expect(direct.data).toMatchObject({ ok: true, opened: ["seat0", "seat1"] });
  expect(direct.data.notes?.join("\n")).toContain("switch is deferred: live seats");
});

it("with Herdr available, the TUI preview's plan is the one the window opener checks, as before", async () => {
  const f = await fixture(true);
  const tui = await new TuiClient({ baseUrl: f.baseUrl }).previewTerminal("saved:fixture");
  const fetchPlan = async (query: string) => ((await (await fetch(`${f.baseUrl}/api/terminal/preview?view=saved%3Afixture${query}`)).json()) as { planId: string; provider: string });
  const providerless = await fetchPlan("");
  const windowOpener = await fetchPlan("&provider=herdr");
  expect(providerless.provider).toBe("herdr");
  expect(tui.planId).toBe(providerless.planId);
  expect(tui.planId).toBe(windowOpener.planId);
});

it("a view that really changed after the preview is still refused, without a window or a tmux view", async () => {
  const f = await fixture(false);
  const preview = await new TuiClient({ baseUrl: f.baseUrl }).previewTerminal("saved:fixture");
  f.saved.members = f.saved.members.slice(0, 1);
  const result = await openTerminalWindow(new CliClient(f.baseUrl), "saved:fixture", undefined, f.deps, preview.planId);
  expect(result.ok).toBe(false);
  expect(result.error).toContain("The terminal view changed since preview");
  expect(f.launched).toEqual([]);
  expect(f.viewCreated()).toBe(false);
});

it("a provider-less open that isn't a window still chooses cmux when Herdr isn't available", async () => {
  const f = await fixture(false);
  const response = await fetch(`${f.baseUrl}/api/terminal/open`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ view: "saved:fixture" }) });
  const result = await response.json() as { provider: string; ok: boolean };
  expect(result).toMatchObject({ provider: "cmux", ok: true });
  expect(f.providerOpens).toEqual(["cmux"]);
});
