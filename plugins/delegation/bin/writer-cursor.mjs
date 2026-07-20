// runWriter on top of Cursor CLI — code writer for the repair loop.
//
// Unlike the scout: the writer IS ALLOWED to write to src, but tests and
// git commits are FORBIDDEN (our orchestrator commits after acceptance — composition
// under our control, not the agent's). Prompt via stdin UTF-8, model is pinned.
//
// Returns the shape repairLoop expects: { ok, raw?, reason? }.
//   ok=false → process did not exit on its own (timeout/hang/crash/leak).
//   ok=true  → finished; acceptCode on disk already accepts/rejects its result.

import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { runProcess } from './proc.mjs'

const DEFAULT_AGENT =
  process.env.CURSOR_AGENT_CMD ||
  path.join(process.env.LOCALAPPDATA || '', 'cursor-agent', 'agent.cmd')

// Scoped writer permissions. allow must be non-empty (otherwise the cli.json schema fails), deny
// strips tests and git operations. Written to <worktree>/.cursor/cli.json.
export function writerPermissions({ writeGlobs = ['Write(src/**)'], testGlob = 'Write(**/*.test.*)', extraDeny = [] } = {}) {
  return {
    permissions: {
      allow: writeGlobs,
      deny: [testGlob, 'Write(**/*.spec.*)', 'Shell(git commit*)', 'Shell(git push*)', 'Shell(git reset*)', ...extraDeny],
    },
  }
}

// Drops .cursor/cli.json into the worktree. Call once before the writer.
export async function installWriterPermissions(worktree, opts = {}) {
  await mkdir(path.join(worktree, '.cursor'), { recursive: true })
  await writeFile(path.join(worktree, '.cursor', 'cli.json'), JSON.stringify(writerPermissions(opts), null, 2), 'utf8')
}

// Factory for runWriter bound to a specific tree. logDir — where to store raw streams
// and attempt prompts (for post-mortem). model — composer-2.5-fast by default.
export function makeCursorWriter({
  worktree,
  logDir = null,
  agentCmd = DEFAULT_AGENT,
  model = 'composer-2.5-fast',
  hardMs = 420_000,
  idleMs = 120_000,
} = {}) {
  let attempt = 0
  return async function runWriter(prompt) {
    attempt++
    if (logDir) {
      await mkdir(logDir, { recursive: true }).catch(() => {})
      await writeFile(path.join(logDir, `prompt.attempt${attempt}.txt`), prompt, 'utf8').catch(() => {})
    }
    const args = ['/c', agentCmd, '-p', '--trust', '--force', '--output-format', 'stream-json', '--model', model]
    const r = await runProcess(process.env.ComSpec || 'cmd.exe', args, {
      cwd: worktree,
      stdin: prompt,
      hardMs,
      idleMs,
    })
    if (logDir) {
      await writeFile(path.join(logDir, `raw.attempt${attempt}.jsonl`), r.raw || '', 'utf8').catch(() => {})
      if ((r.stderr || '').trim()) await writeFile(path.join(logDir, `stderr.attempt${attempt}.txt`), r.stderr, 'utf8').catch(() => {})
    }
    if (r.leaked) {
      // A leaked writer process burns quota invisibly — this is a failed attempt.
      return { ok: false, reason: `process leak: survived ${r.leaked.join(',')}`, raw: r.raw }
    }
    if (!r.ok) return { ok: false, reason: r.reason, raw: r.raw }
    return { ok: true, raw: r.raw }
  }
}
