const { app, BrowserWindow, clipboard, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const WebSocket = require('ws')
const os = require('os')

let mainWindow = null
let tray = null
let ws
const PORT = 3000

// 创建托盘图标
function createTray() {
    // 创建一个简单的图标
    const iconPath = process.platform === 'win32' ? 'windows-icon.ico' : 'icon.png'
    tray = new Tray(path.join(__dirname, iconPath))
    
    const contextMenu = Menu.buildFromTemplate([
        { 
            label: '显示主窗口', 
            click: () => {
                if (mainWindow === null) {
                    createWindow()
                } else {
                    mainWindow.show()
                }
            }
        },
        { type: 'separator' },
        { 
            label: '退出', 
            click: () => {
                app.isQuitting = true
                app.quit()
            }
        }
    ])
    
    tray.setToolTip('剪贴板同步工具')
    tray.setContextMenu(contextMenu)
    
    tray.on('click', () => {
        if (mainWindow === null) {
            createWindow()
        } else {
            mainWindow.show()
        }
    })
}

const createWindow = () => {
    if (mainWindow !== null) {
        return
    }

    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: true
        }
    })

    mainWindow.loadFile('index.html')
    
    // 处理窗口关闭事件
    mainWindow.on('close', (event) => {
        if (!app.isQuitting) {
            event.preventDefault()
            mainWindow.hide()
        }
    })

    mainWindow.on('closed', () => {
        mainWindow = null
    })
}

// 创建WebSocket服务器或客户端
function setupWebSocket() {
    const platform = os.platform()
    
    if (platform === 'darwin') {
        // Mac作为服务器
        const wss = new WebSocket.Server({ port: PORT })
        
        wss.on('connection', (socket) => {
            ws = socket
            mainWindow.webContents.send('connection-status', '已连接到Windows客户端')
            
            socket.on('message', (message) => {
                try {
                    const data = JSON.parse(message)
                    if (data.type === 'text') {
                        clipboard.writeText(data.content)
                    } else if (data.type === 'image') {
                        const image = nativeImage.createFromDataURL(data.content)
                        clipboard.writeImage(image)
                    }
                    mainWindow.webContents.send('clipboard-updated', data)
                } catch (error) {
                    console.error('Error processing message:', error)
                }
            })
            
            socket.on('close', () => {
                mainWindow.webContents.send('connection-status', '连接已断开')
            })
        })
    } else {
        // Windows作为客户端
        ws = new WebSocket('ws://localhost:' + PORT)
        
        ws.on('open', () => {
            mainWindow.webContents.send('connection-status', '已连接到Mac服务器')
            // 发送连接成功消息到服务器
            ws.send(JSON.stringify({
                type: 'connection',
                content: 'Windows client connected'
            }))
        })
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message)
                if (data.type === 'text') {
                    clipboard.writeText(data.content)
                } else if (data.type === 'image') {
                    const image = nativeImage.createFromDataURL(data.content)
                    clipboard.writeImage(image)
                }
                mainWindow.webContents.send('clipboard-updated', data)
            } catch (error) {
                console.error('Error processing message:', error)
            }
        })
        
        ws.on('close', () => {
            mainWindow.webContents.send('connection-status', '连接已断开')
            // 尝试重新连接
            setTimeout(setupWebSocket, 5000)
        })
    }
}

app.whenReady().then(() => {
    createWindow()
    createTray()
    setupWebSocket()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
})

// 处理从渲染进程发来的剪贴板更新请求
ipcMain.on('update-clipboard', (event, data) => {
    try {
        if (data.type === 'text') {
            clipboard.writeText(data.content)
        } else if (data.type === 'image') {
            const image = nativeImage.createFromDataURL(data.content)
            clipboard.writeImage(image)
        }
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data))
        }
    } catch (error) {
        console.error('Error updating clipboard:', error)
    }
})

// 处理退出事件
app.on('before-quit', () => {
    app.isQuitting = true
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})