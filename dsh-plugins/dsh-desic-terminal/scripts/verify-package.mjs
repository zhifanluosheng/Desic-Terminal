// 包契约校验：不联网、不打包，只断言本包符合「工作台插件」的关键契约字段。
// 用法：node scripts/verify-package.mjs
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))

assert.equal(pkg.name, 'dsh-desic-terminal')
assert.equal(pkg.type, 'module')
assert.equal(pkg.main, './src/index.js')
assert.equal(pkg.exports['.'], './src/index.js')
assert.equal(pkg.exports['./client'], './lib/client.js')
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(pkg.dsh?.client?.platform, 'web')
assert.ok(
  pkg.dsh?.client?.inject?.includes('dsh-desktop-workbenches'),
  '工作台客户端必须在 dsh.client.inject 中声明 dsh-desktop-workbenches',
)
assert.match(
  pkg.repository?.url ?? '',
  /^git\+https:\/\/github\.com\/xiazhi88\/Desic-Terminal\.git$/,
  'repository 必须是规范的 GitHub 地址（工作台身份来源）',
)

const patch = await readFile(join(root, 'cordis.patch.yml'), 'utf8')
assert.match(patch, /- insert:/)
assert.match(patch, /name: dsh-desic-terminal/)

const server = await readFile(join(root, 'src', 'index.js'), 'utf8')
assert.match(server, /export const name = 'dsh-desic-terminal'/)
assert.match(server, /export const inject = \['webServer'\]/)
assert.match(server, /export function apply\(/)

const client = await readFile(join(root, 'lib', 'client.js'), 'utf8')
assert.match(client, /__ModuleLoader__\.load\(\{\s*\n\s*id: 'dsh-desic-terminal',/)
assert.match(client, /desktopWorkbenches\.register\(/)
assert.match(client, /repository: 'https:\/\/github\.com\/xiazhi88\/Desic-Terminal'/)
assert.match(client, /customFrame: true/)

console.log('verify-package: OK —— 工作台契约字段全部通过')
