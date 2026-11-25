export function signalProbe(signal) {
  return (target) => {
    try {
      signal(target, 0);
      return true;
    } catch (error) {
      return error?.code === "EPERM";
    }
  };
}

const probe = signalProbe((target, sig) => process.kill(target, sig));

export const isAlive = (pid) => Number.isSafeInteger(pid) && pid > 0 && probe(pid);

export const groupAlive = (pgid) => Number.isSafeInteger(pgid) && pgid > 1 && probe(-pgid);
