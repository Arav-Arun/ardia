import type { Shortcut } from "./shortcuts";

export type ShortcutRecorder = {
  readonly recording: boolean;
  take(): Promise<Shortcut | null | undefined>;
  stop(): void;
};

export function shortcutRecorder(record: () => Promise<Shortcut | null>, cancel: () => unknown): ShortcutRecorder {
  let active: number | null = null;
  let sessions = 0;
  return {
    get recording() {
      return active !== null;
    },
    async take() {
      if (active !== null) return undefined;
      const session = ++sessions;
      active = session;
      const combo = await record();
      if (active !== session) return undefined;
      active = null;
      return combo;
    },
    stop() {
      if (active === null) return;
      active = null;
      void cancel();
    },
  };
}
