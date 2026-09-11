/**
 * Execution test for the host-side artifact.
 *
 * PLUGIN_RELEASE_GUIDE.md §4 step 6 requires this: `tsc` only type-checks and
 * transpiles, and the drift check only inspects git state — neither one ever
 * EXECUTES lib/index.js. Without this, "the module throws on import" (importing
 * a symbol the host removed, destructuring undefined at module scope, pulling a
 * package that no longer exists) stays green through every other check and only
 * surfaces when the user restarts DSH and reads the startup log.
 *
 * Run with: node --test test/
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

test('a failed stream records nothing', async () => {
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

  assert.deepEqual(
    parseStatus(commands[0].handler()),
    { entries: 0, tpm: 0 },
    'a failed request must not consume window budget',
  )
})

test('an aborted stream records nothing', async () => {
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

  assert.deepEqual(parseStatus(commands[0].handler()), { entries: 0, tpm: 0 })
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
