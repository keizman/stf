#!/usr/bin/env node
/**
 * 查看 STF 用户信息
 * 使用方法: node stf-show-user.js <email>
 */

const dbapi = require('../lib/db/api')
const db = require('../lib/db')

const args = process.argv.slice(2)

if (args.length < 1) {
  console.error('用法: node stf-show-user.js <email>')
  console.error('示例: node stf-show-user.js test@test.com')
  process.exit(1)
}

const email = args[0]

db.setup()
  .then(() => dbapi.loadUser(email))
  .then(user => {
    if (user) {
      console.log('\n用户信息:')
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('  邮箱:', user.email)
      console.log('  姓名:', user.name)
      console.log('  权限:', user.privilege)
      console.log('  创建时间:', new Date(user.createdAt).toLocaleString('zh-CN'))
      console.log('  最后登录:', user.lastLoggedInAt ? new Date(user.lastLoggedInAt).toLocaleString('zh-CN') : '从未登录')
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
      console.log('\n登录提示:')
      console.log('  在 STF 登录页面输入:')
      console.log('    用户名:', user.name)
      console.log('    邮箱:', user.email)
      console.log('')
    } else {
      console.error(`\n✗ 用户不存在: ${email}`)
      process.exit(1)
    }
  })
  .catch(err => {
    console.error('\n✗ 查询用户时出错:', err.message)
    process.exit(1)
  })
  .finally(() => {
    setTimeout(() => process.exit(0), 1000)
  })

