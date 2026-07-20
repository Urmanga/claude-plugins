// Fixtures for acceptance. Each case reproduces one specific hole found by
// adversarial review. The point of the set: REJECTION logic runs rarely and
// so gets exercised poorly — here it all runs.
//
//   node accept.test.mjs

import { accept } from './accept.mjs'

let pass = 0
let fail = 0

const line = (o) => JSON.stringify(o)
const fetchCall = (url) =>
  line({ type: 'tool_call', subtype: 'completed', tool_call: { webFetchToolCall: { args: { url } } } })
const resultLine = (text, extra = {}) =>
  line({ type: 'result', subtype: 'success', is_error: false, result: text, ...extra })
const fence = (obj) => '```json\n' + JSON.stringify(obj) + '\n```'
const run = (lines) => ({ ok: true, raw: lines.join('\n'), ms: 1000 })

const REQ = ['summary', 'findings', 'urls_opened']
const opts = { required: REQ, citationPolicy: 'fetched' }

function check(name, got, want) {
  const ok =
    want.accepted === got.accepted &&
    (want.kind === undefined || want.kind === got.kind)
  if (ok) {
    pass++
    console.log(`  ok   ${name}${got.accepted ? '' : `  [${got.kind}] ${got.reason}`}`)
  } else {
    fail++
    console.log(`  FAIL ${name}`)
    console.log(`       expected accepted=${want.accepted}${want.kind ? ` kind=${want.kind}` : ''}`)
    console.log(`       got      accepted=${got.accepted} kind=${got.kind} reason=${got.reason}`)
  }
}

const GOOD_PAYLOAD = {
  summary: 'A two-sentence summary of what was found.',
  findings: [{ claim: 'something', quote: 'verbatim', url: 'https://a.example/doc' }],
  urls_opened: ['https://a.example/doc'],
}

console.log('\nshould be accepted:')

check(
  'normal run',
  accept(run([fetchCall('https://a.example/doc'), resultLine(fence(GOOD_PAYLOAD))]), opts),
  { accepted: true },
)

check(
  'link differs only by www and a trailing slash',
  accept(
    run([
      fetchCall('https://www.a.example/doc/'),
      resultLine(fence(GOOD_PAYLOAD)),
    ]),
    opts,
  ),
  { accepted: true },
)

check(
  'real answer followed by a sample',
  accept(
    run([
      fetchCall('https://a.example/doc'),
      resultLine(
        'Result:\n' +
          fence(GOOD_PAYLOAD) +
          '\n\nOr like this:\n' +
          fence({ summary: '<one sentence>', findings: [{ claim: '...' }], urls_opened: ['...'] }),
      ),
    ]),
    opts,
  ),
  { accepted: true },
)

check(
  'citationPolicy off — links are not checked',
  accept(run([resultLine(fence(GOOD_PAYLOAD))]), { required: REQ, citationPolicy: 'off' }),
  { accepted: true },
)

console.log('\nshould be rejected:')

check(
  'FA-1 answered from memory: zero web requests',
  accept(
    run([
      resultLine(
        fence({
          summary: 'MCP is an open protocol.',
          findings: [{ claim: 'widely adopted' }],
          urls_opened: ['official documentation'],
        }),
      ),
    ]),
    opts,
  ),
  { accepted: false, kind: 'evidence' },
)

check(
  'FA-2 citation as a bare domain, no scheme',
  accept(
    run([
      fetchCall('https://a.example/doc'),
      resultLine(
        fence({
          summary: 's',
          findings: [{ claim: 'c', url: 'modelcontextprotocol.io/specification' }],
          urls_opened: ['https://a.example/doc'],
        }),
      ),
    ]),
    opts,
  ),
  { accepted: false, kind: 'evidence' },
)

check(
  'FA-3 only a sample block, no real answer',
  accept(
    run([
      fetchCall('https://a.example/doc'),
      resultLine(
        'Could not open the sources. The expected form was: ' +
          '{"summary":"<paragraph>","findings":[{"claim":"<claim>"}],"urls_opened":["<url>"]} — try again.',
      ),
    ]),
    opts,
  ),
  { accepted: false, kind: 'shape' },
)

