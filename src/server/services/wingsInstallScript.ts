import fs from "fs-extra";
import path from "path";

const CANDIDATES = [
  path.join(process.cwd(), "src", "wings", "wings-install.sh"),
  path.join(process.cwd(), "..", "src", "wings", "wings-install.sh"),
  path.join(process.cwd(), "dist", "src", "wings", "wings-install.sh"),
];

const PLACEHOLDER = "@PANEL_URL@";

/**
 * The installer is a real shell script shipped in the repo rather than a string
 * literal, so it stays syntax-checkable and readable. Only the panel URL is
 * templated, and it is validated as an http(s) origin.
 */
export async function buildWingsInstallScript({ panelUrl }: { panelUrl: string }): Promise<string> {
  let url: URL;
  try {
    url = new URL(panelUrl);
  } catch {
    throw new Error(`Invalid panel URL: ${panelUrl}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`Panel URL must be http or https, got ${url.protocol}`);
  }

  let template: string | null = null;
  let found: string | null = null;
  for (const candidate of CANDIDATES) {
    if (await fs.pathExists(candidate)) {
      template = await fs.readFile(candidate, "utf8");
      found = candidate;
      break;
    }
  }
  if (template == null || found == null) {
    throw new Error("Wings install script not found. Looked in: " + CANDIDATES.join(", "));
  }
  if (!template.includes(PLACEHOLDER)) {
    throw new Error(`Wings install script is missing the ${PLACEHOLDER} placeholder: ${found}`);
  }

  // Strip anything that could break out of the double-quoted YAML/shell context.
  const safeUrl = url.origin.replace(/["\\$`'"\\]/g, "");
  return template.replace(PLACEHOLDER, safeUrl);
}