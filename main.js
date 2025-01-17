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
                console.log('找到本机IP:', addr.address)
                return addr.address
            }
        }
    }
    console.log('未找到有效IP，使用默认IP')
    return '127.0.0.1'
}

// 创建发现服务
function setupDiscoveryService() {
    const platform = os.platform()
    discoveryServer = dgram.createSocket('udp4')

    // 添加错误处理
    discoveryServer.on('error', (err) => {
        console.error('UDP服务器错误:', err)
        mainWindow.webContents.send('connection-status', '网络发现服务错误')
    })

    if (platform === 'darwin') {
        // Mac作为服务器，监听发现请求
        discoveryServer.on('message', (msg, rinfo) => {
            console.log('收到发现请求:', msg.toString(), '来自:', rinfo.address)
            if (msg.toString() === 'FIND_CLIPBOARD_SERVER') {
                const localIP = getLocalIPAddress()
                console.log('发送响应IP:', localIP, '到:', rinfo.address)
                const response = Buffer.from(localIP)
                discoveryServer.send(response, rinfo.port, rinfo.address)
            }
        })

        discoveryServer.bind(DISCOVERY_PORT, () => {
            console.log('Mac服务器开始监听UDP端口:', DISCOVERY_PORT)
        })
    } else {
        // Windows作为客户端，发送发现请求
        discoveryServer.bind(() => {
            console.log('Windows客户端启动UDP服务')
            discoveryServer.setBroadcast(true)
            
            function findServer() {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    console.log('已连接到服务器，跳过搜索')
                    return
                }
                
                console.log('发送广播寻找服务器...')
                const message = Buffer.from('FIND_CLIPBOARD_SERVER')
                // 发送到局域网广播地址
                discoveryServer.send(message, 0, message.length, DISCOVERY_PORT, '255.255.255.255')
                // 同时也发送到本地回环地址
                discoveryServer.send(message, 0, message.length, DISCOVERY_PORT, '127.0.0.1')
            }

            // 立即开始寻找服务器
            findServer()
            // 每5秒尝试一次
            const searchInterval = setInterval(findServer, 5000)

            // 处理响应
            discoveryServer.on('message', (msg, rinfo) => {
                const serverIP = msg.toString()
                console.log('收到服务器响应:', serverIP, '来自:', rinfo.address)
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    connectToServer(serverIP)
                }
            })

            // 清理函数
            app.on('before-quit', () => {
                clearInterval(searchInterval)
            })
        })
    }
}

// 连接到服务器
function connectToServer(serverIP) {
    console.log('尝试连接到服务器:', serverIP)
    
    if (ws) {
        console.log('关闭现有连接')
        ws.close()
        ws = null
    }

    try {
        ws = new WebSocket(`ws://${serverIP}:${PORT}`)
        
        ws.on('open', () => {
            console.log('WebSocket连接成功')
            mainWindow.webContents.send('connection-status', `已连接到Mac服务器 (${serverIP})`)
            ws.send(JSON.stringify({
                type: 'connection',
                content: 'Windows client connected'
            }))
        })
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message)
                console.log('收到消息类型:', data.type)
                if (data.type === 'text') {
                    clipboard.writeText(data.content)
                } else if (data.type === 'image') {
                    const image = nativeImage.createFromDataURL(data.content)
                    clipboard.writeImage(image)
                }
                mainWindow.webContents.send('clipboard-updated', data)
            } catch (error) {
                console.error('处理消息错误:', error)
            }
        })
        
        ws.on('close', () => {
            console.log('WebSocket连接关闭')
            mainWindow.webContents.send('connection-status', '连接已断开')
            ws = null
        })

        ws.on('error', (error) => {
            console.error('WebSocket错误:', error)
            mainWindow.webContents.send('connection-status', '连接错误')
            ws = null
        })
    } catch (error) {
        console.error('创建WebSocket连接错误:', error)
        mainWindow.webContents.send('connection-status', '创建连接失败')
        ws = null
    }
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
    
    function getContextMenu() {
        return Menu.buildFromTemplate([
            { 
                label: '连接状态',
                enabled: false,
                label: ws && ws.readyState === WebSocket.OPEN 
                    ? '已连接' 
                    : '未连接'
            },
            { type: 'separator' },
            { 
                label: '重新连接',
                click: () => {
                    if (process.platform === 'win32') {
                        // Windows端重新搜索服务器
                        const message = Buffer.from('FIND_CLIPBOARD_SERVER')
                        discoveryServer.send(message, 0, message.length, DISCOVERY_PORT, '255.255.255.255')
                    }
                }
            },
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
    }
    
    // 设置初始菜单
    tray.setContextMenu(getContextMenu())
    
    // 定期更新菜单以反映最新状态
    setInterval(() => {
        tray.setContextMenu(getContextMenu())
    }, 1000)
    
    tray.setToolTip('剪贴板同步工具')
    
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