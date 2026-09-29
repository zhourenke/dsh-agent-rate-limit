/**
 * Execution test for the host-side artifact.
 *
 * PLUGIN_RELEASE_GUIDE.md "提交前验证清单" step 6 requires this: `tsc` only type-checks and
 * transpiles, and the drift check only inspects git state — neither one ever
 * EXECUTES lib/index.js. Without this, "the module throws on import" (importing
 * a symbol the host removed, destructuring undefined at module scope, pulling a
 * package that no longer exists) stays green through every other check and only
 * surfaces when the user restarts DSH and reads the startup log.
 *
 * Run with: node --test   (bare form only — `node --test test/` fails with
 * MODULE_NOT_FOUND, and a `test/*.test.mjs` glob would silently miss subdirs)
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'

const { apply, name, inject, Config } = await import('../lib/index.js')

/** Build a mock Cordis context that records what the plugin registers. */
function makeCtx() {
  const listeners = new Map()
  const commands = []
  const timers = []
  return {
    listeners,
    commands,
    timers,
    ctx: {
      on(event, handler) {
        if (!listeners.has(event)) listeners.set(event, [])
        listeners.get(event).push(handler)
      },
      effect(callback) {
        // The plugin uses ctx.effect to own its command registration; running
        // it inline is enough to reach the registration path.
        return callback()
      },
      timer: {
        timeout(ms) {
          timers.push(ms)
          return Promise.resolve()
        },
      },
      commands: {
        register(definition) {
          commands.push(definition)
          return () => {}
        },
      },
    },
  }
}

/** Feed a chunk sequence through the plugin's stream wrapper. */
async function runStream(handler, chunks, options = {}) {
  const next = () =>
    (async function* () {
      for (const chunk of chunks) yield chunk
    })()
  const out = []
  for await (const chunk of handler(options, next)) out.push(chunk)
  return out
}

/** Capture the plugin's console.log output while `fn` runs. */
async function captureLogs(fn) {
  const original = console.log
  const logs = []
  console.log = (...args) => logs.push(args.map(String).join(' '))
  try {
    await fn()
  } finally {
    console.log = original
  }
  return logs.filter((line) => line.startsWith('[agent-rate-limit]'))
}

/** Read the numbers back out of the /agent-rate-limit command output. */
function parseStatus(result) {
  assert.equal(result.kind, 'success')
  const entries = /Window entries:\s+(\d+)/.exec(result.text)
  const tpm = /Current TPM:\s+([\d,]+)/.exec(result.text)
  assert.ok(entries, 'status text reports window entries')
  assert.ok(tpm, 'status text reports current TPM')
  return { entries: Number(entries[1]), tpm: Number(tpm[1].replace(/,/g, '')) }
}

test('module exports the Cordis plugin contract', () => {
  assert.equal(typeof name, 'string')
  assert.ok(Array.isArray(inject), 'inject is an array')
  assert.equal(typeof apply, 'function')
  assert.ok(Config, 'Config schema is exported')
})

test('apply registers the llm/stream listener and the command', async () => {
  const { ctx, listeners, commands } = makeCtx()
  await apply(ctx, {})

  assert.ok(listeners.has('llm/stream'), 'subscribed to llm/stream')
  assert.equal(listeners.get('llm/stream').length, 1)
  assert.equal(commands.length, 1, 'registered exactly one command')
  assert.equal(commands[0].name, 'agent-rate-limit')
  assert.equal(typeof commands[0].handler, 'function')
})

