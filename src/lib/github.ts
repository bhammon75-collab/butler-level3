import { Octokit } from 'octokit'
import { createAppAuth } from '@octokit/auth-app'
import { ENV } from './env'

export function ghClient(installationId = ENV.INSTALLATION_ID) {
  return new Octokit({
    authStrategy: createAppAuth,
    auth: { appId: ENV.APP_ID, privateKey: ENV.PRIVATE_KEY, installationId }
  })
}
export async function mainSha(gh: any, owner: string, repo: string, branch='main') {
  const { data } = await gh.rest.repos.getBranch({ owner, repo, branch }); return data.commit.sha
}
export async function newBranch(gh: any, owner: string, repo: string, fromSha: string, name: string) {
  await gh.rest.git.createRef({ owner, repo, ref: `refs/heads/${name}`, sha: fromSha })
}
export async function getFile(gh: any, owner: string, repo: string, path: string) {
  try { const { data } = await gh.rest.repos.getContent({ owner, repo, path }); return data as any } catch { return null }
}
export function decode(file: any) {
  if (!('content' in file)) return ''; return Buffer.from(file.content, 'base64').toString('utf8')
}
export async function upsert(gh: any, owner: string, repo: string, branch: string, path: string, content: string, msg: string) {
  const existing = await getFile(gh, owner, repo, path)
  const sha = existing && existing.sha
  const b64 = Buffer.from(content, 'utf8').toString('base64')
  await gh.rest.repos.createOrUpdateFileContents({ owner, repo, path, branch, message: msg, content: b64, sha })
}
export async function openPR(gh: any, owner: string, repo: string, head: string, base='main', title: string, body: string) {
  const pr = await gh.rest.pulls.create({ owner, repo, head, base, title, body }); return pr.data.html_url
}
