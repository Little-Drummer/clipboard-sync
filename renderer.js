const { ipcRenderer } = require('electron')
const clipboardText = document.getElementById('clipboardText')
const status = document.getElementById('status')

// 处理文本框输入
clipboardText.addEventListener('input', (e) => {
    const text = e.target.value
    ipcRenderer.send('update-clipboard', {
        type: 'text',
        content: text
    })
})

// 处理粘贴事件
clipboardText.addEventListener('paste', (e) => {
    e.preventDefault()
    
    // 检查是否有图片
    const items = e.clipboardData.items
    for (const item of items) {
        if (item.type.startsWith('image/')) {
            const blob = item.getAsFile()
            const reader = new FileReader()
            reader.onload = () => {
                const dataUrl = reader.result
                ipcRenderer.send('update-clipboard', {
                    type: 'image',
                    content: dataUrl
                })
                clipboardText.value = '[图片已粘贴]'
            }
            reader.readAsDataURL(blob)
            return
        }
    }

    // 如果没有图片，处理文本
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
    try {
        if (data.type === 'text') {
            clipboardText.value = data.content
        } else if (data.type === 'image') {
            clipboardText.value = '[收到图片]'
        }
    } catch (error) {
        console.error('处理剪贴板更新错误:', error)
    }
}) 