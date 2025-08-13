import { ghClient, mainSha, newBranch, getFile, decode, upsert, openPR } from '../lib/github'
import { ENV } from '../lib/env'
import { isPathAllowed } from '../lib/allowlist'

export const githubTools = {
  async write_file({ owner, repo, branch, path, content, message = 'chore(ai): write file' }:{
    owner:string, repo:string, branch:string, path:string, content:string, message?:string
  }) {
    if (!isPathAllowed(path)) throw new Error(`path_not_allowed: ${path}`)
    const gh = ghClient()
    await upsert(gh, owner, repo, branch, path, content, message)
    return { ok: true }
  },

  async open_pr({ owner, repo, head, base='main', title, body }:{
    owner:string, repo:string, head:string, base?:string, title:string, body:string
  }) {
    const gh = ghClient()
    const url = await openPR(gh, owner, repo, head, base, title, body)
    return { url }
  },

  async create_branch({ owner, repo, from='main', name }:{ owner:string, repo:string, from?:string, name:string }) {
    const gh = ghClient()
    const sha = await mainSha(gh, owner, repo, from)
    await newBranch(gh, owner, repo, sha, name)
    return { ok: true }
  }
}
