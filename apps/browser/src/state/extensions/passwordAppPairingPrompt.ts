import { onExtensionInstallPrompt, onExtensionsChanged } from "../../platform/extensions";
import { showToast } from "../app/toasts";
import { openFile } from "../app/system";
import { useBrowser } from "../browser/store";
import { focusedWindowOf } from "../windows/ui";
import { notePasswordAppPairing } from "../telemetry/usage";
import { consentToken, type ConsentToken } from "../telemetry/client";
import { passwordAppPairing } from "./passwordAppPairing";

export const ONE_PASSWORD_EXTENSION_IDS: ReadonlySet<string> = new Set([
  "aeblfdkhhhdcdjpifhhbdiojplfjncoa",
  "khgocmkkpikpnmmkgmdnfckapcdkgfaf",
  "gejiddohjgogedgjnonbofjigllpkmbf",
  "hjlinigoblmkhjejkmbegnoaljkphmgo",
  "dppgmdbiimibapkepcbdbmkaabgiofem",
]);

export const pairsWithPasswordApp = (extensionId: string) => ONE_PASSWORD_EXTENSION_IDS.has(extensionId);

export function openPasswordApp(appPath: string) {
  notePasswordAppPairing("opened");
  void openFile(appPath);
}

const asked = new Map<string, ConsentToken | null>();
let watching = false;

export function watchPasswordAppPairing() {
  if (watching) return;
  watching = true;
  onExtensionInstallPrompt((prompt) => {
    if (pairsWithPasswordApp(prompt.id)) asked.set(`${prompt.profile}\n${prompt.id}`, consentToken());
  });
  onExtensionsChanged((e) => {
    const key = `${e.profile}\n${e.id}`;
    if (e.event !== "installed" || !asked.has(key)) return;
    const consent = asked.get(key) ?? null;
    asked.delete(key);
    const pairing = passwordAppPairing();
    const windowId = focusedWindowOf(useBrowser.getState());
    if (!pairing || !windowId) return;
    notePasswordAppPairing("shown", consent);
    const { appPath } = pairing;
    showToast(windowId, pairing.title, pairing.steps, {
      icon: "key.fill",
      key: "passwordAppPairing",
      sticky: true,
      titleLines: 1,
      ...(appPath ? { action: { title: "Open 1Password", run: () => openPasswordApp(appPath) } } : {}),
    });
  });
}
