// src/index.ts
import express, {
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
} from "express";
import cors from "cors";
import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { ENV } from "./lib/env";
import { isPathAllowed, isWorkflowPath, SAFE_WRITE_GLOBS } from "./lib/allowlist";

/* -------------------------------------------------------------------------- */
/* Helpers: hardening + middleware                                            */
/* -------------------------------------------------------------------------- */

// Wrap async route handlers so thrown errors become JSON (no hangs)
const asyncHandler =
  (fn: RequestHandler): RequestHandler =>
  (req, res, next) =>
    Promise.resolve(fn(req, res, next)).catch(next);

// Per-request timeout guard (defaults 15s). If something hangs, reply 504 JSON.
function installTimeoutGuard(app: express.Express, ms = 15_000) {
  app.use((req, res, next) => {
    let finished = false;
    res.on("finish", () => (finished = true));
    res.setTimeout(ms, () => {
      if (!finished) {
        console.error("request timeout", { path: req.path, ms });
        try {
          res.status(504).json({ ok: false, error: "timeout" });
        } catch {
          /* ignore */
        }
      }
    });
    next();
  });
}

// Global JSON error handler (put AFTER routes)
function installJsonErrorHandler(app: express.Express) {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const message =
      typeof err === "object" && err && "message" in (err as any)
        ? (err as any).message
        : String(err);
    console.error("unhandled route error:", err);
    res.status(500).json({ ok: false, error: "internal_error", message });
  });
}

// Require Butler token; reply 401 JSON if missing/invalid
function requireButlerToken(req: Request, res: Response, next: NextFunction) {
  const hdr = req.header("X-Butler-Token") || "";
  const expected = ENV.BUTLER_TOKEN || process.env.BUTLER_TOKEN || "";
  if (!expected || hdr !== expected) {
    return res.status(401).json({ ok: false, error: "unauthorized" });
  }
  next();
}

/* -------------------------------------------------------------------------- */
/* App bootstrap                                                              */
/* -------------------------------------------------------------------------- */

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

// request log
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    const ms = Date.now() - t0;
    console.log(`[butler] ${req.method} ${req.path} -> ${res.statusCode} (${ms}ms)`);
  });
  next();
});

// timeout guard
installTimeoutGuard(app, 15_000);

/* -------------------------------------------------------------------------- */
/* Utility (Octokit + git helpers)                                            */
/* -------------------------------------------------------------------------- */

function getPrivateKeyPEM(): string {
  const b64 = process.env.PRIVATE_KEY_BASE64;
  if (b64 && b64.trim()) return Buffer.from(b64, "base64").toString("utf8");
  return process.env.PRIVATE_KEY || "";
}

function makeOctokit(): Octokit {
  const appId = Number(ENV.APP_ID);
  const installationId = Number(ENV.INSTALLATION_ID);
  if (!appId) throw new Error(`APP_ID missing or invalid: ${ENV.APP_ID}`);
  if (!installationId)
    throw new Error(`INSTALLATION_ID missing or invalid: ${ENV.INSTALLATION_ID}`);

  const privateKey = getPrivateKeyPEM();
  if (!privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
    throw new Error("Private key not configured correctly");
  }

  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId },
  });
}

interface GitRef {
  object: { sha: string; type: string };
}
interface GitCommit {
  sha: string;
  tree: { sha: string };
}

function validatePathsOrDie(req: Request, res: Response, edits: any[]): boolean {
  for (const e of edits) {
    const p = (e && (e.path || e.from)) as string | undefined;
    if (!p) {
      res
        .status(400)
        .json({ error: "invalid", details: [{ path: ["edits", "path"], message: "Required" }] });
      return false;
    }
    if (!isPathAllowed(p)) {
      res.status(400).json({ error: "path_not_allowed", path: p });
      return false;
    }
    if (isWorkflowPath(p)) {
      const approve = String(
        req.header("X-Butler-Approve-Workflows") || (req.body?.workflowApprovalKey ?? "")
      );
      if (!approve || approve !== ENV.WORKFLOW_EDIT_KEY) {
        res.status(403).json({ error: "workflow_edit_blocked", path: p });
        return false;
      }
    }
  }
  return true;
}

async function ensureBranchAndGetHeadSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  baseBranch: string
): Promise<string> {
  try {
    const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return (ref.data as unknown as GitRef).object.sha;
  } catch (err: any) {
    if (err?.status !== 404) throw err;
  }
  const baseRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
  const baseSha = (baseRef.data as unknown as GitRef).object.sha;
  await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
  return baseSha;
}

async function commitBatch(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  parentSha: string,
  edits: Array<
    | { op: "write"; path: string; mode: "create" | "overwrite"; content: string }
    | { op: "replace"; path: string; search: string; replace: string }
  >
): Promise<string> {
  const parentCommit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: parentSha });
  const baseTree = (parentCommit.data as unknown as GitCommit).tree.sha;

  const treeEntries: Array<{
    path: string;
    mode: string;
    type: "blob";
    sha?: string;
    content?: string;
  }> = [];
  const processedPaths = new Set<string>();

  for (const e of edits) {
    if (e.op === "write") {
      treeEntries.push({ path: e.path, mode: "100644", type: "blob", content: e.content });
      processedPaths.add(e.path);
    } else if (e.op === "replace") {
      try {
        const { data } = await octokit.rest.repos.getContent({
          owner,
          repo,
          path: e.path,
          ref: branch,
        });
        if (!("content" in data)) {
          console.warn(`Skipping replace on directory: ${e.path}`);
          continue;
        }
        const current = Buffer.from((data as any).content, "base64").toString("utf8");
        const next = current.replace(e.search, e.replace);
        if (next === current) {
          console.warn(`No changes made to ${e.path} - search string not found`);
          continue;
        }
        treeEntries.push({ path: e.path, mode: "100644", type: "blob", content: next });
        processedPaths.add(e.path);
      } catch {
        console.warn(`Skipping replace; file not found: ${e.path}`);
        continue;
      }
    }
  }

  if (treeEntries.length === 0) {
    throw Object.assign(new Error(`no_change: ${Array.from(processedPaths).join(", ")}`), {
      code: "no_change",
    });
  }

  const newTree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTree,
    tree: treeEntries,
  });

  const now = new Date().toISOString();
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: `butler: apply ${edits.length} edit(s) @ ${now}`,
    tree: newTree.data.sha,
    parents: [parentSha],
  });

  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: true,
  });
  return commit.data.sha;
}

