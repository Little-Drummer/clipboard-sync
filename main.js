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
    
    let finalMessage = logMessage
    if (args.length > 0) {
        const argsStr = args.map(arg => {
            if (typeof arg === 'object') {
                return JSON.stringify(arg, null, 2)
            }
            return String(arg)
        }).join(' ')
        finalMessage += ' ' + argsStr
    }

    // 发送到调试窗口
    if (debugWindow && !debugWindow.isDestroyed()) {
        debugWindow.webContents.send('debug-log', finalMessage)
    }

    // 原有的控制台输出
    if (process.platform === 'win32') {
        process.stdout.write(Buffer.from(finalMessage + '\n', 'utf8'))
    } else {
        console.log(finalMessage)
    }
}

function logError(message, ...args) {
    const timestamp = new Date().toLocaleTimeString()
    const errorMessage = `[${timestamp}] 错误: ${message}`
    
    let finalMessage = errorMessage
    if (args.length > 0) {
        const argsStr = args.map(arg => {
            if (arg instanceof Error) {
                return arg.message
            }
            if (typeof arg === 'object') {
                return JSON.stringify(arg, null, 2)
            }
            return String(arg)
        }).join(' ')
        finalMessage += ' ' + argsStr
    }

    // 发送到调试窗口
    if (debugWindow && !debugWindow.isDestroyed()) {
        debugWindow.webContents.send('debug-log', finalMessage)
    }

    // 原有的错误输出
    if (process.platform === 'win32') {
        process.stderr.write(Buffer.from(finalMessage + '\n', 'utf8'))
    } else {
        console.error(finalMessage)
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
    let bestIP = '127.0.0.1'
    let bestMetric = -1

    for (const interfaceName of Object.keys(interfaces)) {
        const addresses = interfaces[interfaceName]
        for (const addr of addresses) {
            if (addr.family === 'IPv4' && !addr.internal) {
                // 优先选择非虚拟网卡的地址
                const isVirtual = interfaceName.toLowerCase().includes('virtual') ||
                                interfaceName.toLowerCase().includes('vbox') ||
                                interfaceName.toLowerCase().includes('vmware')
                const metric = isVirtual ? 0 : 1

                if (metric > bestMetric) {
                    bestMetric = metric
                    bestIP = addr.address
                }
            }
        }
    }

    log('选择的本机IP:', bestIP)
    return bestIP
}

// 创建发现服务
function setupDiscoveryService() {
    const platform = os.platform()
    discoveryServer = dgram.createSocket('udp4')

    // 添加错误处理
    discoveryServer.on('error', (err) => {
        logError('UDP服务器错误:', err)
        mainWindow.webContents.send('connection-status', '网络发现服务错误')
        
        // 尝试重新创建UDP服务
        setTimeout(() => {
            if (discoveryServer) {
                discoveryServer.close(() => {
                    setupDiscoveryService()
                })
            } else {
                setupDiscoveryService()
            }
        }, 5000)
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
            // 确保WebSocket服务器已启动
            setupWebSocket()
        })
    } else {
        // Windows客户端部分
        log('正在初始化Windows客户端...')
        
        // 先尝试关闭之前的服务器（如果存在）
        if (discoveryServer) {
            try {
                discoveryServer.close()
            } catch (error) {
                logError('关闭旧UDP服务器失败:', error)
            }
        }

        // 创建新的UDP服务器
        discoveryServer = dgram.createSocket({
            type: 'udp4',
            reuseAddr: true
        })

        discoveryServer.on('listening', () => {
            log('Windows UDP客户端已启动，端口:', discoveryServer.address().port)
            discoveryServer.setBroadcast(true)
            
            // 立即开始寻找服务器
            findServer()
        })

        discoveryServer.on('error', (error) => {
            logError('Windows UDP客户端错误:', error)
            mainWindow.webContents.send('connection-status', 'UDP客户端错误')
        })

        discoveryServer.bind(0, '0.0.0.0', () => {
            log('Windows UDP客户端绑定成功')
        })

        function findServer() {
            if (ws && ws.readyState === WebSocket.OPEN) {
                log('已连接到服务器，跳过搜索')
                return
            }
            
            log('开始搜索Mac服务器...')
            const message = Buffer.from('FIND_CLIPBOARD_SERVER')
            
            // 获取所有网络接口
            const interfaces = os.networkInterfaces()
            let broadcastsSent = 0
            
            for (const interfaceName of Object.keys(interfaces)) {
                const addresses = interfaces[interfaceName]
                for (const addr of addresses) {
                    if (addr.family === 'IPv4' && !addr.internal) {
                        // 计算广播地址
                        const broadcastAddr = addr.address.split('.')
                        broadcastAddr[3] = '255'
                        const broadcast = broadcastAddr.join('.')
                        
                        log(`正在通过接口 ${interfaceName} (${addr.address}) 发送广播到 ${broadcast}`)
                        
                        // 发送到特定广播地址
                        discoveryServer.send(message, 0, message.length, DISCOVERY_PORT, broadcast, (err) => {
                            if (err) {
                                logError(`发送广播到 ${broadcast} 失败:`, err)
                            } else {
                                broadcastsSent++
                                log(`成功发送广播到 ${broadcast}`)
                            }
                        })
                        
                        // 发送到全局广播地址
                        discoveryServer.send(message, 0, message.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
                            if (err) {
                                logError('发送全局广播失败:', err)
                            } else {
                                broadcastsSent++
                                log('成功发送全局广播')
                            }
                        })
                    }
                }
            }
            
            if (broadcastsSent === 0) {
                logError('没有找到可用的网络接口发送广播')
                mainWindow.webContents.send('connection-status', '未找到可用网络接口')
            }
        }

        // 每3秒尝试一次
        const searchInterval = setInterval(findServer, 3000)
        
        // 处理响应
        discoveryServer.on('message', (msg, rinfo) => {
            const serverIP = msg.toString()
            log('收到来自', rinfo.address, '的响应:', serverIP)
            
            if (!ws || ws.readyState !== WebSocket.OPEN) {
                if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(serverIP)) {
                    log('验证IP地址成功，尝试连接到:', serverIP)
                    connectToServer(serverIP)
                } else {
                    logError('收到无效的服务器IP地址:', serverIP)
                }
            }
        })

        // 清理函数
        app.on('before-quit', () => {
            log('正在清理UDP客户端...')
            clearInterval(searchInterval)
            if (discoveryServer) {
                discoveryServer.close(() => {
                    log('UDP客户端已关闭')
                })
            }
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

    const connectWithRetry = (retryCount = 0) => {
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
                
                // 如果不是主动关闭，尝试重连
                if (retryCount < 5) {
                    log(`将在5秒后进行第${retryCount + 1}次重连...`)
                    setTimeout(() => connectWithRetry(retryCount + 1), 5000)
                }
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
            
            // 如果失败，尝试重连
            if (retryCount < 5) {
                log(`将在5秒后进行第${retryCount + 1}次重连...`)
                setTimeout(() => connectWithRetry(retryCount + 1), 5000)
            }
        }
    }

    connectWithRetry()
}

