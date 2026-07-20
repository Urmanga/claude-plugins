// Fake agent.cmd: misbehaves in strictly defined ways, so it exercises runner
// branches that a live agent never triggers.
//
//   leak  — runs for a few seconds, leaves a living child behind, and dies,
//           orphaning it: a parent-chain walk of the tree won't find it anymore
//   drain — exits, but the child keeps holding the inherited stdout open
//   fail  — exits instantly with no events at all (infrastructure failure)
//   hold  — stays silent, forcing the idle timer to fire

import { spawn } from 'node:child_process'
import process from 'node:process'

const mode = process.env.FAKE_MODE || 'fail'
const HOLD_MS = Number(process.env.FAKE_HOLD_MS || 90_000)
const EXIT_AFTER_MS = Number(process.env.FAKE_EXIT_AFTER_MS || 3_000)

const say = (o) => process.stdout.write(JSON.stringify(o) + '\n')

// Holder: lives for a long time. stdio decides whether it inherits the
// parent's pipe.
const holder = (inheritStdout) =>
  spawn(process.execPath, ['-e', `setTimeout(()=>{}, ${HOLD_MS})`], {
    detached: true,
    stdio: inheritStdout ? ['ignore', 'inherit', 'ignore'] : 'ignore',
  })

if (mode === 'leak') {
  const h = holder(false)
  h.unref()
  say({ type: 'system', subtype: 'init', holder: h.pid })
  setTimeout(() => process.exit(0), EXIT_AFTER_MS)
} else if (mode === 'drain') {
  const h = holder(true)
  h.unref()
  say({ type: 'system', subtype: 'init', holder: h.pid })
  process.exit(0)
} else if (mode === 'hold') {
  setTimeout(() => process.exit(0), HOLD_MS)
} else {
  // fail: silence and an instant exit. No result event, no stderr.
  process.exit(0)
}
