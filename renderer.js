const { ipcRenderer } = require('electron')

const textarea = document.getElementById('clipboardText')
const statusDiv = document.getElementById('status')

// 监听文本框变化
textarea.addEventListener('input', (e) => {
    const text = e.target.value
    ipcRenderer.send('update-clipboard', text)
})

// 监听来自主进程的剪贴板更新
ipcRenderer.on('clipboard-updated', (event, text) => {
    textarea.value = text
})

// 监听连接状态更新
ipcRenderer.on('connection-status', (event, status) => {
    statusDiv.textContent = status
    
    // 更新状态样式
    statusDiv.className = 'status'
    if (status.includes('已连接')) {
        statusDiv.classList.add('connected')
    } else if (status.includes('断开')) {
        statusDiv.classList.add('disconnected')
    }
}) 