// 添加全局变量来跟踪WebSocket服务器状态
let wss = null

function setupWebSocket() {
    const platform = os.platform()
    
    if (platform === 'darwin') {
        // Mac作为服务器
        try {
            // 如果已经有WebSocket服务器在运行，直接返回
            if (wss) {
                log('WebSocket服务器已经在运行')
                return
            }

            startWebSocketServer()
        } catch (error) {
            logError('启动WebSocket服务器失败:', error)
            mainWindow.webContents.send('connection-status', '服务器启动失败')
        }
    }
}

function startWebSocketServer() {
    try {
        wss = new WebSocket.Server({ port: PORT }, () => {
            log('WebSocket服务器启动成功，监听端口:', PORT)
            mainWindow.webContents.send('connection-status', '等待Windows客户端连接...')
        })
        
        wss.on('connection', (socket, req) => {
            ws = socket
            const clientIP = req.socket.remoteAddress.replace('::ffff:', '')
            log('新的客户端连接:', clientIP)
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
                    logError('处理消息错误:', error)
                }
            })
            
            socket.on('close', () => {
                log('客户端断开连接')
                mainWindow.webContents.send('connection-status', '连接已断开')
                ws = null
            })

            socket.on('error', (error) => {
                logError('WebSocket连接错误:', error)
                mainWindow.webContents.send('connection-status', '连接错误')
                ws = null
            })
        })

        wss.on('error', (error) => {
            logError('WebSocket服务器错误:', error)
            mainWindow.webContents.send('connection-status', '服务器错误')
            wss = null
        })

        // 添加关闭时的清理
        app.on('before-quit', () => {
            if (wss) {
                wss.close(() => {
                    log('WebSocket服务器已关闭')
                    wss = null
                })
            }
        })
    } catch (error) {
        logError('创建WebSocket服务器失败:', error)
        mainWindow.webContents.send('connection-status', '服务器启动失败')
        wss = null
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

// 添加调试窗口相关变量
let debugWindow = null

// 创建调试窗口
function createDebugWindow() {
    debugWindow = new BrowserWindow({
        width: 800,
        height: 600,
        title: '调试日志',
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    })

    // 加载调试页面
    debugWindow.loadFile('debug.html')

    debugWindow.on('closed', () => {
        debugWindow = null
    })
}

app.whenReady().then(() => {
    createWindow()
    createTray()
    if (process.platform === 'win32') {
        createDebugWindow()
    }
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