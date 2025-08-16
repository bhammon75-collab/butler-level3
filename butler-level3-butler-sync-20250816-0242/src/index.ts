// src/index.ts
import express from "express";
import cors from "cors";
import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { ENV } from "./lib/env";
import { isPathAllowed, isWorkflowPath } from "./lib/allowlist";

const app = express();
app.use(cors());
app.use(express.json({ limit: "2mb" }));

/** Health check (no auth) */
app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/** Small helper: assert header secret */
function requireToken(req: express.Request, res: express.Response): boolean {
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
  if (!appId) throw new Error("APP_ID missing/invalid");
  if (!installationId) throw new Error("INSTALLATION_ID missing/invalid");

  const privateKey =
    ENV.PRIVATE_KEY_BASE64
      ? Buffer.from(ENV.PRIVATE_KEY_BASE64, "base64").toString("utf8")
      : ENV.PRIVATE_KEY;

  if (!privateKey || !privateKey.includes("BEGIN") || !privateKey.includes("PRIVATE KEY")) {
    throw new Error("Private key not configured correctly");
  }

  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId,
      privateKey,
      installationId,
    },
  });
}

/** Allowlist + workflow-edit header gate */
function validatePathsOrDie(req: express.Request, res: express.Response, edits: any[]): boolean {
  for (const e of edits) {
    const p = e.path || e.from;
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
async function ensureBranchAndGetHeadSha(octokit: Octokit, owner: string, repo: string, branch: string, baseBranch: string): Promise<string> {
  // Try to read the ref (branch)
  try {
    const ref = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${branch}` });
    return (ref.data.object as any).sha;
  } catch (e: any) {
    // If missing, create from base
  }

  // Get base branch commit sha
  const baseRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
  const baseSha = (baseRef.data.object as any).sha;

  await octokit.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseSha,
  });

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
  // Get the tree of the parent commit
  const parentCommit = await octokit.rest.git.getCommit({ owner, repo, commit_sha: parentSha });
  const baseTree = parentCommit.data.tree.sha;

  // Build new blobs/entries
  const treeEntries: Array<{ path: string; mode: string; type: "blob"; sha?: string; content?: string }> = [];

  for (const e of edits) {
    if (e.op === "write") {
      // create/overwrite is the same at tree level; the ref decides what wins
      treeEntries.push({
        path: e.path,
        mode: "100644",
        type: "blob",
        content: e.content,
      });
    } else if (e.op === "replace") {
      // Fetch existing file content at branch HEAD
      // If file does not exist, it's a no-op
      try {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path: e.path, ref: branch });
        if (!("content" in data)) continue;
        const current = Buffer.from((data as any).content, "base64").toString("utf8");
        const next = current.replace(e.search, e.replace);
        if (next === current) continue;

        treeEntries.push({
          path: e.path,
          mode: "100644",
          type: "blob",
          content: next,
        });
      } catch {
        // File missing → just skip
        continue;
      }
    }
  }

  if (treeEntries.length === 0) {
    throw Object.assign(new Error("no_change"), { code: "no_change" });
  }

  // Create a new tree
  const newTree = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: baseTree,
    tree: treeEntries,
  });

  // Create a new commit
  const now = new Date().toISOString();
  const commit = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: `butler: apply ${edits.length} edit(s) @ ${now}`,
    tree: newTree.data.sha,
    parents: [parentSha],
  });

  // Move the branch to the new commit
  await octokit.rest.git.updateRef({
    owner,
    repo,
    ref: `heads/${branch}`,
    sha: commit.data.sha,
    force: true,
  });

  return commit.data.sha;
}

/** POST /apply — create/append commit(s) and open a PR */
app.post("/apply", async (req, res) => {
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

    // Basic shape checks
    if (!owner || !repo) return res.status(400).json({ error: "owner_repo_required" });
    if (!branch || typeof branch !== "string") return res.status(400).json({ error: "invalid", details: [{ path: ["branch"], message: "Required" }] });
    if (!prTitle || typeof prTitle !== "string") return res.status(400).json({ error: "invalid", details: [{ path: ["prTitle"], message: "Required" }] });
    if (!Array.isArray(edits) || edits.length === 0) return res.status(400).json({ error: "invalid", details: [{ path: ["edits"], message: "Required" }] });

    if (!validatePathsOrDie(req, res, edits)) return;

    const octokit = makeOctokit();

    // Resolve branch behavior
    let headSha: string | null = null;

    if (branchStrategy === "reuse") {
      // If branch exists: use its head; else create from base
      headSha = await ensureBranchAndGetHeadSha(octokit, owner, repo, branch, baseBranch);
    } else {
      // New-branch behavior: try to create; if exists, fail with a clear error
      // Get base sha
      const baseRef = await octokit.rest.git.getRef({ owner, repo, ref: `heads/${baseBranch}` });
      const baseSha = (baseRef.data.object as any).sha;

      // Try to create the branch
      try {
        await octokit.rest.git.createRef({
          owner, repo,
          ref: `refs/heads/${branch}`,
          sha: baseSha,
        });
        headSha = baseSha;
      } catch (err: any) {
        // If it already exists, tell the client (matches your current UX)
        return res.status(422).json({ error: "branch_exists", message: "Reference already exists", branch });
      }
    }

    // Commit the batch
    const newSha = await commitBatch(octokit, owner, repo, branch, headSha!, edits);

    // Open PR if one doesn't already exist
    let prUrl: string | null = null;
    try {
      // Try to find existing open PR from branch to base
      const prs = await octokit.rest.pulls.list({
        owner, repo, head: `${owner}:${branch}`, base: baseBranch, state: "open",
      });
      if (prs.data.length > 0) {
        prUrl = prs.data[0].html_url;
        // Optionally update title/body
        await octokit.rest.pulls.update({ owner, repo, pull_number: prs.data[0].number, title: prTitle, body: prBody ?? undefined });
      } else {
        const pr = await octokit.rest.pulls.create({
          owner, repo, title: prTitle, head: branch, base: baseBranch, body: prBody ?? undefined,
        });
        prUrl = pr.data.html_url;

        // Optional cosmetics
        if (Array.isArray(labels) && labels.length > 0) {
          await octokit.rest.issues.addLabels({ owner, repo, issue_number: pr.data.number, labels });
        }
        if (Array.isArray(reviewers) && reviewers.length > 0) {
          await octokit.rest.pulls.requestReviewers({ owner, repo, pull_number: pr.data.number, reviewers });
        }
      }
    } catch (e) {
      // If listing PRs fails due to perms, just try to create
      const pr = await octokit.rest.pulls.create({
        owner, repo, title: prTitle, head: branch, base: baseBranch, body: prBody ?? undefined,
      });
      prUrl = pr.data.html_url;
    }

    res.json({ ok: true, branch, prUrl, commit: newSha });
  } catch (err: any) {
    // Friendly errors
    if (err?.code === "no_change") {
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
