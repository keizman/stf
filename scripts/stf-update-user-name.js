#!/usr/bin/env node
/**
 * 更新 STF 用户姓名
 * 使用方法: node stf-update-user-name.js <email> <new-name>
 */

const r = require('rethinkdb')
const db = require('../lib/db')

const args = process.argv.slice(2)

if (args.length < 2) {
  console.error('用法: node stf-update-user-name.js <email> <new-name>')
  console.error('示例: node stf-update-user-name.js test@test.com "新姓名"')
  process.exit(1)
}

const email = args[0]
const newName = args[1]

db.setup()
  .then(() => db.connect())
  .then(conn => {
    return r.table('users')
      .get(email)
      .update({ name: newName })
      .run(conn)
  })
  .then(result => {
    if (result.replaced === 1) {
      console.log(`\n✓ 用户姓名更新成功!`)
      console.log(`  邮箱: ${email}`)
      console.log(`  新姓名: ${newName}`)
      console.log('\n现在可以使用新姓名登录了')
    } else if (result.unchanged === 1) {
      console.log(`\n⚠ 用户姓名未改变（已经是 "${newName}"）`)
    } else {
      console.error(`\n✗ 用户不存在: ${email}`)
      process.exit(1)
    }
  })
  .catch(err => {
    console.error('\n✗ 更新用户时出错:', err.message)
    process.exit(1)
  })
  .finally(() => {
    setTimeout(() => process.exit(0), 1000)
  })

