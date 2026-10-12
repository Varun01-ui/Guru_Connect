// Claude Code PreToolUse hook for `git commit` (see .claude/settings.json).
//
// Keeps the roadmap in the same commit/PR as the feature:
//   - If the staged changes touch app source (GuruBackend/src or GureFronend/src) but ROADMAP-STATUS.md is not staged,
//     the commit is blocked with a message telling Claude to tick the module and run the sync script.
//   - If ROADMAP-STATUS.md is staged, README.md is regenerated (node scripts/syncRoadmap.mjs) and staged, so the
//     front-page progress can never lag behind the tracker.
// Escape hatch for commits that finish no module (a bug fix, a refactor): put [skip-roadmap] in the commit message.
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()

let command = ''
try {
  command = JSON.parse(readFileSync(0, 'utf8')).tool_input?.command ?? ''
} catch {
  process.exit(0)
}
if (!/\bgit\s+(-\S+\s+)*commit\b/.test(command)) process.exit(0)
if (command.includes('[skip-roadmap]')) process.exit(0)

// `git commit -a` stages tracked changes itself, so judge by what it would include.
const staged = git('diff', '--cached', '--name-only').split('\n').filter(Boolean)
const all = /\bcommit\b[^|;&]*\s-\w*a/.test(command) ? git('diff', '--name-only').split('\n').filter(Boolean) : []
const files = [...new Set([...staged, ...all])]

const touchesApp = files.some((f) => /^(GuruBackend|GureFronend)\/src\//.test(f))
const hasTracker = files.includes('ROADMAP-STATUS.md')

if (touchesApp && !hasTracker) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          'Roadmap not updated. This commit changes app source but not ROADMAP-STATUS.md. Update it in the SAME commit/PR: tick the module (API, Web UI, Overall), fix the summary counts, "Last updated" and next steps, run `node scripts/syncRoadmap.mjs`, then `git add ROADMAP-STATUS.md README.md` and commit again. If this commit finishes no module (bug fix, refactor), add [skip-roadmap] to the commit message.',
      },
    }),
  )
  process.exit(0)
}

if (hasTracker) {
  execFileSync('node', ['scripts/syncRoadmap.mjs'], { cwd: root, stdio: 'ignore' })
  execFileSync('git', ['add', 'README.md'], { cwd: root })
}
