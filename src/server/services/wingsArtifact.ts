import fs from "fs-extra";
import path from "path";

const CANDIDATES = [
  path.join(process.cwd(), "src", "wings", "wings.cjs"),
  path.join(process.cwd(), "..", "src", "wings", "wings.cjs"),
  path.join(process.cwd(), "dist", "src", "wings", "wings.cjs"),
];

async function resolveWingsDaemonPath(): Promise<string> {
  for (const candidate of CANDIDATES) {
    if (await fs.pathExists(candidate)) return candidate;
  }
  throw new Error("Wings daemon source not found. Looked in: " + CANDIDATES.join(", "));
}

/**
 * Serve the Wings daemon straight from source so the installer always downloads the
 * artifact that matches this panel build.
 */
export async function getWingsDaemonSource(): Promise<{ path: string; content: string }> {
  const filePath = await resolveWingsDaemonPath();
  const content = await fs.readFile(filePath, "utf8");
  if (!content.trim()) {
    throw new Error(`Wings daemon source is empty: ${filePath}`);
  }
  return { path: filePath, content };
}