test('every chunk passes through the wrapper unchanged and in order', async () => {
  const { ctx, listeners } = makeCtx()
  await apply(ctx, {})
  const chunks = [
    { type: 'text-delta', text: 'hello' },
    { type: 'reasoning-delta', text: 'thinking' },
    { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
  const got = await runStream(listeners.get('llm/stream')[0], chunks, { messages: [] })
  assert.deepEqual(got, chunks)
})

test('a successful stream records the billed total including cache hits', async () => {
  const { ctx, listeners, commands } = makeCtx()
  await apply(ctx, {})
  assert.deepEqual(parseStatus(commands[0].handler()), { entries: 0, tpm: 0 })

  await runStream(
    listeners.get('llm/stream')[0],
    [
      {
        type: 'usage',
        usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 50 },
      },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    { messages: [] },
  )

  // uncached 100 + cacheRead 20 + cacheWrite 30 + output 50 = 200, matching the
  // API's billed total rather than the uncached-only inputTokens.
  assert.deepEqual(parseStatus(commands[0].handler()), { entries: 1, tpm: 200 })
})

test('a failed stream that reported usage is counted by default', async () => {
  const { ctx, listeners, commands } = makeCtx()
  await apply(ctx, {})

  await runStream(
    listeners.get('llm/stream')[0],
    [
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
      { type: 'finish', reason: { kind: 'error' } },
    ],
    { messages: [] },
  )

  // The upstream processed and billed that prompt, so the default keeps it in
  // the window: excluding it understates TPM pressure.
  assert.deepEqual(parseStatus(commands[0].handler()), { entries: 1, tpm: 150 })
})

test('an aborted stream that reported usage is counted by default', async () => {
  const { ctx, listeners, commands } = makeCtx()
  await apply(ctx, {})

  await runStream(
    listeners.get('llm/stream')[0],
    [
      { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
      { type: 'finish', reason: { kind: 'aborted' } },
    ],
    { messages: [] },
  )

  assert.deepEqual(parseStatus(commands[0].handler()), { entries: 1, tpm: 150 })
})

test('countFailedAttempts: false keeps failed usage out of the window but still logs it', async () => {
  const { ctx, listeners, commands } = makeCtx()
  await apply(ctx, { countFailedAttempts: false, verbose: true })

  const logs = await captureLogs(() =>
    runStream(
      listeners.get('llm/stream')[0],
      [
        {
          type: 'usage',
          usage: { inputTokens: 187803, cacheReadTokens: 209280, outputTokens: 2112 },
        },
        { type: 'finish', reason: { kind: 'error' } },
      ],
      { messages: [] },
    ),
  )

  assert.deepEqual(parseStatus(commands[0].handler()), { entries: 0, tpm: 0 })
  const record = logs.find((line) => line.includes('Recorded 399195 tokens'))
  assert.ok(record, `a failed attempt must still be logged, got:\n${logs.join('\n')}`)
  // The record keeps its original three-part detail; only the finish reason is
  // appended as a trailing annotation.
  assert.match(
    record,
    /^\[agent-rate-limit\] Recorded 399195 tokens \(uncached: 187803, cached: 209280, output: 2112\) \[error\]$/,
  )
})

test('a failed attempt without any usage chunk records nothing and says so', async () => {
  const { ctx, listeners, commands } = makeCtx()
  await apply(ctx, { verbose: true })

  const logs = await captureLogs(() =>
    runStream(
      listeners.get('llm/stream')[0],
      [{ type: 'finish', reason: { kind: 'error' } }],
      { messages: [] },
    ),
  )

  assert.deepEqual(parseStatus(commands[0].handler()), { entries: 0, tpm: 0 })
  assert.ok(
    logs.includes('[agent-rate-limit] No usage reported [error]'),
    `expected an explicit no-usage notice, got:\n${logs.join('\n')}`,
  )
})

test('a failed attempt followed by a successful retry records both attempts', async () => {
  const { ctx, listeners, commands } = makeCtx()
  await apply(ctx, {})

  const handler = listeners.get('llm/stream')[0]
  // Cold cache: the whole prompt is uncached when the attempt fails.
  await runStream(
    handler,
    [
      { type: 'usage', usage: { inputTokens: 6822, outputTokens: 0 } },
      { type: 'finish', reason: { kind: 'error' } },
    ],
    { messages: [] },
  )
  // Retry hits the now-warm cache: the uncached part is zero.
  await runStream(
    handler,
    [
      { type: 'usage', usage: { inputTokens: 0, cacheReadTokens: 8704, outputTokens: 117 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ],
    { messages: [] },
  )

  // 6822 + (8704 + 117) = 15,643. The failed attempt's uncached input is the
  // part that used to vanish from the ledger entirely.
  assert.deepEqual(parseStatus(commands[0].handler()), { entries: 2, tpm: 15643 })
})

test('verbose logs keep the original record format', async () => {
  const { ctx, listeners } = makeCtx()
  await apply(ctx, { verbose: true })

  const logs = await captureLogs(() =>
    runStream(
      listeners.get('llm/stream')[0],
      [
        {
          type: 'usage',
          usage: { inputTokens: 100, cacheReadTokens: 20, cacheWriteTokens: 30, outputTokens: 50 },
        },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      { messages: [], sessionId: 'sess-1' },
    ),
  )

  const record = logs.find((line) => line.includes('Recorded 200 tokens'))
  assert.ok(record, `expected a record line, got:\n${logs.join('\n')}`)
  // The original line shape, unchanged: `Recorded N tokens (uncached: …, cached: …, output: …)`.
  assert.match(record, /^\[agent-rate-limit\] Recorded 200 tokens \(uncached: 100, cached: 50, output: 50\)$/)
  assert.ok(!/\[[^\]]+\]$/.test(record), 'a successful attempt carries no trailing marker')
})

test('a wire totalTokens mismatch is reported instead of silently skewing the window', async () => {
  const { ctx, listeners, commands } = makeCtx()
  await apply(ctx, { verbose: true })

  const logs = await captureLogs(() =>
    runStream(
      listeners.get('llm/stream')[0],
      [
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 999 } },
        { type: 'finish', reason: { kind: 'stop' } },
      ],
      { messages: [] },
    ),
  )

  assert.ok(
    logs.includes(
      '[agent-rate-limit] Recorded total mismatch (computed: 15, reported: 999, uncached: 10, cached: 0, output: 5)',
    ),
    `expected a drift warning, got:\n${logs.join('\n')}`,
  )
  // The parts still win: the window keeps the recombined billed total.
  assert.deepEqual(parseStatus(commands[0].handler()), { entries: 1, tpm: 15 })
})

test('an over-limit window delays the next request through ctx.timer.timeout', async () => {
  const { ctx, listeners, timers } = makeCtx()
  // A deliberately tiny limit so one recorded request already overshoots it.
  await apply(ctx, { tpmLimit: 100, safetyFactor: 1, rpmLimit: 15000 })

  const handler = listeners.get('llm/stream')[0]
  const stream = [
    { type: 'usage', usage: { inputTokens: 100, outputTokens: 50 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]

  await runStream(handler, stream, { messages: [] })
  assert.equal(timers.length, 0, 'an empty window needs no delay')

  await runStream(handler, stream, { messages: [] })
  assert.equal(timers.length, 1, 'the overshooting window delayed the request')
  assert.equal(typeof timers[0], 'number')
  assert.ok(timers[0] > 0, `delay must be positive, got ${timers[0]}`)
})

// ---------------------------------------------------------------------------
// Auxiliary calls (`purpose`)
//
// The agent loop marks context compaction and session-title calls with
// `purpose`. They spend provider quota, so they are paced and counted, but
// their size says nothing about the next ordinary request: a compaction prompt
// sits at the context ceiling and a title prompt is tiny.
// ---------------------------------------------------------------------------

/** Chunk sequence for a completed attempt that billed `inputTokens`. */
function billedAttempt(inputTokens, outputTokens = 0) {
  return [
    { type: 'usage', usage: { inputTokens, outputTokens } },
    { type: 'finish', reason: { kind: 'stop' } },
  ]
}

test('an auxiliary call is counted in the window but not fed to the input average', async () => {
  const { ctx, listeners, timers } = makeCtx()
  // The window reaches 6000 against a 8000 limit, while the estimated input for
  // the next request is 1000 if the compaction sample is excluded and 3000 if
  // it is included — a difference that crosses the 2000-token headroom.
  await apply(ctx, { tpmLimit: 8000, safetyFactor: 1, rpmLimit: 15000 })
  const handler = listeners.get('llm/stream')[0]

  await runStream(handler, billedAttempt(1000), { messages: [] })
  await runStream(handler, billedAttempt(5000), { messages: [], purpose: 'compaction' })
  assert.equal(timers.length, 0, 'the window is still under the limit')

  await runStream(handler, [{ type: 'finish', reason: { kind: 'stop' } }], { messages: [] })
  assert.equal(timers.length, 0, 'the compaction sample did not inflate the estimate')
})

test('the same history without a purpose marker does feed the average', async () => {
  const { ctx, listeners, timers } = makeCtx()
  await apply(ctx, { tpmLimit: 8000, safetyFactor: 1, rpmLimit: 15000 })
  const handler = listeners.get('llm/stream')[0]

  await runStream(handler, billedAttempt(1000), { messages: [] })
  await runStream(handler, billedAttempt(5000), { messages: [] })

  await runStream(handler, [{ type: 'finish', reason: { kind: 'stop' } }], { messages: [] })
  // Average 3000 -> target 5000 < window 6000: the identical history now waits.
  // This is the control for the test above; only `purpose` differs.
  assert.equal(timers.length, 1, 'an ordinary sample shifts the estimate and forces the wait')
})

// ---------------------------------------------------------------------------
// Cold-start estimation (no provider ever reported usage)
//
// A provider that reports no usage leaves the average empty, so every request
// is priced by the local estimator — including the entry it records in the
// window, which is what lets the estimate decide the next wait.
// ---------------------------------------------------------------------------

test('a request with no usage report is priced by the estimator', async () => {
  const { ctx, listeners, timers } = makeCtx()
  await apply(ctx, { tpmLimit: 200, safetyFactor: 1, rpmLimit: 15000, verbose: true })
  const handler = listeners.get('llm/stream')[0]

  // 400 ASCII characters at the local 3.5 chars/token density -> 115 tokens.
  const options = { messages: [{ content: [{ type: 'text', text: 'a'.repeat(400) }] }] }
  const stream = [{ type: 'finish', reason: { kind: 'stop' } }]

  const logs = await captureLogs(() => runStream(handler, stream, options))
  assert.ok(
    logs.includes('[agent-rate-limit] Recorded 115 tokens (estimated: 115i)'),
    `the estimator priced the request, got: ${JSON.stringify(logs)}`,
  )
  assert.equal(timers.length, 0, 'the first request runs immediately')

  // The window now holds 115 while no usage report ever arrived, so the same
  // estimate is reused: target = 200 - 115 = 85 < 115, and the request waits.
  await runStream(handler, stream, options)
  assert.equal(timers.length, 1, 'the estimate sized the window and forced the wait')
})

test('the estimate is derived per request, not cached', async () => {
  const { ctx, listeners, timers } = makeCtx()
  await apply(ctx, { tpmLimit: 200, safetyFactor: 1, rpmLimit: 15000 })
  const handler = listeners.get('llm/stream')[0]
  const stream = [{ type: 'finish', reason: { kind: 'stop' } }]

  await runStream(handler, stream, { messages: [{ content: [{ type: 'text', text: 'a'.repeat(400) }] }] })
  // A 2-character prompt prices at 1 token: target = 199 > window 115.
  await runStream(handler, stream, { messages: [{ content: [{ type: 'text', text: 'hi' }] }] })
  assert.equal(timers.length, 0, 'a short prompt leaves room in the same window')
})

// ---------------------------------------------------------------------------
// Live reload
// ---------------------------------------------------------------------------

test('a delay disposed by a patch reload does not fail the request', async () => {
  const { ctx, listeners, timers } = makeCtx()
  await apply(ctx, { tpmLimit: 100, safetyFactor: 1, rpmLimit: 15000, verbose: true })
  const handler = listeners.get('llm/stream')[0]
  const stream = billedAttempt(100)

  await runStream(handler, stream, { messages: [] })

  // The host implements `timeout` as a context effect, so disposing the plugin
  // while a delay is pending rejects it. The chunks must still reach the caller.
  ctx.timer.timeout = (ms) => {
    timers.push(ms)
    return Promise.reject(new Error('Context has been disposed'))
  }
  let received = []
  const logs = await captureLogs(async () => {
    received = await runStream(handler, stream, { messages: [] })
  })

  assert.equal(timers.length, 1, 'the delay was attempted')
  assert.ok(timers[0] > 0, 'the attempted delay was positive')
  assert.equal(received.length, 2, 'both chunks still reached the caller')
  assert.ok(
    logs.includes('[agent-rate-limit] Delay abandoned: the plugin was disposed while waiting'),
    `the abandoned delay was reported, got: ${JSON.stringify(logs)}`,
  )
})

// ---------------------------------------------------------------------------
// Manifest contract
//
// The host reads the display metadata and the icon WITHOUT activating the
// plugin, and a malformed one fails only when the user restarts DSH.
// ---------------------------------------------------------------------------

const packageRoot = new URL('..', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', packageRoot), 'utf8'))

test('inject names exactly the services this plugin reads', () => {
  // `inject` gates activation: naming a service the plugin never touches holds
  // it back for an unrelated package, and omitting one it does touch leaves the
  // property undefined at activate time.
  assert.deepEqual([...inject].sort(), ['commands', 'timer'])
})

test('the display metadata the Plugin Manager reads is present and valid', () => {
  // `locale/*.json` resolves through the package `exports` map and neither it
  // nor the icon is auto-included in the payload, so both must be declared.
  assert.equal(manifest.icon, './icon.svg', 'icon field points at the icon')
  assert.equal(
    manifest.exports['./locale/*.json'],
    './locale/*.json',
    'locale dictionaries resolve through exports',
  )
  for (const entry of ['icon.svg', 'locale/*.json']) {
    assert.ok(manifest.files.includes(entry), `files lists ${entry}`)
  }

  const icon = readFileSync(new URL(manifest.icon, packageRoot))
  assert.ok(icon.byteLength > 0, 'the icon is not empty')
  assert.ok(icon.byteLength <= 256 * 1024, 'the icon is within the 256 KiB limit')
  assert.match(icon.toString('utf8'), /^<svg[\s>]/, 'the icon is an SVG document')

  const localeDir = new URL('locale/', packageRoot)
  const dictionaries = readdirSync(localeDir).filter((file) => file.endsWith('.json'))
  assert.ok(dictionaries.length > 0, 'at least one dictionary exists')
  for (const file of dictionaries) {
    const dict = JSON.parse(readFileSync(new URL(file, localeDir), 'utf8'))
    // An empty or non-string title/description makes the loader THROW.
    assert.equal(typeof dict.meta?.title, 'string', `${file} carries a title`)
    assert.ok(dict.meta.title.length > 0, `${file} title is not empty`)
    assert.equal(typeof dict.meta?.description, 'string', `${file} carries a description`)
    assert.ok(dict.meta.description.length > 0, `${file} description is not empty`)
  }
})

test('the emitted module keeps no runtime import of the host LLM package', () => {
  // The llm/stream contract is bound with `import type`, which tsc erases. A
  // value import would load the host's streaming vocabulary a second time
  // instead of sharing the instance the running host already owns.
  const emitted = readFileSync(new URL('lib/index.js', packageRoot), 'utf8')
  assert.doesNotMatch(emitted, /from\s*['"]@deepseek-ai\/dsh-llm['"]/, 'no runtime dsh-llm import')
})

test('a configuration the limiter cannot honor fails loudly instead of pacing nothing', async () => {
  // The schema checks the type only. Measured on schemastery 3.18.4: `min(1)`
  // rejects 0 and -5 but passes NaN, so a range constraint alone would not be
  // enough. NaN is the dangerous value - every window comparison against it is
  // false, so the plugin would load, keep logging, and never delay anything.
  for (const [key, value] of [
    ['windowMs', 0],
    ['tpmLimit', 0],
    ['rpmLimit', -1],
    ['safetyFactor', 0],
    ['tpmLimit', Number.NaN],
    ['safetyFactor', Number.NaN],
  ]) {
    const { ctx } = makeCtx()
    await assert.rejects(
      () => apply(ctx, { [key]: value }),
      new RegExp(`config ${key} must be a positive finite number`),
      `${key} = ${value} is rejected`,
    )
  }

  // A rejected configuration must not leave a half-registered plugin behind.
  const { ctx, listeners, commands } = makeCtx()
  await assert.rejects(() => apply(ctx, { windowMs: Number.NaN }))
  assert.equal(listeners.size, 0, 'no listener survives a rejected configuration')
  assert.equal(commands.length, 0, 'no command survives a rejected configuration')
})