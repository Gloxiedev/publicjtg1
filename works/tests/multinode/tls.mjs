import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { TLS_DIR, CA_CERT } from "./harness.mjs";

/**
 * Generate a throwaway CA and per-node certificates so the HTTPS phase can verify
 * real chains. Verification is never disabled; the CA is only ever supplied as a trust
 * anchor to the specific client that is meant to trust it.
 */
export async function ensureTlsFixtures(hosts = ["node1.localhost", "node2.localhost"]) {
  const dir = TLS_DIR;
  mkdirSync(dir, { recursive: true });

  if (!existsSync(CA_CERT)) {
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "30", "-nodes",
      "-keyout", path.join(dir, "ca.key"),
      "-out", CA_CERT,
      "-subj", "/CN=JTG Local Test CA",
      "-addext", "basicConstraints=critical,CA:TRUE",
    ], { stdio: ["ignore", "ignore", "pipe"] });
  }

  for (const host of hosts) {
    const name = host.split(".")[0];
    const pem = path.join(dir, `${name}.pem`);
    if (existsSync(pem)) continue;

    execFileSync("openssl", [
      "req", "-newkey", "rsa:2048", "-nodes",
      "-keyout", path.join(dir, `${name}.key`),
      "-out", path.join(dir, `${name}.csr`),
      "-subj", `/CN=${host}`,
    ], { stdio: ["ignore", "ignore", "pipe"] });

    const ext = path.join(dir, `${name}.ext`);
    await fs.writeFile(
      ext,
      [
        `subjectAltName=DNS:${host},DNS:localhost,IP:127.0.0.1`,
        "basicConstraints=CA:FALSE",
        "extendedKeyUsage=serverAuth",
      ].join("\n") + "\n"
    );

    execFileSync("openssl", [
      "x509", "-req",
      "-in", path.join(dir, `${name}.csr`),
      "-CA", CA_CERT,
      "-CAkey", path.join(dir, "ca.key"),
      "-CAcreateserial",
      "-out", path.join(dir, `${name}.crt`),
      "-days", "30",
      "-sha256",
      "-extfile", ext,
    ], { stdio: ["ignore", "ignore", "pipe"] });

    // Wings expects a single file holding the leaf certificate followed by its key.
    const crt = await fs.readFile(path.join(dir, `${name}.crt`));
    const key = await fs.readFile(path.join(dir, `${name}.key`));
    await fs.writeFile(pem, crt.toString() + key.toString());
  }

  return { caCert: CA_CERT, tlsDir: dir };
}
