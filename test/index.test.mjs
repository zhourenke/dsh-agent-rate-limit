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
  // The detail paragraph keeps the original three-part form; the failure marker
  // is a trailing annotation, so existing log readers lose nothing.
  assert.match(record, /uncached: 187803, cached: 209280, output: 2112/)
  assert.match(record, /\[failed\/error, not counted\]/)
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
    logs.some((line) => line.includes('No usage reported')),
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
  assert.ok(!record.includes('failed/'), 'a successful attempt carries no failure marker')
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
    logs.some((line) => line.includes('Recorded total mismatch')),
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