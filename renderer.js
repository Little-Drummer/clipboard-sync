const { ipcRenderer, clipboard } = require('electron')
const clipboardText = document.getElementById('clipboardText')
const status = document.getElementById('status')
const dropZone = document.getElementById('dropZone')

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

// 处理文件拖放
dropZone.addEventListener('drop', async (e) => {
    e.preventDefault()
    e.stopPropagation()
    dropZone.classList.remove('drag-over')

    const files = Array.from(e.dataTransfer.files)
    if (files.length > 0) {
        clipboardText.value = `[已复制 ${files.length} 个文件]`
        
        // 读取文件内容并发送
        const fileData = await Promise.all(files.map(async (file) => {
            return {
                name: file.name,
                path: file.path,
                data: await readFileAsBase64(file)
            }
        }))

        ipcRenderer.send('update-clipboard', {
            type: 'files',
            content: fileData
        })
    }
})

// 处理粘贴事件
clipboardText.addEventListener('paste', (e) => {
    e.preventDefault()
    const items = e.clipboardData.items

    // 检查是否有文件
    const files = Array.from(items)
        .filter(item => item.kind === 'file')
        .map(item => item.getAsFile())

    if (files.length > 0) {
        // 如果是文件，走文件处理逻辑
        handleFiles(files)
    } else {
        // 如果是普通文本或图片，使用普通剪贴板逻辑
        const text = e.clipboardData.getData('text')
        if (text) {
            clipboardText.value = text
            ipcRenderer.send('update-clipboard', {
                type: 'text',
                content: text
            })
        }
    }
})

async function handleFiles(files) {
    if (files.length > 0) {
        clipboardText.value = `[已复制 ${files.length} 个文件]`
        
        const fileData = await Promise.all(files.map(async (file) => {
            return {
                name: file.name,
                path: file.path || `clipboard_${Date.now()}_${file.name}`,
                data: await readFileAsBase64(file)
            }
        }))

        ipcRenderer.send('update-clipboard', {
            type: 'files',
            content: fileData
        })
    }
}

// 读取文件为Base64
function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            const base64 = reader.result.split(',')[1]
            resolve(base64)
        }
        reader.onerror = reject
        reader.readAsDataURL(file)
    })
}

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
    } else if (data.type === 'files') {
        clipboardText.value = `[收到 ${data.content.length} 个文件]`
        // 保存接收到的文件
        ipcRenderer.send('save-received-files', data.content)
    }
})

// 监听文件保存结果
ipcRenderer.on('files-saved', (event, result) => {
    if (result.success) {
        clipboardText.value = `[文件已保存到: ${result.savePath}]`
    } else {
        clipboardText.value = `[保存文件失败: ${result.error}]`
    }
}) 