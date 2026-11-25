import { urlParts } from "../../lib/urlParts";

const MAX_SITE_LENGTH = 2048;
const SCHEME = /^([a-z][a-z0-9+.-]*):\/\//i;
const DOTTED = /^\d{1,3}(\.\d{1,3}){3}$/;

function portOf(authority: string): string | null {
  const after = authority.startsWith("[") ? authority.slice(authority.indexOf("]") + 1) : authority;
  const colon = after.indexOf(":");
  return colon < 0 ? null : after.slice(colon + 1);
}

export function extensionSitePattern(typed: string): string | null {
  const trimmed = typed.trim();
  if (!trimmed || trimmed.length > MAX_SITE_LENGTH || /\s/.test(trimmed)) return null;
  const given = SCHEME.exec(trimmed);
  const scheme = given ? given[1]!.toLowerCase() : "*";
  if (scheme !== "*" && scheme !== "http" && scheme !== "https") return null;
  let rest = given ? trimmed.slice(given[0].length) : trimmed;
  const wildcard = rest.startsWith("*.");
  if (wildcard) rest = rest.slice(2);
  const authority = rest.split(/[/?#]/)[0] ?? "";
  const port = portOf(authority);
  if (port !== null && (scheme === "*" || !/^[1-9]\d{0,4}$/.test(port) || Number(port) > 65535)) return null;
  const parts = urlParts(`${scheme === "*" ? "https" : scheme}://${authority}/`);
  if (!parts?.host) return null;
  if (wildcard && (parts.host.startsWith("[") || DOTTED.test(parts.host) || !parts.host.replace(/\.$/, "").includes("."))) return null;
  return `${scheme}://${wildcard ? "*." : ""}${parts.host}${port !== null ? `:${port}` : ""}/*`;
}

export const extensionSiteLabel = (pattern: string) => pattern.replace(/^\*:\/\//, "").replace(/\/\*$/, "");
