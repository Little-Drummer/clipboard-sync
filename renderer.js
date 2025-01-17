const { ipcRenderer, clipboard } = require('electron')

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

// 监听粘贴事件
document.addEventListener('paste', (e) => {
    e.preventDefault()
    
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

// 监听来自主进程的剪贴板更新
ipcRenderer.on('clipboard-updated', (event, data) => {
    if (data.type === 'text') {
        textarea.value = data.content
    } else if (data.type === 'image') {
        textarea.value = '[收到图片]'
    }
})

// 监听连接状态更新
ipcRenderer.on('connection-status', (event, status) => {
    // 更新状态文本
    statusDiv.textContent = status
    
    // 更新状态样式
    statusDiv.className = 'status'
    if (status.includes('已连接')) {
        statusDiv.classList.add('connected')
    } else if (status.includes('断开') || status.includes('错误')) {
        statusDiv.classList.add('disconnected')
    }
})

// 请求初始连接状态
ipcRenderer.send('get-connection-status') 