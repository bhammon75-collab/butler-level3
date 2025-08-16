// at top
import express from "express";
import cors from "cors";
// ... keep your other imports
// ---- Butler hardening helpers (paste once) -------------------------------
import type express from "express";

// Wrap async route handlers so thrown errors become JSON 500s instead of hanging
export const asyncHandler =
  (fn: express.RequestHandler) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// Require the Butler token; sends 401 JSON instead of letting routes proceed
export function requireButlerToken(
  req: express.Request,
  res: express.Response,
  next: express.NextFunction
) {
  const hdr = req.header("X-Butler-Token") || "";
  const expected = process.env.BUTLER_TOKEN || "";
  if (!expected || hdr !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// Add a per-request timeout (default 15s). If a handler hangs, we still reply.
export function installTimeoutGuard(app: express.Express, ms = 15_000) {
  app.use((req, res, next) => {
    let finished = false;
    res.on("finish", () => (finished = true));
    res.setTimeout(ms, () => {
      if (!finished) {
        console.error("request timeout", { path: req.path, ms });
        try {
          res.status(504).json({ ok: false, error: "timeout" });
        } catch {
          /* ignore double-send */
        }
      }
    });
    next();
  });
}

// Global JSON error handler (put AFTER routes are declared)
export function installJsonErrorHandler(app: express.Express) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const msg = typeof err?.message === "string" ? err.message : "internal_error";
    console.error("unhandled route error:", err);
    res.status(500).json({ ok: false, error: "internal_error", message: msg });
  });
}
// -------------------------------------------------------------------------

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

// 1) Wrap async routes so exceptions become JSON errors
const asyncHandler =
  (fn: express.RequestHandler) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// 2) Per-request timeout guard (15s)
app.use((req, res, next) => {
  // only fire once
  let sent = false;
  res.on("finish", () => (sent = true));
  res.setTimeout(15_000, () => {
    if (!sent) {
      console.error("plan/apply timeout", { path: req.path });
      try {
        res.status(504).json({ ok: false, error: "timeout" });
      } catch {}
    }
  });
  next();
});

// 3) AUTH check middleware for Butler token (adjust to your env)
function requireToken(req: express.Request, res: express.Response, next: express.NextFunction) {
  const token = req.header("X-Butler-Token") ?? "";
  if (!token || token !== (process.env.BUTLER_TOKEN || "")) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

// 4) PURE /plan that never talks to GitHub — returns fast
app.post(
  "/plan",
  requireToken,
  asyncHandler(async (req, res) => {
    const t0 = Date.now();
    const { goal, repo, baseBranch } = req.body || {};
    if (!goal || !repo?.owner || !repo?.name || !baseBranch) {
      return res.status(400).json({
        ok: false,
        error: "bad_request",
        details: "missing goal/repo/baseBranch",
      });
    }

    const plan = {
      title: `Butler: ${goal}`,
      summary: `Proposed changes for: ${goal}`,
      repo,
      baseBranch,
      branch: `butler/${Date.now()}`,
      labels: ["butler"],
      runChecks: true,
      edits: [], // planning only
    };

    console.log("plan ok", { ms: Date.now() - t0 });
    return res.json({
      ok: true,
      plan,
      hints: {
        allowlistEnforcedAtApply: true,
        workflowEditsRequireHeader: "X-Butler-Approve-Workflows",
      },
    });
  })
);

// 5) keep your /apply as-is, but also wrap with asyncHandler and requireToken
// app.post("/apply", requireToken, asyncHandler(async (req, res) => { ... }));

// 6) Global JSON error handler
// (must be AFTER routes)
app.use(
  (err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("unhandled", err);
    const msg = typeof err?.message === "string" ? err.message : "internal_error";
    res.status(500).json({ ok: false, error: "internal_error", message: msg });
  }
);
