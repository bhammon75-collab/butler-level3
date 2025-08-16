// Improved type definitions
interface GitRef {
  object: {
    sha: string;
    type: string;
  };
}

interface GitCommit {
  sha: string;
  tree: {
    sha: string;
  };
}

// Better error handling for branch operations
async function ensureBranchAndGetHeadSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
  baseBranch: string
): Promise<string> {
  try {
    const ref = await octokit.rest.git.getRef({ 
      owner, 
      repo, 
      ref: `heads/${branch}` 
    });
    return (ref.data as GitRef).object.sha;
  } catch (error: any) {
    // Only create branch if it doesn't exist (404), not on other errors
    if (error?.status !== 404) {
      throw error;
    }
  }

  const baseRef = await octokit.rest.git.getRef({ 
    owner, 
    repo, 
    ref: `heads/${baseBranch}` 
  });
  const baseSha = (baseRef.data as GitRef).object.sha;

  await octokit.rest.git.createRef({
    owner, 
    repo, 
    ref: `refs/heads/${branch}`, 
    sha: baseSha,
  });

  return baseSha;
}

// Improved Octokit factory with better validation
function makeOctokit(): Octokit {
  const appIdStr = ENV.APP_ID;
  const installationIdStr = ENV.INSTALLATION_ID;
  
  if (!appIdStr || isNaN(Number(appIdStr))) {
    throw new Error(`APP_ID missing or invalid: ${appIdStr}`);
  }
  
  if (!installationIdStr || isNaN(Number(installationIdStr))) {
    throw new Error(`INSTALLATION_ID missing or invalid: ${installationIdStr}`);
  }

  const appId = Number(appIdStr);
  const installationId = Number(installationIdStr);

  const privateKey = getPrivateKeyPEM();
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
    // Add retry configuration for rate limiting
    retry: {
      doNotRetry: ["abuse"],
    },
    throttle: {
      onRateLimit: (retryAfter: number, options: any) => {
        console.warn(`Rate limit exceeded, retrying after ${retryAfter}s`);
        return true;
      },
      onAbuseLimit: (retryAfter: number, options: any) => {
        console.error(`Abuse limit exceeded, retrying after ${retryAfter}s`);
        return true;
      },
    },
  });
}

// Enhanced commit batch with better error context
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
  try {
    const parentCommit = await octokit.rest.git.getCommit({ 
      owner, 
      repo, 
      commit_sha: parentSha 
    });
    const baseTree = parentCommit.data.tree.sha;

    const treeEntries: Array<{
      path: string;
      mode: string;
      type: "blob";
      sha?: string;
      content?: string;
    }> = [];

    const processedPaths = new Set<string>();

    for (const edit of edits) {
      try {
        if (edit.op === "write") {
          treeEntries.push({
            path: edit.path,
            mode: "100644",
            type: "blob",
            content: edit.content,
          });
          processedPaths.add(edit.path);
        } else if (edit.op === "replace") {
          const { data } = await octokit.rest.repos.getContent({
            owner,
            repo,
            path: edit.path,
            ref: branch,
          });
          
          if (!("content" in data)) {
            console.warn(`Skipping replace on directory: ${edit.path}`);
            continue;
          }

          const current = Buffer.from((data as any).content, "base64").toString("utf8");
          const next = current.replace(edit.search, edit.replace);
          
          if (next === current) {
            console.warn(`No changes made to ${edit.path} - search string not found`);
            continue;
          }
          
          treeEntries.push({
            path: edit.path,
            mode: "100644",
            type: "blob",
            content: next,
          });
          processedPaths.add(edit.path);
        }
      } catch (editError: any) {
        console.error(`Failed to process edit for ${edit.op} on ${(edit as any).path}:`, editError.message);
        throw new Error(`Edit failed for ${(edit as any).path}: ${editError.message}`);
      }
    }

    if (treeEntries.length === 0) {
      throw Object.assign(
        new Error(`No changes applied. Processed paths: ${Array.from(processedPaths).join(', ')}`),
        { code: "no_change" }
      );
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
  } catch (error: any) {
    if (error.code === "no_change") throw error;
    throw new Error(`Batch commit failed: ${error.message}`);
  }
}

// Add request logging middleware for debugging
function requestLogger(req: express.Request, res: express.Response, next: express.NextFunction) {
  const start = Date.now();
  console.log(`${req.method} ${req.path} - ${req.ip}`);
  
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
  });
  
  next();
}

// Usage: app.use(requestLogger);
