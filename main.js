const { app, BrowserWindow, clipboard, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron')
const path = require('path')
const WebSocket = require('ws')
const os = require('os')
const dgram = require('dgram')
const fs = require('fs')

// 设置控制台编码
if (process.platform === 'win32') {
    process.env.LANG = 'zh_CN.UTF-8'
    process.env.CHCP = '65001'
    
    // 使用 PowerShell 命令设置代码页
    const { execSync } = require('child_process')
    try {
        execSync('powershell -command "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8"', { stdio: 'ignore' })
        execSync('powershell -command "$OutputEncoding = [System.Text.Encoding]::UTF8"', { stdio: 'ignore' })
        execSync('chcp 65001', { stdio: 'ignore' })
    } catch (error) {
        // 忽略错误
    }
}

// 创建日志函数
function log(message, ...args) {
    const timestamp = new Date().toLocaleTimeString()
    const logMessage = `[${timestamp}] ${message}`
    
    // 在Windows上特殊处理args的显示
    if (process.platform === 'win32' && args.length > 0) {
        const argsStr = args.map(arg => {
            if (typeof arg === 'object') {
                return JSON.stringify(arg, null, 2)
            }
            return String(arg)
        }).join(' ')
        process.stdout.write(Buffer.from(logMessage + ' ' + argsStr + '\n', 'utf8'))
    } else {
        console.log(logMessage, ...args)
    }
}

function logError(message, ...args) {
    const timestamp = new Date().toLocaleTimeString()
    const errorMessage = `[${timestamp}] 错误: ${message}`
    
    if (process.platform === 'win32' && args.length > 0) {
        const argsStr = args.map(arg => {
            if (arg instanceof Error) {
                return arg.message
            }
            if (typeof arg === 'object') {
                return JSON.stringify(arg, null, 2)
            }
            return String(arg)
        }).join(' ')
        process.stderr.write(Buffer.from(errorMessage + ' ' + argsStr + '\n', 'utf8'))
    } else {
        console.error(errorMessage, ...args)
    }
}

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
                log('找到本机IP:', addr.address)
                return addr.address
            }
        }
    }
    log('未找到有效IP，使用默认IP')
    return '127.0.0.1'
}

// 创建发现服务
function setupDiscoveryService() {
    const platform = os.platform()
    discoveryServer = dgram.createSocket('udp4')

    // 添加错误处理
    discoveryServer.on('error', (err) => {
        logError('UDP服务器错误:', err)
        mainWindow.webContents.send('connection-status', '网络发现服务错误')
    })

    if (platform === 'darwin') {
        // Mac作为服务器，监听发现请求
        discoveryServer.on('message', (msg, rinfo) => {
            log('收到发现请求:', msg.toString(), '来自:', rinfo.address)
            if (msg.toString() === 'FIND_CLIPBOARD_SERVER') {
                const localIP = getLocalIPAddress()
                log('发送响应IP:', localIP, '到:', rinfo.address)
                const response = Buffer.from(localIP)
                discoveryServer.send(response, rinfo.port, rinfo.address, (err) => {
                    if (err) {
                        logError('发送响应失败:', err)
                    }
                })
            }
        })

        discoveryServer.bind(DISCOVERY_PORT, '0.0.0.0', () => {
            log('Mac服务器开始监听UDP端口:', DISCOVERY_PORT)
            discoveryServer.setBroadcast(true)
        })
    } else {
        // Windows作为客户端，发送发现请求
        discoveryServer.bind(0, '0.0.0.0', () => {
            log('Windows客户端启动UDP服务')
            discoveryServer.setBroadcast(true)
            
            function findServer() {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    log('已连接到服务器，跳过搜索')
                    return
                }
                
                log('发送广播寻找服务器...')
                const message = Buffer.from('FIND_CLIPBOARD_SERVER')
                
                // 获取所有网络接口的广播地址
                const interfaces = os.networkInterfaces()
                for (const interfaceName of Object.keys(interfaces)) {
                    const addresses = interfaces[interfaceName]
                    for (const addr of addresses) {
                        if (addr.family === 'IPv4' && !addr.internal) {
                            // 计算广播地址
                            const broadcastAddr = addr.address.split('.')
                            broadcastAddr[3] = '255'
                            const broadcast = broadcastAddr.join('.')
                            
                            log('在接口', interfaceName, '发送广播到:', broadcast)
                            discoveryServer.send(message, 0, message.length, DISCOVERY_PORT, broadcast, (err) => {
                                if (err) {
                                    logError('发送广播失败:', err)
                                }
                            })
                        }
                    }
                }
            }

            // 立即开始寻找服务器
            findServer()
            // 每5秒尝试一次
            const searchInterval = setInterval(findServer, 5000)

            // 处理响应
            discoveryServer.on('message', (msg, rinfo) => {
                const serverIP = msg.toString()
                log('收到服务器响应:', serverIP, '来自:', rinfo.address)
                if (!ws || ws.readyState !== WebSocket.OPEN) {
                    connectToServer(serverIP)
                }
            })

            // 清理函数
            app.on('before-quit', () => {
                clearInterval(searchInterval)
                if (discoveryServer) {
                    discoveryServer.close()
                }
            })
        })
    }
}

