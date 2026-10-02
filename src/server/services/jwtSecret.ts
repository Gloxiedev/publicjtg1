import crypto from "crypto";

/**
 * The secret that used to be hardcoded in this repository. It is public, so any
 * deployment still using it lets anyone forge an admin token.
 */
const KNOWN_INSECURE_DEFAULT = "jtg-panel-super-secret";

/**
 * The placeholder shipped in .env.example. It is public too, so accepting it
 * would give a freshly-cloned install a guessable signing key.
 */
const PUBLISHED_PLACEHOLDER = "your-secure-random-jwt-secret-here";

const MIN_SECRET_LENGTH = 32;

/**
 * Cached for non-production runs. Without this, every call site gets a
 * *different* random secret, so a token signed by one module fails to verify
 * in another and login silently breaks. This module is imported by several
 * files at module scope, so the cache has to live here.
 */
let ephemeralSecret: string | null = null;
let warned = false;

/**
 * Resolve the JWT signing secret.
 *
 * Unlike the previous inline `process.env.JWT_SECRET || "jtg-panel-super-secret"`,
 * this fails closed: a missing, still-default, or still-placeholder secret is a
 * hard error in production, because silently signing with a published key is an
 * auth bypass.
 *
 * In non-production a single cached random secret is generated so local
 * development still works without extra setup. Tokens stop validating on
 * restart, which is the correct trade-off for a dev process.
 */
export function getJwtSecret(): string {
  const configured = (process.env.JWT_SECRET || "").trim();

  if (!configured) {
    if (process.env.NODE_ENV === "production") {
      throw new Error(
        "JWT_SECRET is not set. Refusing to start because the panel would sign " +
          "tokens with a secret anyone can read. Set a unique value in .env, for " +
          "example: openssl rand -hex 32"
      );
    }
    if (!ephemeralSecret) {
      ephemeralSecret = crypto.randomBytes(48).toString("hex");
      console.warn(
        "[JTG] JWT_SECRET is not set. Using a random secret for this process " +
          "only; sessions will not survive a restart. Set JWT_SECRET in .env for production."
      );
    }
    return ephemeralSecret;
  }

  if (configured === KNOWN_INSECURE_DEFAULT) {
    throw new Error(
      "JWT_SECRET is still the published default value from the source code, " +
        "which allows anyone to forge admin sessions. Set a unique value in .env, " +
        "for example: openssl rand -hex 32"
    );
  }

  if (configured === PUBLISHED_PLACEHOLDER) {
    throw new Error(
      "JWT_SECRET is still the placeholder from .env.example, which is public. " +
        "Set a unique value in .env, for example: openssl rand -hex 32"
    );
  }

  if (configured.length < MIN_SECRET_LENGTH && process.env.NODE_ENV === "production") {
    throw new Error(
      `JWT_SECRET is too short (${configured.length} characters). Use at least ` +
        `${MIN_SECRET_LENGTH} characters, for example: openssl rand -hex 32`
    );
  }

  return configured;
}