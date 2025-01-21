const { ipcRenderer, clipboard } = require('electron')
const clipboardText = document.getElementById('clipboardText')
const status = document.getElementById('status')

// 监听剪贴板变化
let lastText = clipboard.readText()
let lastImage = null
let isProcessing = false

function compareImages(img1, img2) {
    if (!img1 || !img2) return false
    if (img1.isEmpty() && img2.isEmpty()) return true
    if (img1.isEmpty() !== img2.isEmpty()) return false
    return img1.toDataURL() === img2.toDataURL()
}

async function checkClipboard() {
    if (isProcessing) return
    isProcessing = true

    try {
        // 检查文本变化
        const newText = clipboard.readText()
        if (newText !== lastText) {
            lastText = newText
            clipboardText.value = newText
            if (newText) {  // 只在有文本时发送
                ipcRenderer.send('update-clipboard', {
                    type: 'text',
                    content: newText
                })
            }
        }

        // 检查图片变化
        const newImage = clipboard.readImage()
        if (!compareImages(newImage, lastImage)) {
            if (!newImage.isEmpty()) {
                lastImage = newImage
                clipboardText.value = '[图片已复制]'
                const dataUrl = newImage.toDataURL()
                if (dataUrl && dataUrl.startsWith('data:image/')) {
                    ipcRenderer.send('update-clipboard', {
                        type: 'image',
                        content: dataUrl
                    })
                }
            }
        }
    } catch (error) {
        console.error('检查剪贴板错误:', error)
    } finally {
        isProcessing = false
    }
}

// 每500ms检查一次剪贴板
const checkInterval = setInterval(checkClipboard, 500)

// 处理文本框输入
clipboardText.addEventListener('input', (e) => {
    const text = e.target.value
    if (text !== lastText) {
        lastText = text
        clipboard.writeText(text)
        ipcRenderer.send('update-clipboard', {
            type: 'text',
            content: text
        })
    }
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
        lastText = text
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
            lastText = data.content
            clipboardText.value = data.content
            clipboard.writeText(data.content)
        } else if (data.type === 'image') {
            const image = clipboard.readImage()
            image.loadDataURL(data.content)
            lastImage = image
            clipboard.writeImage(image)
            clipboardText.value = '[收到图片]'
        }
    } catch (error) {
        console.error('处理剪贴板更新错误:', error)
    }
})

// 清理
window.addEventListener('beforeunload', () => {
    clearInterval(checkInterval)
}) 