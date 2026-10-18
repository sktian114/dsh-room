#!/usr/bin/env node
/**
 * dsh-room 安装脚本（跨平台，Node ≥ 20）。
 *
 * 桌面版 profile（desktop）不允许 `dsh plugin add`，所以这里做两件事：
 *   1. 把插件复制到 <DSH_HOME>/profiles/<profile>/node_modules/@sktian114/dsh-room
 *   2. 在 <profile>/cordis.patch.yml 里追加挂载项（幂等）
 *
 * 用法：
 *   node install.mjs                  # 装到 desktop profile
 *   node install.mjs --profile web    # 装到别的 profile
 *   node install.mjs --uninstall      # 卸载（删目录 + 去掉挂载项）
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE = '@sktian114/dsh-room'
const HERE = dirname(fileURLToPath(import.meta.url))
const args = process.argv.slice(2)
const uninstall = args.includes('--uninstall')
const profileIndex = args.indexOf('--profile')
const profile = profileIndex >= 0 ? args[profileIndex + 1] : 'desktop'

if (args.includes('--help') || args.includes('-h')) {
  console.log('node install.mjs [--profile <名字>] [--uninstall]')
  process.exit(0)
}

const dshHome = process.env.DSH_HOME || join(homedir(), '.dsh')
const profileDir = join(dshHome, 'profiles', profile)
const dest = join(profileDir, 'node_modules', ...PACKAGE.split('/'))
const legacy = join(profileDir, 'node_modules', 'dsh-room')
const patch = join(profileDir, 'cordis.patch.yml')

if (!existsSync(profileDir)) {
  console.error(`找不到 DSH profile: ${profileDir}`)
  console.error('确认 DSH 已安装、并用 --profile 指定正确的 profile 名字。')
  process.exit(1)
}

/** 去掉本插件写入的挂载块。 */
function stripMount(text) {
  const lines = String(text || '').split(/\r?\n/)
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.trim() === '- insert:') {
      const block = []
      let j = i + 1
      while (j < lines.length && (/^\s{4,}\S/.test(lines[j]) || lines[j].trim() === '')) {
        block.push(lines[j])
        j++
      }
      if (block.some((entry) => /id:\s*dsh-room\b/.test(entry))) {
        i = j - 1
        continue
      }
    }
    out.push(line)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

if (uninstall) {
  for (const dir of [dest, legacy]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      console.log(`已删除 ${dir}`)
    }
  }
  if (existsSync(patch)) {
    writeFileSync(patch, stripMount(readFileSync(patch, 'utf8')), 'utf8')
    console.log('已移除 cordis.patch.yml 里的 dsh-room 挂载项')
  }
  console.log('完成。请完全退出并重启 DSH（托盘 → 退出）。')
  process.exit(0)
}

// 复制插件本体（仓库里的 .git / preview / test 不装进 profile）
const FILES = ['index.mjs', 'package.json', 'cordis.patch.yml', 'README.md', 'LICENSE', 'CHANGELOG.md', 'SECURITY.md']
const DIRS = ['lib']
rmSync(dest, { recursive: true, force: true })
rmSync(legacy, { recursive: true, force: true })
mkdirSync(dest, { recursive: true })
for (const file of FILES) {
  const from = join(HERE, file)
  if (!existsSync(from)) continue
  copyFileSync(from, join(dest, file))
}
for (const dir of DIRS) {
  const from = join(HERE, dir)
  if (!existsSync(from)) continue
  const walk = (relative) => {
    const source = join(from, relative)
    const target = join(dest, dir, relative)
    mkdirSync(target, { recursive: true })
    for (const entry of readdirSync(source, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(join(relative, entry.name))
      else copyFileSync(join(source, entry.name), join(target, entry.name))
    }
  }
  walk('')
}

let text = existsSync(patch) ? readFileSync(patch, 'utf8') : ''
if (!/id:\s*dsh-room\b/.test(text)) {
  if (text && !text.endsWith('\n')) text += '\n'
  text += `\n- insert:\n    - id: dsh-room\n      name: "${PACKAGE}"\n`
  writeFileSync(patch, text, 'utf8')
  console.log(`已写入挂载项: ${patch}`)
} else {
  console.log('挂载项已存在，跳过。')
}

console.log(`\n安装到: ${dest}`)
console.log('下一步：完全退出 DSH（托盘 → 退出）再启动，然后打开任意会话。')
