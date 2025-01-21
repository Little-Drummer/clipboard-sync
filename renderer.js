const { ipcRenderer, clipboard } = require('electron')
const clipboardText = document.getElementById('clipboardText')
const status = document.getElementById('status')

// 监听剪贴板变化
let lastText = clipboard.readText()
let lastImage = clipboard.readImage()

function checkClipboard() {
    // 检查文本变化
    const newText = clipboard.readText()
    if (newText !== lastText) {
        lastText = newText
        clipboardText.value = newText
        ipcRenderer.send('update-clipboard', {
            type: 'text',
            content: newText
        })
    }

    // 检查图片变化
    const newImage = clipboard.readImage()
    if (!newImage.isEmpty() && newImage.toDataURL() !== lastImage.toDataURL()) {
        lastImage = newImage
        // 更新显示
        clipboardText.value = '[图片已复制]'
        // 发送图片数据
        ipcRenderer.send('update-clipboard', {
            type: 'image',
            content: newImage.toDataURL()
        })
    }
}

// 每500ms检查一次剪贴板
setInterval(checkClipboard, 500)

// 处理粘贴事件
clipboardText.addEventListener('paste', (e) => {
    e.preventDefault()
    const text = e.clipboardData.getData('text')
    if (text) {
        clipboardText.value = text
        ipcRenderer.send('update-clipboard', {
            type: 'text',
            content: text
        })
    }
})

// 监听连接状态更新
ipcRenderer.on('connection-status', (event, message) => {
    status.textContent = message
    if (message.includes('已连接')) {
        status.classList.add('connected')
        status.classList.remove('disconnected')
    } else {
        status.classList.remove('connected')
        status.classList.add('disconnected')
    }
})

// 监听剪贴板更新
ipcRenderer.on('clipboard-updated', (event, data) => {
    if (data.type === 'text') {
        clipboardText.value = data.content
    } else if (data.type === 'image') {
        clipboardText.value = '[收到图片]'
    }
}) 