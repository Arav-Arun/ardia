import { configure } from "./actions";
import { consentToken } from "../telemetry/client";
import { noteExtensionSiteChange } from "../telemetry/usage";
import { extensionSitePattern } from "./sitePatterns";

export { extensionSiteLabel, extensionSitePattern } from "./sitePatterns";

export async function addExtensionSite(profile: string, id: string, typed: string): Promise<string | null> {
  const site = extensionSitePattern(typed);
  if (!site) return "Enter a site like example.com or https://*.example.com.";
  const consent = consentToken();
  const done = await configure(profile, id, { siteAccess: "specificSites", grantSite: site });
  noteExtensionSiteChange(done ? "added" : "failed", consent);
  return done ? null : "Ardia couldn't give the extension access to that site.";
}

export async function removeExtensionSite(profile: string, id: string, site: string): Promise<boolean> {
  const consent = consentToken();
  const done = await configure(profile, id, { revokeSite: site });
  noteExtensionSiteChange(done ? "removed" : "failed", consent);
  return done;
}

export const noteExtensionSitePickerCancelled = () => noteExtensionSiteChange("cancelled");
