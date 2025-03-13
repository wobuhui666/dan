const express = require('express')
const axios = require('axios')
const fs = require('fs/promises')
const path = require('path')
const { URL } = require('url')

const app = express()

// 配置项（Vercel环境适配）
const CONFIG = {
  xmlDir: path.join('/tmp', 'xml'),       // 使用临时目录
  proxyService: process.env.PROXY_SERVICE || 'https://fc.lyz05.cn',
  keepHours: 24,
  maxFileCount: 100                      // 最大文件数量限制
}

// 中间件：限制XML目录文件数量
app.use(async (req, res, next) => {
  try {
    const files = await fs.readdir(CONFIG.xmlDir)
    if (files.length > CONFIG.maxFileCount) {
      await cleanOldFiles()
    }
  } catch (error) {
    // 首次运行时目录不存在是正常的
    if (error.code !== 'ENOENT') console.error('文件监控失败:', error.message)
  }
  next()
})

// 静态文件服务（Vercel需要显式声明）
app.use('/xml', express.static(CONFIG.xmlDir))

// 工具函数：从URL提取视频ID
function extractVideoId(url) {
  try {
    const parsed = new URL(url)
    const pathParts = parsed.pathname.split('/')
    return pathParts.pop().split('.')[0]
  } catch {
    return Date.now().toString() // 生成唯一ID作为回退
  }
}

// 代理路由
app.get('/proxy/*', async (req, res) => {
  try {
    const rawUrl = decodeURIComponent(req.params[0])
    const parsedUrl = new URL(rawUrl)

    // B站特殊处理
    if (parsedUrl.hostname.includes('bilibili')) {
      return res.redirect(302, `${CONFIG.proxyService}/?url=${encodeURIComponent(rawUrl)}`)
    }

    const videoId = extractVideoId(rawUrl)
    const xmlFilename = `${videoId}.xml`
    const filePath = path.join(CONFIG.xmlDir, xmlFilename)

    try {
      // 检查文件是否存在且未过期
      const stats = await fs.stat(filePath)
      if (Date.now() - stats.mtimeMs < CONFIG.keepHours * 3600 * 1000) {
        return res.redirect(302, `/xml/${xmlFilename}`)
      }
    } catch {}

    // 获取并保存XML
    const response = await axios.get(
      `${CONFIG.proxyService}/?url=${encodeURIComponent(rawUrl)}&download=on`,
      { timeout: 10000 }
    )

    await fs.mkdir(CONFIG.xmlDir, { recursive: true })
    await fs.writeFile(filePath, response.data)
    
    res.redirect(302, `/xml/${xmlFilename}`)
  } catch (error) {
    console.error(`处理失败 [${req.ip}]:`, error.message)
    res.redirect(302, 'https://http.cat/500') // 使用HTTP状态码示例
  }
})

// 清理任务接口（需外部定时触发）
app.get('/clean-task', async (req, res) => {
  try {
    if (req.query.secret !== process.env.CLEAN_SECRET) {
      return res.status(403).send('Invalid secret')
    }
    await cleanOldFiles()
    res.send('Cleanup completed')
  } catch (error) {
    res.status(500).send('Cleanup failed: ' + error.message)
  }
})

// 文件清理方法
async function cleanOldFiles() {
  try {
    const files = await fs.readdir(CONFIG.xmlDir)
    const now = Date.now()
    
    await Promise.all(files.map(async file => {
      const filePath = path.join(CONFIG.xmlDir, file)
      try {
        const stats = await fs.stat(filePath)
        if (now - stats.mtimeMs > CONFIG.keepHours * 3600 * 1000) {
          await fs.unlink(filePath)
        }
      } catch (error) {
        console.error('删除文件失败:', error.message)
      }
    }))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
}

// 错误处理中间件
app.use((err, req, res, next) => {
  console.error('全局错误:', err.stack)
  res.redirect(302, 'https://http.cat/500')
})

module.exports = app
