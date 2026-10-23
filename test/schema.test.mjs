/**
 * dsh-room 工具定义校验（可选测试）
 *
 *   node test/schema.test.mjs
 *
 * 背景：2026-10-23 两次 DSH 崩溃（fatal load failure）都是因为注册给
 * `tools.register()` 的工具少了 `output.render` —— DSH 加载插件时抛错就直接退出。
 * 所以这里把插件注册的工具定义，喂给 DSH 安装目录里**真实的**校验函数：
 *   · assertSupportedJsonSchema(parameters / output.schema)
 *   · validateJsonSchemaValue(...) 抽样验证参数与返回值
 *
 * 没装 DSH（或找不到 @deepseek-ai/dsh-tools）时打印 SKIP 并以 0 退出，
 * 这样 CI / 别人的机器上不会误报。
 */
import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const candidates = [
  process.env.DSH_TOOLS_ENTRY,
  'D:/D Download/dsh/resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
  'C:/Users/Administrator/AppData/Local/Temp/dsh-asar-probe/dsh/node_modules/@deepseek-ai/dsh-tools/lib/index.js',
].filter(Boolean)

let tools = null
for (const candidate of candidates) {
  if (!existsSync(candidate)) continue
  try {
    tools = await import(pathToFileURL(candidate).href)
    break
  } catch (error) {
    console.log('（跳过 ' + candidate + '：' + (error && error.message) + '）')
  }
}

if (!tools || typeof tools.assertSupportedJsonSchema !== 'function') {
  console.log('dsh-room tools schema check: SKIP（没找到 DSH 的 @deepseek-ai/dsh-tools）')
  process.exit(0)
}

const plugin = await import(new URL('../index.mjs', import.meta.url).href)

const registered = new Map()
const ctx = {
  logger: () => ({ info() {}, warn() {}, error() {} }),
  // 端口只用来让 apply 认为「房间可用」；不会真的去连。
  webServer: { port: 65535, register() { return () => {} } },
  connection: { authenticatedUrl: (base) => base },
  tools: {
    register(definition) {
      const output = definition && definition.output
      assert.equal(typeof output, 'object', 'tool ' + definition.name + ' 缺少 output')
      assert.equal(typeof output.render, 'function', 'tool ' + definition.name + ' 缺少 output.render（DSH 会因此启动即崩）')
      tools.assertSupportedJsonSchema(output.schema)
      tools.assertSupportedJsonSchema(definition.parameters)
      registered.set(definition.name, definition)
      return () => { registered.delete(definition.name) }
    },
  },
  effect(fn) { this._dispose = fn() },
  get() { return null },
}

plugin.apply(ctx, { port: 8788, name: 'schema-check', workspace: process.cwd() })

assert.deepEqual([...registered.keys()].sort(), ['room_chat_list', 'room_chat_post', 'room_chat_read'])

const samples = {
  room_chat_list: [{}, { ok: true, self: 's1', groups: [{ id: 'lobby', name: '大厅', agents: [], joined: true }] }],
  room_chat_read: [
    { group: 'lobby', since: 0, limit: 50 },
    { ok: true, group: 'lobby', messages: [{ seq: 1, at: '2026-10-23T00:00:00.000Z', from: '阿伟', kind: 'user', text: 'hi' }] },
  ],
  room_chat_post: [{ group: 'lobby', text: 'hi' }, { ok: true, group: 'lobby', seq: 1 }],
}

for (const [name, [args, value]] of Object.entries(samples)) {
  const definition = registered.get(name)
  const argViolations = tools.validateJsonSchemaValue(definition.parameters, args, '')
  assert.deepEqual(argViolations, [], name + ' 的参数不符合 schema：' + JSON.stringify(argViolations))
  const outViolations = tools.validateJsonSchemaValue(definition.output.schema, value, '')
  assert.deepEqual(outViolations, [], name + ' 的输出不符合 schema：' + JSON.stringify(outViolations))
  const parts = definition.output.render(args, value)
  assert.equal(parts[0].type, 'text')
  assert.equal(typeof parts[0].text, 'string')
}

if (typeof ctx._dispose === 'function') await ctx._dispose()
console.log('dsh-room tools schema check: PASS')
