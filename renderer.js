const { ipcRenderer, clipboard } = require('electron')
const fs = require('fs')
const path = require('path')

const textarea = document.getElementById('clipboardText')
const statusDiv = document.getElementById('status')

// 监听文本框变化
textarea.addEventListener('input', (e) => {
    const text = e.target.value
    ipcRenderer.send('update-clipboard', {
        type: 'text',
        content: text
    })
})

// 处理文件拖放
document.addEventListener('dragover', (e) => {
    e.preventDefault()
    e.stopPropagation()
})

document.addEventListener('drop', async (e) => {
    e.preventDefault()
    e.stopPropagation()
    
    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
        handleFiles(files)
    }
})

// 处理文件粘贴和普通粘贴
document.addEventListener('paste', async (e) => {
    e.preventDefault()
    
    // 检查是否有文件
    const files = Array.from(e.clipboardData.files)
    if (files.length > 0) {
        handleFiles(files)
        return
    }
    
    // 检查是否有图片
    const image = clipboard.readImage()
    if (!image.isEmpty()) {
        const imageData = image.toDataURL()
        ipcRenderer.send('update-clipboard', {
            type: 'image',
            content: imageData
        })
        textarea.value = '[图片已复制]'
        return
    }
    
    // 如果没有图片，则处理文本
    const text = clipboard.readText()
    if (text) {
        textarea.value = text
        ipcRenderer.send('update-clipboard', {
            type: 'text',
            content: text
        })
    }
})

// 处理文件
async function handleFiles(files) {
    textarea.value = `正在处理 ${files.length} 个文件...`
    
    try {
        const fileDataArray = await Promise.all(files.map(async (file) => {
            const buffer = await fs.promises.readFile(file.path)
            return {
                name: file.name,
                path: file.path,
                size: file.size,
                type: file.type || path.extname(file.path),
                data: buffer.toString('base64')
            }
        }))

        // 发送文件数据
        ipcRenderer.send('update-clipboard', {
            type: 'files',
            content: fileDataArray
        })
        
        // 更新界面显示
        textarea.value = `[已复制 ${files.length} 个文件]\n${files.map(f => f.name).join('\n')}`
        
        // 如果是Windows，将文件路径写入剪贴板
        if (process.platform === 'win32') {
            const filePaths = files.map(f => f.path)
            clipboard.writeBuffer('FileNameW', Buffer.from(filePaths.join('\0') + '\0', 'ucs2'))
        }
    } catch (error) {
        textarea.value = `处理文件失败: ${error.message}`
    }
}

// 监听来自主进程的剪贴板更新
ipcRenderer.on('clipboard-updated', (event, data) => {
    if (data.type === 'text') {
        textarea.value = data.content
    } else if (data.type === 'image') {
        textarea.value = '[收到图片]'
    } else if (data.type === 'files') {
        const files = data.content
        textarea.value = `[收到 ${files.length} 个文件]\n${files.map(f => f.name).join('\n')}`
        // 自动保存接收到的文件
        ipcRenderer.send('save-received-files', files)
    }
})

// 监听文件保存结果
ipcRenderer.on('files-saved', (event, result) => {
    if (result.success) {
        textarea.value += '\n保存位置: ' + result.savePath
    } else {
        textarea.value += '\n保存失败: ' + result.error
    }
})

// 监听连接状态更新
ipcRenderer.on('connection-status', (event, status) => {
    statusDiv.textContent = status
    
    statusDiv.className = 'status'
    if (status.includes('已连接')) {
        statusDiv.classList.add('connected')
    } else if (status.includes('断开') || status.includes('错误')) {
        statusDiv.classList.add('disconnected')
    }
})

// 请求初始连接状态
ipcRenderer.send('get-connection-status') 