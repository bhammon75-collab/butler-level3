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

  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId, privateKey, installationId },
  });
}

/** Types used when reading git refs/commits */
interface GitRef { object: { sha: string; type: string } }
interface GitCommit { sha: string; tree: { sha: string } }

/** Allowlist + workflow-edit header gate */
function validatePathsOrDie(req: Request, res: Response, edits: any[]): boolean {
  for (const e of edits) {
    const p = (e && (e.path || e.from)) as string | undefined;
    if (!p) {
      res.status(400).json({ error: "invalid", details: [{ path: ["edits", "path"], message: "Required" }] });
      return false;
    }
    if (!isPathAllowed(p)) {
      res.status(400).json({ error: "path_not_allowed", path: p });
      return false;
    }
    if (isWorkflowPath(p)) {
      const hdr = req.header("X-Butler-Approve-Workflows");
      if (!hdr || hdr !== ENV.WORKFLOW_EDIT_KEY) {
        res.status(403).json({ error: "workflow_edit_blocked", path: p });
        return false;
      }
    }
  }
  return true;
}

/** Ensure branch exists (create from base if missing) and return its HEAD commit SHA */
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
    if (err?.status !== 404) throw err; // only create on 404
  }

  const baseRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
  const baseSha = (baseRef.data as unknown as GitRef).object.sha;

  await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
  return baseSha;
}

/** Create a commit with a batch of file edits and move the branch to it */
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

  const treeEntries: Array<{ path: string; mode: string; type: "blob"; sha?: string; content?: string }> = [];
  const processedPaths = new Set<string>();

  for (const e of edits) {
    try {
      if (e.op === "write") {
        treeEntries.push({ path: e.path, mode: "100644", type: "blob", content: e.content });
        processedPaths.add(e.path);
      } else if (e.op === "replace") {
        try {
          const { data } = await octokit.rest.repos.getContent({ owner, repo, path: e.path, ref: branch });
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
    } catch (editError: any) {
      console.error(`Failed to process edit for ${e.op} on ${"path" in e ? e.path : "unknown"}:`, editError?.message);
      throw new Error(`Edit failed for ${"path" in e ? e.path : "unknown"}: ${editError?.message}`);
    }
  }

  if (treeEntries.length === 0) {
    throw Object.assign(new Error(`no_change: ${Array.from(processedPaths).join(", ")}`), { code: "no_change" });
  }

  const newTree = await octokit.rest.git.createTree({ owner, repo, base_tree: baseTree, tree: treeEntries });

  const now = new Date().toISOString();
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: `butler: apply ${edits.length} edit(s) @ ${now}`,
    tree: newTree.data.sha,
    parents: [parentSha],
  });

  await octokit.rest.git.updateRef({ owner, repo, ref: `heads/${branch}`, sha: commit.data.sha, force: true });
  return commit.data.sha;
}

/** POST /plan — propose a small, safe plan (no repo writes) */
app.post("/plan", (req: Request, res: Response) => {
  if (!requireToken(req, res)) return;

  try {
    const { goal, repo, baseBranch = "main" } = req.body || {};
    if (!goal || !repo?.owner || !repo?.name) {
      return res.status(400).json({ error: "invalid", details: [{ path: ["goal/repo"], message: "Required" }] });
    }

    const branch = `butler/${Date.now()}`;
    const plan = {
      title: `Butler: ${String(goal).slice(0, 80)}`,
      summary: `Proposed changes for: ${goal}`,
      repo: { owner: repo.owner, name: repo.name },
      baseBranch,
      branch,
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
  } catch (err: any) {
    res.status(500).json({ error: "plan_failed", message: err?.message || String(err) });
  }
});

/** POST /apply — create/append commit(s) and open a PR */
app.post("/apply", async (req: Request, res: Response) => {
  if (!requireToken(req, res)) return;

  try {
    const {
      owner = ENV.REPO_OWNER,
      repo = ENV.REPO_NAME,
      branch,
      baseBranch = "main",
      prTitle,
      prBody,
      edits,
      branchStrategy, // "reuse" | undefined
      labels,
      reviewers,
    } = req.body || {};

    if (!owner || !repo) return res.status(400).json({ error: "owner_repo_required" });
    if (!branch || typeof branch !== "string") {
      return res.status(400).json({ error: "invalid", details: [{ path: ["branch"], message: "Required" }] });
    }
    if (!prTitle || typeof prTitle !== "string") {
      return res.status(400).json({ error: "invalid", details: [{ path: ["prTitle"], message: "Required" }] });
    }
    if (!Array.isArray(edits) || edits.length === 0) {
      return res.status(400).json({ error: "invalid", details: [{ path: ["edits"], message: "Required" }] });
    }

    if (!validatePathsOrDie(req, res, edits)) return;

    const octokit = makeOctokit();

    // Resolve branch behavior
    let headSha: string | null = null;

    if (branchStrategy === "reuse") {
      headSha = await ensureBranchAndGetHeadSha(octokit, owner, repo, branch, baseBranch);
    } else {
      const baseRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
      const baseSha = (baseRef.data as unknown as GitRef).object.sha;

      try {
        await octokit.rest.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: baseSha });
        headSha = baseSha;
      } catch {
        return res.status(422).json({ error: "branch_exists", message: "Reference already exists", branch });
      }
    }

    // Commit the batch
    const newSha = await commitBatch(octokit, owner, repo, branch, headSha!, edits);

    // Open PR if one doesn't already exist
    let prUrl: string | null = null;
    try {
      const prs = await octokit.rest.pulls.list({ owner, repo, head: `${owner}:${branch}`, base: baseBranch, state: "open" });
      if (prs.data.length > 0) {
        prUrl = prs.data[0].html_url;
        await octokit.rest.pulls.update({ owner, repo, pull_number: prs.data[0].number, title: prTitle, body: prBody ?? undefined });
      } else {
        const pr = await octokit.rest.pulls.create({ owner, repo, title: prTitle, head: branch, base: baseBranch, body: prBody ?? undefined });
        prUrl = pr.data.html_url;

        if (Array.isArray(labels)) {
          if (labels.length > 0) await octokit.rest.issues.addLabels({ owner, repo, issue_number: pr.data.number, labels });
        }
        if (Array.isArray(reviewers) && reviewers.length > 0) {
          await octokit.rest.pulls.requestReviewers({ owner, repo, pull_number: pr.data.number, reviewers });
        }
      }
    } catch {
      const pr = await octokit.rest.pulls.create({ owner, repo, title: prTitle, head: branch, base: baseBranch, body: prBody ?? undefined });
      prUrl = pr.data.html_url;
    }

    res.json({ ok: true, branch, prUrl, commit: newSha });
  } catch (err: any) {
    if ((err as any)?.code === "no_change") {
      return res.status(400).json({ error: "no_change" });
    }
    const msg = err?.message || String(err);
    res.status(500).json({ error: "apply_failed", message: msg });
  }
});

/** Start server (Render will set PORT) */
const port = Number(process.env.PORT || 3000);
app.listen(port, () => {
  console.log(`[butler] listening on :${port}`);
});