check(
  'FA-3b two equally-scored blocks — unclear which is the answer',
  accept(
    run([
      fetchCall('https://a.example/doc'),
      resultLine(fence(GOOD_PAYLOAD) + '\n\n' + fence({ ...GOOD_PAYLOAD, summary: 'a different summary' })),
    ]),
    opts,
  ),
  { accepted: false, kind: 'shape' },
)

check(
  'FA-4 truncated stream tail',
  accept(
    {
      ok: true,
      ms: 1,
      raw: [
        fetchCall('https://a.example/doc'),
        resultLine(fence(GOOD_PAYLOAD)),
        '{"type":"result","subtype":"error","is_error":true,"result":"stream cut mid-wri',
      ].join('\n'),
    },
    opts,
  ),
  { accepted: false, kind: 'stream' },
)

check(
  'FA-5a is_error as the string "true"',
  accept(
    run([fetchCall('https://a.example/doc'), resultLine(fence(GOOD_PAYLOAD), { is_error: 'true' })]),
    opts,
  ),
  { accepted: false, kind: 'agent' },
)

check(
  'FA-5b isError in camelCase',
  accept(
    run([
      fetchCall('https://a.example/doc'),
      line({ type: 'result', subtype: 'success', isError: true, result: fence(GOOD_PAYLOAD) }),
    ]),
    opts,
  ),
  { accepted: false, kind: 'agent' },
)

check(
  'FA-6a findings made of empty objects',
  accept(
    run([
      fetchCall('https://a.example/doc'),
      resultLine(fence({ summary: 's', findings: [{}], urls_opened: ['https://a.example/doc'] })),
    ]),
    opts,
  ),
  { accepted: false, kind: 'shape' },
)

check(
  'FA-6b "n/a" placeholder in a required field',
  accept(
    run([
      fetchCall('https://a.example/doc'),
      resultLine(
        fence({ summary: 'n/a', findings: [{ claim: 'c' }], urls_opened: ['https://a.example/doc'] }),
      ),
    ]),
    opts,
  ),
  { accepted: false, kind: 'shape' },
)

check(
  'FA-7 path case: fabricated /docs/a vs. the actually-opened /Docs/A',
  accept(
    run([
      fetchCall('https://a.example/Docs/A'),
      resultLine(
        fence({
          summary: 's',
          findings: [{ claim: 'c', url: 'https://a.example/docs/a' }],
          urls_opened: ['https://a.example/docs/a'],
        }),
      ),
    ]),
    opts,
  ),
  { accepted: false, kind: 'evidence' },
)

check(
  'FA-8 link came from an opened page\'s body, but was never itself opened',
  accept(
    run([
      line({
        type: 'tool_call',
        subtype: 'completed',
        tool_call: {
          webFetchToolCall: {
            args: { url: 'https://a.example/doc' },
            result: { content: 'see also https://never-opened.example/deep' },
          },
        },
      }),
      resultLine(
        fence({
          summary: 's',
          findings: [{ claim: 'c', url: 'https://never-opened.example/deep' }],
          urls_opened: ['https://a.example/doc'],
        }),
      ),
    ]),
    opts,
  ),
  { accepted: false, kind: 'evidence' },
)

check(
  'subtype is not success',
  accept(
    run([
      fetchCall('https://a.example/doc'),
      line({ type: 'result', subtype: 'error_during_execution', is_error: false, result: fence(GOOD_PAYLOAD) }),
    ]),
    opts,
  ),
  { accepted: false, kind: 'agent' },
)

check('no result event', accept(run([fetchCall('https://a.example/doc')]), opts), {
  accepted: false,
  kind: 'stream',
})

check('process did not finish on its own', accept({ ok: false, reason: 'hard timeout', raw: '' }, opts), {
  accepted: false,
  kind: 'run',
})

check(
  'empty agent response',
  accept(run([fetchCall('https://a.example/doc'), resultLine('')]), opts),
  { accepted: false, kind: 'shape' },
)

console.log(`\nsummary: ${pass} passed, ${fail} failed\n`)
process.exit(fail === 0 ? 0 : 1)
