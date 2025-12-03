#!/usr/bin/env node
/**
 * 快速创建 STF 用户脚本
 * 使用方法: 
 *   node scripts/create-user.js <email> <name>
 *   或者: ./scripts/create-user.js <email> <name>
 */

const dbapi = require('../lib/db/api')
const db = require('../lib/db')

// 解析命令行参数
const args = process.argv.slice(2)

if (args.length < 2) {
  console.error('用法: node create-user.js <email> <name>')
  console.error('示例: node create-user.js zhang.san@company.com "张三"')
  process.exit(1)
}

const email = args[0]
const name = args[1]

// 验证邮箱格式
const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
if (!emailRegex.test(email)) {
  console.error('错误: 邮箱格式不正确')
  process.exit(1)
}

console.log(`正在创建用户...`)
console.log(`邮箱: ${email}`)
console.log(`姓名: ${name}`)

// 连接数据库并创建用户
db.setup()
  .then(() => {
    return dbapi.createUser(email, name, '127.0.0.1')
  })
  .then((stats) => {
    if (stats.inserted) {
      console.log('\n✓ 用户创建成功!')
      console.log('用户信息:')
      console.log('  邮箱:', stats.changes[0].new_val.email)
      console.log('  姓名:', stats.changes[0].new_val.name)
      console.log('  权限:', stats.changes[0].new_val.privilege)
      console.log('  创建时间:', new Date(stats.changes[0].new_val.createdAt).toLocaleString('zh-CN'))
      console.log('\n用户现在可以使用该邮箱登录 STF')
    } else {
      console.error('\n✗ 用户创建失败: 用户已存在')
      process.exit(1)
    }
  })
  .catch((err) => {
    console.error('\n✗ 创建用户时出错:', err.message)
    console.error(err.stack)
    process.exit(1)
  })
  .finally(() => {
    setTimeout(() => process.exit(0), 1000)
  })

