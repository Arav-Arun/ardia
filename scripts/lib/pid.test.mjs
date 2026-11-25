import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { groupAlive, isAlive, signalProbe } from "./pid.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../..");
const failing = (code) => () => {
  throw Object.assign(new Error(code), { code });
};

test("EPERM from signal 0 means the process exists, ESRCH means it's gone", () => {
  assert.equal(signalProbe(() => true)(42), true);
  assert.equal(signalProbe(failing("EPERM"))(42), true);
  assert.equal(signalProbe(failing("ESRCH"))(42), false);
  assert.equal(signalProbe(failing("EINVAL"))(42), false);
});

test("isAlive answers for real pids and refuses ones that would signal a group", () => {
  assert.equal(isAlive(process.pid), true);
  assert.equal(isAlive(2 ** 30), false);
  for (const pid of [0, -1, -process.pid, NaN, 1.5, String(process.pid), null, undefined]) assert.equal(isAlive(pid), false, String(pid));
  for (const pgid of [0, 1, -5, NaN, null]) assert.equal(groupAlive(pgid), false, String(pgid));
});

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
const sandboxed = (args, timeout = 20_000) => spawnSync("/usr/bin/sandbox-exec", ["-p", PROFILE, ...args], { encoding: "utf8", timeout });
const canSandbox = process.platform === "darwin" && existsSync("/usr/bin/sandbox-exec") && sandboxed(["/usr/bin/true"]).status === 0;

test("inside a macOS sandbox that forbids signals, a live process outside it still reads as alive", { skip: !canSandbox && "needs macOS sandbox-exec outside a sandbox" }, async (t) => {
  const outside = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  t.after(() => outside.kill("SIGKILL"));
  await new Promise((resolve) => outside.once("spawn", resolve));
  const gone = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  const deadPid = Number(gone.stdout);

  const raw = sandboxed([process.execPath, "-e", `try { process.kill(${outside.pid}, 0); console.log("ok"); } catch (e) { console.log(e.code); }`]);
  assert.equal(raw.stdout.trim(), "EPERM", raw.stderr);

  const probe = `import(${JSON.stringify(pathToFileURL(join(repo, "scripts/lib/pid.mjs")).href)}).then(({ isAlive }) => console.log(JSON.stringify([isAlive(${outside.pid}), isAlive(${deadPid})])))`;
  const node = sandboxed([process.execPath, "-e", probe]);
  assert.equal(node.stdout.trim(), "[true,false]", node.stderr);

  const await_ = join(repo, "scripts/agent/await");
  const waiting = sandboxed([await_, "--timeout", "2", "--every", "0.2", "--quiet", "--pid", String(outside.pid), "--", "false"]);
  assert.equal(waiting.status, 124, waiting.stderr);
  const died = sandboxed([await_, "--timeout", "5", "--every", "0.2", "--quiet", "--pid", String(deadPid), "--", "false"]);
  assert.equal(died.status, 3, died.stderr);
  assert.match(died.stderr, new RegExp(`pid ${deadPid} exited`));
});
