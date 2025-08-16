// src/index.ts
import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { ENV } from "./lib/env";
import { isPathAllowed, isWorkflowPath, SAFE_WRITE_GLOBS } from "./lib/allowlist";

/** Resolve the GitHub App private key from env (supports BASE64 or raw PEM). */
function getPrivateKeyPEM(): string {
  const b64 = process.env.PRIVATE_KEY_BASE64;
  if (b64 && b64.trim()) {
    return Buffer.from(b64, "base64").toString("utf8");
  }
  return process.env.PRIVATE_KEY || "";
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/** Minimal request logging (method, path, status, duration) */
function requestLogger(req: Request, res: Response, next: NextFunction) {
  const start = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - start;
    console.log(`[butler] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
}
app.use(requestLogger);

/** Health check (no auth) */
app.get("/health", (_req: Request, res: Response) => {
  res.json({ ok: true });
});

/** Status (no auth): deployed commit + allowlist + uptime */
app.get("/status", (_req: Request, res: Response) => {
  const commit = process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || null;
  const uptimeSec = Math.round(process.uptime());
  res.json({ ok: true, commit, allowlist: SAFE_WRITE_GLOBS, uptimeSec, now: new Date().toISOString() });
});

/** Assert header secret */
function requireToken(req: Request, res: Response): boolean {
  const token = req.header("X-Butler-Token");
  if (!token || token !== ENV.BUTLER_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return false;
  }
  return true;
}

/** Build an Octokit client authenticated as your GitHub App installation */
function makeOctokit(): Octokit {
  const appId = Number(ENV.APP_ID);
  const installationId = Number(ENV.INSTALLATION_ID);
  if (!appId) throw new Error(`APP_ID missing or invalid: ${ENV.APP_ID}`);
  if (!installationId) throw new Error(`INSTALLATION_ID missing or invalid: ${ENV.INSTALLATION_ID}`);

  const privateKey = getPrivateKeyPEM();
  if (!privateKey || !privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
    throw new Error("Private key not configured correctly");
  }

  return new Octokit(