// 连接到服务器
function connectToServer(serverIP) {
    log('尝试连接到服务器:', serverIP)
    
    if (ws) {
        log('关闭现有连接')
        ws.close()
        ws = null
    }

    try {
        ws = new WebSocket(`ws://${serverIP}:${PORT}`)
        
        ws.on('open', () => {
            log('WebSocket连接成功')
            mainWindow.webContents.send('connection-status', `已连接到Mac服务器 (${serverIP})`)
            ws.send(JSON.stringify({
                type: 'connection',
                content: 'Windows client connected'
            }))
        })
        
        ws.on('message', (message) => {
            try {
                const data = JSON.parse(message)
                log('收到消息类型:', data.type)
                if (data.type === 'text') {
                    clipboard.writeText(data.content)
                } else if (data.type === 'image') {
                    const image = nativeImage.createFromDataURL(data.content)
                    clipboard.writeImage(image)
                }
                mainWindow.webContents.send('clipboard-updated', data)
            } catch (error) {
                logError('处理消息错误:', error)
            }
        })
        
        ws.on('close', () => {
            log('WebSocket连接关闭')
            mainWindow.webContents.send('connection-status', '连接已断开')
            ws = null
        })

        ws.on('error', (error) => {
            logError('WebSocket错误:', error)
            mainWindow.webContents.send('connection-status', '连接错误')
            ws = null
        })
    } catch (error) {
        logError('创建WebSocket连接错误:', error)
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
                    logError('Error processing message:', error)
                }
            })
            
            socket.on('close', () => {
                mainWindow.webContents.send('connection-status', '连接已断开')
            })
        })

        wss.on('error', (error) => {
            logError('WebSocket server error:', error)
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
        } else if (data.type === 'files') {
            // 在Windows上，将文件路径写入剪贴板
            if (process.platform === 'win32') {
                clipboard.writeBuffer('FileNameW', Buffer.from(data.content.map(f => f.name).join('\0') + '\0', 'ucs2'))
            }
        }
        
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data))
        }
    } catch (error) {
        logError('Error updating clipboard:', error)
    }
})

// 处理文件保存请求
ipcMain.on('save-received-files', async (event, files) => {
    try {
        // 创建接收文件的目录
        const downloadPath = path.join(app.getPath('downloads'), 'ClipboardSync')
        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath, { recursive: true })
        }

        // 保存所有文件
        const savedFiles = []
        for (const file of files) {
            const filePath = path.join(downloadPath, file.name)
            const buffer = Buffer.from(file.data, 'base64')
            await fs.promises.writeFile(filePath, buffer)
            savedFiles.push(filePath)
        }

        // 将保存的文件路径写入剪贴板（用于Windows的粘贴操作）
        if (process.platform === 'win32') {
            clipboard.writeBuffer('FileNameW', Buffer.from(savedFiles.join('\0') + '\0', 'ucs2'))
        }

        event.reply('files-saved', {
            success: true,
            savePath: downloadPath
        })
    } catch (error) {
        logError('保存文件失败:', error)
        event.reply('files-saved', {
            success: false,
            error: error.message
        })
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

// 添加连接状态处理
ipcMain.on('get-connection-status', (event) => {
    if (ws && ws.readyState === WebSocket.OPEN) {
        event.reply('connection-status', `已连接到Mac服务器`)
    } else {
        event.reply('connection-status', '等待连接...')
    }
})