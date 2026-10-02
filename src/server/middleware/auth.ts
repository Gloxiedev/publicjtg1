import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import { getJwtSecret } from "../services/jwtSecret.js";
const JWT_SECRET = getJwtSecret();

export const requireAdmin = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = authHeader.split(" ")[1];

  // API Key Authentication
  if (token.startsWith("jtg-") || token.startsWith("jtg_")) {
    try {
      const { readJSON, writeJSON } = await import("../services/db.js");
      const apiKeys = await readJSON("api_keys.json") || [];
      const keyHash = crypto.createHash('sha256').update(token).digest('hex');
      
      const apiKey = apiKeys.find((k: any) => k.key_hash === keyHash);
      if (!apiKey || apiKey.revoked) {
        res.status(401).json({ error: "Invalid or revoked API key" });
        return;
      }
      if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
        res.status(401).json({ error: "API key expired" });
        return;
      }

      // Update last_used_at
      apiKey.last_used_at = new Date().toISOString();
      await writeJSON("api_keys.json", apiKeys);

      // The key only carries the privileges of the account that created it, so
      // revoking or demoting that account must immediately revoke the key.
      const users = await readJSON("users.json") || [];
      const creator = users.find((u: any) => u.id === apiKey.created_by);
      if (!creator) {
        res.status(403).json({ error: "Forbidden: API Key creator no longer exists" });
        return;
      }
      if (creator.role !== "admin" && creator.role !== "owner") {
        res.status(403).json({ error: "Forbidden: API Key creator is no longer an admin" });
        return;
      }
      const adminRole = creator.role;

      (req as any).user = { id: apiKey.created_by, role: adminRole, isApiKey: true, scopes: apiKey.scopes };
      next();
      return;
    } catch (err) {
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    if (decoded.role !== 'admin' && decoded.role !== 'owner') {
       res.status(403).json({ error: "Forbidden: Admin access only" });
       return;
    }
    
    // Always re-check the account. Skipping this for a magic id would let a
    // deleted or demoted user keep admin access until the token expired.
    const { readJSON } = await import("../services/db.js");
    const users = await readJSON("users.json") || [];
    const user = users.find((u: any) => u.id === decoded.id);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    if ((user.passwordVersion || 0) !== (decoded.passwordVersion || 0)) {
      res.status(401).json({ error: "Session expired" });
      return;
    }
    // Trust the stored role, not the role baked into the token.
    decoded.role = user.role;
    
    (req as any).user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};

export const requireAuth = async (req: Request, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const token = authHeader.split(" ")[1];

  // API Key Authentication
  if (token.startsWith("jtg-") || token.startsWith("jtg_")) {
    try {
      const { readJSON, writeJSON } = await import("../services/db.js");
      const apiKeys = await readJSON("api_keys.json") || [];
      const keyHash = crypto.createHash('sha256').update(token).digest('hex');
      
      const apiKey = apiKeys.find((k: any) => k.key_hash === keyHash);
      if (!apiKey || apiKey.revoked) {
        res.status(401).json({ error: "Invalid or revoked API key" });
        return;
      }
      if (apiKey.expires_at && new Date(apiKey.expires_at) < new Date()) {
        res.status(401).json({ error: "API key expired" });
        return;
      }

      // Update last_used_at
      apiKey.last_used_at = new Date().toISOString();
      await writeJSON("api_keys.json", apiKeys);

      // Inherit the creator's current role. Defaulting to admin when the creator
      // cannot be found would silently escalate a key after the account is removed.
      const users = await readJSON("users.json") || [];
      const creator = users.find((u: any) => u.id === apiKey.created_by);
      if (!creator) {
        res.status(403).json({ error: "Forbidden: API Key creator no longer exists" });
        return;
      }
      const role = creator.role;

      (req as any).user = { id: apiKey.created_by, role, isApiKey: true, scopes: apiKey.scopes };
      next();
      return;
    } catch (err) {
      res.status(500).json({ error: "Internal Server Error" });
      return;
    }
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET) as any;
    
    const { readJSON } = await import("../services/db.js");
    const users = await readJSON("users.json") || [];
    const user = users.find((u: any) => u.id === decoded.id);
    if (!user) {
      res.status(401).json({ error: "User not found" });
      return;
    }
    if ((user.passwordVersion || 0) !== (decoded.passwordVersion || 0)) {
      res.status(401).json({ error: "Session expired" });
      return;
    }
    // Trust the stored role, not the role baked into the token.
    decoded.role = user.role;

    (req as any).user = decoded;
    next();
  } catch (err) {
    res.status(401).json({ error: "Invalid token" });
  }
};
