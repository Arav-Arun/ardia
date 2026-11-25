import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const locked = join(dirname(fileURLToPath(import.meta.url)), "locked");
const canLock = process.platform !== "win32" && spawnSync("bash", ["-c", "command -v lockf || command -v flock"]).status === 0;

async function until(check, ms, what) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

test("AC_LOCKED_HELD naming a live process that isn't an ancestor doesn't skip the lock", { skip: !canLock && "needs lockf or flock" }, async (t) => {
  const root = mkdtempSync(join(tmpdir(), "locked-test-"));
  const env = { ...process.env, AC_LOCK_ROOT: root };
  delete env.AC_LOCKED_HELD;
  delete env.AC_LOCKED_INNER;
  delete env.AC_LOCKED_AS;
  const ready = join(root, "ready");
  const holder = spawn(locked, ["pod", "--wait", "10", "--", "bash", "-c", `touch ${ready}; sleep 60`], { env, stdio: "ignore", detached: true });
  const bystander = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => {
    for (const kill of [() => process.kill(-holder.pid, "SIGKILL"), () => bystander.kill("SIGKILL")]) try { kill(); } catch {}
    rmSync(root, { recursive: true, force: true });
  });
  await until(() => existsSync(ready), 10_000, "the holder to take the pod lock");

  const kernel = join(root, "ac-pod.lockf");
  const spoofed = spawnSync(locked, ["pod", "--wait", "1", "--", "echo", "RAN"], {
    env: { ...env, AC_LOCKED_HELD: `${bystander.pid} ${kernel}` },
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(spoofed.stdout.includes("RAN"), false, spoofed.stderr);
  assert.equal(spoofed.status, 75, spoofed.stderr);
  const holderGone = new Promise((resolve) => holder.once("exit", resolve));
  process.kill(-holder.pid, "SIGKILL");
  await holderGone;

  const nested = spawnSync(locked, ["pod", "--wait", "10", "--", "bash", "-c", `"${locked}" pod --wait 1 -- echo NESTED`], {
    env,
    encoding: "utf8",
    timeout: 30_000,
  });
  assert.equal(nested.status, 0, nested.stderr);
  assert.match(nested.stdout, /NESTED/);
  assert.match(nested.stderr, /already held by an enclosing call/);
});
