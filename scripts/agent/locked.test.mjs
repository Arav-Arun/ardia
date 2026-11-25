import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const locked = join(dirname(fileURLToPath(import.meta.url)), "locked");
const canLock = process.platform !== "win32" && spawnSync("bash", ["-c", "command -v lockf || command -v flock"]).status === 0;
const PROFILE = [
  "(version 1)",
  "(deny default)",
  "(allow process-exec)",
  "(allow process-fork)",
  "(allow file-read*)",
  '(allow file-write-data (literal "/dev/null"))',
  "(allow sysctl-read)",
  "(allow mach-lookup)",
  "(allow signal (target same-sandbox))",
].join("");
const canSandbox = canLock && process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && spawnSync("/usr/bin/sandbox-exec", ["-p", PROFILE, "/usr/bin/true"]).status === 0;

async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

function lockRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "locked-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, AC_LOCK_ROOT: root };
  for (const name of ["AC_LOCKED_HELD", "AC_LOCKED_INNER", "AC_LOCKED_AS", "AC_LOCKED_DEADLINE"]) delete env[name];
  return { root, env, kernel: join(root, "ac-pod.lockf") };
}

async function holdLock(t, root, env) {
  const ready = join(root, "ready");
  const gate = join(root, "gate");
  assert.equal(spawnSync("mkfifo", [gate]).status, 0);
  const holder = spawn(locked, ["pod", "--wait", "10", "--", "bash", "-c", `touch "${ready}"; read -r _ < "${gate}"`], { env, stdio: "ignore" });
  const exited = new Promise((resolve) => holder.once("exit", resolve));
  let released;
  const release = () => (released ??= (writeFileSync(gate, "\n"), exited));
  t.after(release);
  await until(() => existsSync(ready), 10_000, "the holder to take the pod lock");
  return release;
}

test("AC_LOCKED_HELD naming a live process that doesn't hold the lock doesn't skip it", { skip: !canLock && "needs lockf or flock" }, async (t) => {
  const { root, env, kernel } = lockRoot(t);
  const release = await holdLock(t, root, env);
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => bystander.kill("SIGKILL"));
  for (const held of [`${bystander.pid} ${kernel}`, `${bystander.pid} ${"0".repeat(32)} ${kernel}`]) {
    const spoofed = spawnSync(locked, ["pod", "--wait", "1", "--", "echo", "RAN"], { env: { ...env, AC_LOCKED_HELD: held }, encoding: "utf8", timeout: 20_000 });
    assert.equal(spoofed.stdout.includes("RAN"), false, spoofed.stderr);
    assert.equal(spoofed.status, 75, spoofed.stderr);
  }
  assert.equal(await release(), 0);
  assert.equal(existsSync(join(root, "ac-pod.held")), false, "the holder clears its record when it finishes");
});

test("a nested call runs inside the enclosing call's lock", { skip: !canLock && "needs lockf or flock" }, (t) => {
  const { env } = lockRoot(t);
  const nested = spawnSync(locked, ["pod", "--wait", "10", "--", locked, "pod", "--wait", "1", "--", "echo", "NESTED"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(nested.status, 0, nested.stderr);
  assert.match(nested.stdout, /NESTED/);
  assert.match(nested.stderr, /already held by an enclosing call/);
});

test("a nested call inside a macOS sandbox, where setuid ps can't run, still runs inside the enclosing lock", { skip: !canSandbox && "needs macOS sandbox-exec outside a sandbox" }, (t) => {
  const { env } = lockRoot(t);
  assert.notEqual(spawnSync("/usr/bin/sandbox-exec", ["-p", PROFILE, "/bin/ps", "-o", "ppid=", "-p", String(process.pid)]).status, 0, "the profile lets ps run, so this test proves nothing");
  const nested = spawnSync(locked, ["pod", "--wait", "10", "--", "/usr/bin/sandbox-exec", "-p", PROFILE, locked, "pod", "--wait", "2", "--", "echo", "NESTED"], { env, encoding: "utf8", timeout: 30_000 });
  assert.equal(nested.status, 0, nested.stderr);
  assert.match(nested.stdout, /NESTED/);
  assert.match(nested.stderr, /already held by an enclosing call/);
});
