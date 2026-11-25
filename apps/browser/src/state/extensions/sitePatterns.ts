const MAX_SITE_LENGTH = 2048;
const SITE_ORIGIN = /^(\*|https?):\/\/((?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.?|\[(?!.*:::)[0-9a-f]*:[0-9a-f:.]*[0-9a-f][0-9a-f:.]*\])(:\d{1,5})?$/;
const WHOLE_SUFFIX = /^\*\.[a-z0-9-]+\.?$/;

export function extensionSitePattern(typed: string): string | null {
  const trimmed = typed.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_SITE_LENGTH || /\s/.test(trimmed)) return null;
  const withScheme = trimmed.includes("://") ? trimmed : `*://${trimmed}`;
  const schemeEnd = withScheme.indexOf("://") + 3;
  const originEnd = withScheme.slice(schemeEnd).search(/[/?#]/);
  const origin = originEnd < 0 ? withScheme : withScheme.slice(0, schemeEnd + originEnd);
  const match = SITE_ORIGIN.exec(origin);
  if (!match || WHOLE_SUFFIX.test(match[2] ?? "")) return null;
  const port = match[3] ? Number(match[3].slice(1)) : null;
  if (port !== null && (port < 1 || port > 65535)) return null;
  return `${origin}/*`;
}

export const extensionSiteLabel = (pattern: string) => pattern.replace(/^\*:\/\//, "").replace(/\/\*$/, "");
