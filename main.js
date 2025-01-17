const { app, BrowserWindow, clipboard, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const WebSocket = require('ws')
const os = require('os')
const dgram = require('dgram')

let mainWindow = null
let tray = null
let ws = null
let discoveryServer = null
const PORT = 3000
const DISCOVERY_PORT = 3001

// 获取本机IP地址
function getLocalIPAddress() {
    const interfaces = os.networkInterfaces()
    for (const interfaceName of Object.keys(interfaces)) {
        const addresses = interfaces[interfaceName]
        for (const addr of addresses) {
            if (addr.family === 'IPv4' && !addr.internal) {
                return addr.address
            }
        }
    }
    return '127.0.0.1'
}

// 创建发现服务
function setupDiscoveryService() {
    const platform = os.platform()
    discoveryServer = dgram.createSocket('udp4')

    if (platform === 'darwin') {
        // Mac作为服务器，监听发现请求
        discoveryServer.on('message', (msg, rinfo) => {
            if (msg.toString() === 'FIND_CLIPBOARD_SERVER') {
                const response = Buffer.from(getLocalIPAddress())
                discoveryServer.send(response, rinfo.port, rinfo.address)
            }
        })

        discoveryServer.bind(DISCOVERY_PORT)
    } else {
        // Windows作为客户端，发送发现请求
        discoveryServer.bind(() => {
            discoveryServer.setBroadcast(true)
            
            function findServer() {
                if (ws && ws.readyState === WebSocket.OPEN) return
                
                const message = Buffer.from('FIND_CLIPBOARD_SERVER')
                discoveryServer.send(message, 0, message.length, DISCOVERY_PORT, '255.255.255.255')
            }

            // 定期发送发现请求
            findServer()
            setInterval(findServer, 5000)

            // 处理响应
            discoveryServer.on('message', (msg) => {
                const serverIP = msg.toString()
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    connectToServer(serverIP)
                }
            })
        })
    }
}

// 连接到服务器
function connectToServer(serverIP) {
    if (ws) {
        ws.close()
    }

    ws = new WebSocket(`ws://${serverIP}:${PORT}`)
    
    ws.on('open', () => {
        mainWindow.webContents.send('connection-status', `已连接到Mac服务器 (${serverIP})`)
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
    })

    ws.on('error', (error) => {
        console.error('WebSocket error:', error)
        mainWindow.webContents.send('connection-status', '连接错误')
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
            const clientIP = socket._socket.remoteAddress.replace('::ffff:', '')
            mainWindow.webContents.send('connection-status', `已连接到Windows客户端 (${clientIP})`)
            
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

        wss.on('error', (error) => {
            console.error('WebSocket server error:', error)
            mainWindow.webContents.send('connection-status', '服务器错误')
        })
    }
}

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

app.whenReady().then(() => {
    createWindow()
    createTray()
    setupWebSocket()
    setupDiscoveryService()

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