#!/usr/bin/env node
/**
 * 批量创建 STF 用户脚本
 * 使用方法: 
 *   node scripts/batch-create-users.js users.txt
 * 
 * users.txt 格式 (每行一个用户，用逗号或空格分隔):
 *   zhang.san@company.com,张三
 *   li.si@company.com 李四
 *   wang.wu@company.com,王五
 */

const fs = require('fs')
const dbapi = require('../lib/db/api')
const db = require('../lib/db')

// 解析命令行参数
const args = process.argv.slice(2)

if (args.length < 1) {
  console.error('用法: node batch-create-users.js <用户列表文件>')
  console.error('示例: node batch-create-users.js users.txt')
  console.error('')
  console.error('文件格式 (每行一个用户):')
  console.error('  zhang.san@company.com,张三')
  console.error('  li.si@company.com 李四')
  process.exit(1)
}

const filename = args[0]

if (!fs.existsSync(filename)) {
  console.error(`错误: 文件 ${filename} 不存在`)
  process.exit(1)
}

// 读取用户列表
const content = fs.readFileSync(filename, 'utf-8')
const lines = content.split('\n').filter(line => line.trim() && !line.trim().startsWith('#'))

const users = []
for (let i = 0; i < lines.length; i++) {
  const line = lines[i].trim()
  // 支持逗号或空格分隔
  const parts = line.includes(',') ? line.split(',') : line.split(/\s+/)
  
  if (parts.length >= 2) {
    const email = parts[0].trim()
    const name = parts.slice(1).join(' ').trim()
    
    // 验证邮箱格式
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
    if (emailRegex.test(email)) {
      users.push({ email, name })
    } else {
      console.warn(`警告: 第 ${i + 1} 行邮箱格式不正确，已跳过: ${line}`)
    }
  } else {
    console.warn(`警告: 第 ${i + 1} 行格式不正确，已跳过: ${line}`)
  }
}

if (users.length === 0) {
  console.error('错误: 没有找到有效的用户信息')
  process.exit(1)
}

console.log(`找到 ${users.length} 个用户，开始创建...\n`)

let successCount = 0
let failCount = 0

// 连接数据库并批量创建用户
db.setup()
  .then(async () => {
    for (let i = 0; i < users.length; i++) {
      const user = users[i]
      process.stdout.write(`[${i + 1}/${users.length}] 创建用户 ${user.email} (${user.name})... `)
      
      try {
        const stats = await dbapi.createUser(user.email, user.name, '127.0.0.1')
        if (stats.inserted) {
          console.log('✓ 成功')
          successCount++
        } else {
          console.log('✗ 已存在')
          failCount++
        }
      } catch (err) {
        console.log('✗ 失败:', err.message)
        failCount++
      }
      
      // 避免过快创建
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  })
  .then(() => {
    console.log('\n' + '='.repeat(50))
    console.log('批量创建完成:')
    console.log(`  成功: ${successCount} 个`)
    console.log(`  失败/已存在: ${failCount} 个`)
    console.log(`  总计: ${users.length} 个`)
  })
  .catch((err) => {
    console.error('\n✗ 批量创建出错:', err.message)
    console.error(err.stack)
    process.exit(1)
  })
  .finally(() => {
    setTimeout(() => process.exit(0), 1000)
  })