/* -------------------------------------------------------------------------- */
/* Endpoints                                                                   */
/* -------------------------------------------------------------------------- */

// Health (no auth)
app.get("/health", (_req, res) => res.json({ ok: true }));

// Status (no auth)
app.get("/status", (_req, res) => {
  const commit = process.env.RENDER_GIT_COMMIT || process.env.COMMIT_SHA || null;
  const uptimeSec = Math.round(process.uptime());
  res.json({
    ok: true,
    commit,
    allowlist: SAFE_WRITE_GLOBS,
    uptimeSec,
    now: new Date().toISOString(),
  });
});

// PLAN — pure / always answers
app.post(
  "/plan",
  requireButlerToken,
  asyncHandler(async (req, res) => {
    const { goal, repo, baseBranch = "main" } = req.body || {};
    if (!goal || !repo?.owner || !repo?.name) {
      return res
        .status(400)
        .json({ ok: false, error: "bad_request", details: "goal, repo.owner, repo.name" });
    }

    const plan = {
      title: `Butler: ${String(goal).slice(0, 80)}`,
      summary: `Proposed changes for: ${goal}`,
      repo: { owner: repo.owner, name: repo.name },
      baseBranch,
      branch: `butler/${Date.now()}`,
      labels: ["butler"],
      runChecks: true,
      edits: [] as any[],
    };

    res.json({
      ok: true,
      plan,
      hints: {
        allowlistEnforcedAtApply: true,
        workflowEditsRequireHeader: "X-Butler-Approve-Workflows",
      },
    });
  })
);

// APPLY — real work + PR
app.post(
  "/apply",
  requireButlerToken,
  asyncHandler(async (req, res) => {
    const {
      owner = ENV.REPO_OWNER,
      repo = ENV.REPO_NAME,
      branch,
      baseBranch = "main",
      prTitle,
      prBody,
      edits,
      branchStrategy, // 'reuse' | undefined
      labels,
      reviewers,
    } = req.body || {};

    if (!owner || !repo) return res.status(400).json({ error: "owner_repo_required" });
    if (!branch || typeof branch !== "string")
      return res
        .status(400)
        .json({ error: "invalid", details: [{ path: ["branch"], message: "Required" }] });
    if (!prTitle || typeof prTitle !== "string")
      return res
        .status(400)
        .json({ error: "invalid", details: [{ path: ["prTitle"], message: "Required" }] });
    if (!Array.isArray(edits) || edits.length === 0)
      return res
        .status(400)
        .json({ error: "invalid", details: [{ path: ["edits"], message: "Required" }] });

    if (!validatePathsOrDie(req, res, edits)) return;

    const octokit = makeOctokit();

    // branch handling
    let headSha: string;
    if (branchStrategy === "reuse") {
      headSha = await ensureBranchAndGetHeadSha(octokit, owner, repo, branch, baseBranch);
    } else {
      const baseRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
      const baseSha = (baseRef.data as unknown as GitRef).object.sha;
      try {
        await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
        headSha = baseSha;
      } catch {
        return res.status(422).json({ error: "branch_exists", branch });
      }
    }

    // commit the batch
    const newSha = await commitBatch(octokit, owner, repo, branch, headSha!, edits);

    // open/update PR
    let prUrl: string | null = null;
    const prs = await octokit.rest.pulls.list({
      owner,
      repo,
      head: `${owner}:${branch}`,
      base: baseBranch,
      state: "open",
    });
    if (prs.data.length > 0) {
      prUrl = prs.data[0].html_url;
      await octokit.rest.pulls.update({
        owner,
        repo,
        pull_number: prs.data[0].number,
        title: prTitle,
        body: prBody ?? undefined,
      });
    } else {
      const pr = await octokit.rest.pulls.create({
        owner,
        repo,
        title: prTitle,
        head: branch,
        base: baseBranch,
        body: prBody ?? undefined,
      });
      prUrl = pr.data.html_url;

      if (Array.isArray(labels) && labels.length > 0) {
        await octokit.rest.issues.addLabels({
          owner,
          repo,
          issue_number: pr.data.number,
          labels,
        });
      }
      if (Array.isArray(reviewers) && reviewers.length > 0) {
        await octokit.rest.pulls.requestReviewers({
          owner,
          repo,
          pull_number: pr.data.number,
          reviewers,
        });
      }
    }

    res.json({ ok: true, branch, prUrl, commit: newSha });
  })
);

/* -------------------------------------------------------------------------- */
/* Tail                                                                        */
/* -------------------------------------------------------------------------- */

installJsonErrorHandler(app);

const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`[butler] listening on :${port}`);
});
