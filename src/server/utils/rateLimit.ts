import { Request, Response, NextFunction } from "express";
import crypto from "crypto";

/**
 * Fixed-window rate limiter.
 *
 * Deliberately dependency free and in-process: the panel runs as a single Node
 * process under PM2 (no cluster mode), so shared state is not required to make
 * this correct. The limits below exist to blunt credential guessing and
 * accidental event loops, not to survive a distributed flood.
 */
type Bucket = { count: number; resetAt: number };

const buckets = new Map<string, Bucket>();
let lastSweep = Date.now();

/** Drops expired buckets so a long-running panel cannot grow unbounded. */
function sweep(now: number): void {
  if (now - lastSweep < 60_000) return;
  lastSweep = now;
  for (const [key, bucket] of buckets) {
    if (bucket.resetAt <= now) buckets.delete(key);
  }
}

export function clientIp(req: Request): string {
  return req.ip || req.socket?.remoteAddress || "unknown";
}

/** Compares two secrets without leaking their length or prefix through timing. */
export function secretsMatch(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // timingSafeEqual requires equal lengths. Comparing fixed-size digests keeps
    // the length-mismatch path from returning measurably faster than a real
    // mismatch, which would itself leak the secret's length.
    const hashA = crypto.createHash("sha256").update(bufA).digest();
    const hashB = crypto.createHash("sha256").update(bufB).digest();
    return crypto.timingSafeEqual(hashA, hashB) && bufA.length === bufB.length;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

export function rateLimit(options: {
  windowMs: number;
  max: number;
  message: string;
  key?: (req: Request) => string;
}) {
  const keyFn = options.key || clientIp;
  return (req: Request, res: Response, next: NextFunction) => {
    const now = Date.now();
    sweep(now);

    const key = `${options.windowMs}:${keyFn(req)}`;
    let bucket = buckets.get(key);
    if (!bucket || bucket.resetAt <= now) {
      bucket = { count: 0, resetAt: now + options.windowMs };
      buckets.set(key, bucket);
    }
    bucket.count += 1;

    res.setHeader("X-RateLimit-Limit", String(options.max));
    res.setHeader("X-RateLimit-Remaining", String(Math.max(0, options.max - bucket.count)));
    res.setHeader("X-RateLimit-Reset", String(Math.ceil(bucket.resetAt / 1000)));

    if (bucket.count > options.max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((bucket.resetAt - now) / 1000))));
      res.status(429).json({ error: options.message });
      return;
    }
    next();
  };
}