const { app, BrowserWindow, clipboard, ipcMain, Tray, Menu, nativeImage } = require('electron')
const path = require('path')
const WebSocket = require('ws')
const os = require('os')
const dgram = require('dgram')
require('fs');
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
    let finalMessage = `[${timestamp}] ${message}`
    if (args.length > 0) {
        const argsStr = args.map(arg => {
            if (typeof arg === 'object') {
                return JSON.stringify(arg, null, 2)
            }
            return String(arg)
        }).join(' ')
        finalMessage += ' ' + argsStr
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
    let finalMessage = `[${timestamp}] 错误: ${message}`
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

// 添加安全的消息发送函数
function sendToRenderer(channel, message) {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send(channel, message)
        }
    } catch (error) {
        logError('发送消息到渲染进程失败:', error)
    }
}

// 修改connectToServer函数
function connectToServer(serverIP) {
    log('尝试连接到服务器:', serverIP)
    
    let wsLocal = null
    let pingInterval = null
    let reconnectTimeout = null
    
    if (ws) {
        log('关闭现有连接')
        try {
            ws.terminate()
        } catch (error) {
            logError('关闭现有连接失败:', error)
        }
        ws = null
    }

    const connectWithRetry = (retryCount = 0, delay = 5000) => {
        try {
            log(`尝试第${retryCount + 1}次连接到 ${serverIP}...`)
            wsLocal = new WebSocket(`ws://${serverIP}:${PORT}`)
            ws = wsLocal
            
            // 设置连接超时
            const connectionTimeout = setTimeout(() => {
                if (wsLocal && wsLocal.readyState !== WebSocket.OPEN) {
                    log('连接超时，准备重试')
                    try {
                        wsLocal.terminate()
                    } catch (error) {
                        logError('关闭超时连接失败:', error)
                    }
                    ws = null
                    
                    // 使用指数退避策略
                    const nextDelay = Math.min(delay * 1.5, 30000) // 最大延迟30秒
                    if (retryCount < 10) { // 增加最大重试次数
                        reconnectTimeout = setTimeout(() => {
                            connectWithRetry(retryCount + 1, nextDelay)
                        }, nextDelay)
                    }
                }
            }, 10000) // 增加超时时间到10秒
            
            wsLocal.on('open', () => {
                try {
                    clearTimeout(connectionTimeout)
                    log('WebSocket连接已建立，等待服务器确认...')
                    sendToRenderer('connection-status', '正在等待服务器确认...')
                    
                    wsLocal.send(JSON.stringify({
                        type: 'connection_confirm',
                        content: 'windows_client'
                    }))
                } catch (error) {
                    logError('处理open事件错误:', error)
                }
            })
            
            wsLocal.on('message', (message) => handleWebSocketMessage(wsLocal, message))
            
            wsLocal.on('close', () => {
                try {
                    clearTimeout(connectionTimeout)
                    if (pingInterval) {
                        clearInterval(pingInterval)
                        pingInterval = null
                    }
                    log('WebSocket连接关闭')
                    sendToRenderer('connection-status', '连接已断开，正在重连...')
                    ws = null
                    
                    // 立即尝试重连
                    if (retryCount < 10) {
                        reconnectTimeout = setTimeout(() => {
                            connectWithRetry(retryCount + 1, delay)
                        }, delay)
                    }
                } catch (error) {
                    logError('处理close事件错误:', error)
                }
            })

            wsLocal.on('error', (error) => {
                try {
                    clearTimeout(connectionTimeout)
                    if (pingInterval) {
                        clearInterval(pingInterval)
                        pingInterval = null
                    }
                    logError('WebSocket错误:', error)
                    sendToRenderer('connection-status', '连接错误，正在重连...')
                    ws = null
                } catch (error) {
                    logError('处理error事件错误:', error)
                }
            })

            // 增加更频繁的心跳检测
            let missedPings = 0
            pingInterval = setInterval(() => {
                try {
                    if (wsLocal && wsLocal.readyState === WebSocket.OPEN) {
                        wsLocal.ping()
                        missedPings++
                        if (missedPings > 2) {
                            log('心跳超时，正在重新连接...')
                            clearInterval(pingInterval)
                            pingInterval = null
                            wsLocal.terminate()
                            ws = null
                            // 立即开始重连
                            connectWithRetry(0, 1000)
                        }
                    } else {
                        clearInterval(pingInterval)
                        pingInterval = null
                    }
                } catch (error) {
                    logError('发送心跳失败:', error)
                    clearInterval(pingInterval)
                    pingInterval = null
                    if (wsLocal) {
                        try {
                            wsLocal.terminate()
                        } catch (e) {
                            logError('关闭连接失败:', e)
                        }
                    }
                    ws = null
                    // 立即开始重连
                    connectWithRetry(0, 1000)
                }
            }, 15000) // 减少心跳间隔到15秒

            wsLocal.on('pong', () => {
                try {
                    log('收到服务器心跳响应')
                    missedPings = 0
                } catch (error) {
                    logError('处理pong事件错误:', error)
                }
            })
        } catch (error) {
            logError('创建WebSocket连接错误:', error)
            sendToRenderer('connection-status', '创建连接失败，正在重试...')
            ws = null
            
            // 发生错误时也尝试重连
            if (retryCount < 10) {
                reconnectTimeout = setTimeout(() => {
                    connectWithRetry(retryCount + 1, delay)
                }, delay)
            }
        }
    }

    // 清理之前的重连定时器
    if (reconnectTimeout) {
        clearTimeout(reconnectTimeout)
        reconnectTimeout = null
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

// 添加剪贴板监控相关变量
let lastText = ''
let lastImage = null
let isProcessing = false

// 添加图片比较函数
function compareImages(img1, img2) {
    if (!img1 || !img2) return false
    if (img1.isEmpty() && img2.isEmpty()) return true
    if (img1.isEmpty() !== img2.isEmpty()) return false
    return img1.toDataURL() === img2.toDataURL()
}

// 添加剪贴板检测函数
async function checkClipboard() {
    if (isProcessing) return
    isProcessing = true

    try {
        // 检查文本变化
        const newText = clipboard.readText()
        if (newText !== lastText && newText) {  // 只在有文本时发送
            lastText = newText
            log('检测到新的剪贴板文本:', newText)
            
            // 发送到连接的客户端
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'text',
                    content: newText
                }))
            }
            
            // 如果窗口存在，更新UI
            if (mainWindow && !mainWindow.isDestroyed()) {
                mainWindow.webContents.send('clipboard-updated', {
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
                const dataUrl = newImage.toDataURL()
                log('检测到新的剪贴板图片')
                
                if (dataUrl && dataUrl.startsWith('data:image/')) {
                    // 发送到连接的客户端
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'image',
                            content: dataUrl
                        }))
                    }
                    
                    // 如果窗口存在，更新UI
                    if (mainWindow && !mainWindow.isDestroyed()) {
                        mainWindow.webContents.send('clipboard-updated', {
                            type: 'image',
                            content: dataUrl
                        })
                    }
                }
            }
        }
    } catch (error) {
        logError('检查剪贴板错误:', error)
    } finally {
        isProcessing = false
    }
}

// 修改handleWebSocketMessage函数
function handleWebSocketMessage(socket, message) {
    try {
        const data = JSON.parse(message)
        log('收到消息:', data.type)
        
        if (data.type === 'connection_confirm') {
            const clientIP = socket._socket.remoteAddress.replace('::ffff:', '')
            log('收到客户端确认')
            // 确保这是当前活动的连接
            if (ws === socket && socket.readyState === WebSocket.OPEN) {
                sendToRenderer('connection-status', `已连接到客户端 (${clientIP})`)
            }
        } else if (data.type === 'text' && data.content) {
            lastText = data.content
            clipboard.writeText(data.content)
            sendToRenderer('clipboard-updated', data)
        } else if (data.type === 'image' && data.content) {
            try {
                const image = nativeImage.createFromDataURL(data.content)
                if (!image.isEmpty()) {
                    lastImage = image
                    clipboard.writeImage(image)
                    sendToRenderer('clipboard-updated', data)
                }
            } catch (error) {
                logError('处理接收的图片失败:', error)
            }
        }
    } catch (error) {
        logError('处理WebSocket消息失败:', error)
    }
}

function startWebSocketServer() {
    try {
        wss = new WebSocket.Server({ port: PORT }, () => {
            log('WebSocket服务器启动成功，监听端口:', PORT)
            sendToRenderer('connection-status', '等待Windows客户端连接...')
        })
        
        wss.on('connection', (socket, req) => {
            ws = socket
            const clientIP = req.socket.remoteAddress.replace('::ffff:', '')
            log('新的客户端连接:', clientIP)
            
            // 发送连接确认
            if (socket.readyState === WebSocket.OPEN) {
                socket.send(JSON.stringify({
                    type: 'connection_confirm',
                    content: 'mac_server'
                }))
                sendToRenderer('connection-status', `已连接到客户端 (${clientIP})`)
            }
            
            socket.on('message', (message) => handleWebSocketMessage(socket, message))
            
            // 服务器端也增加更频繁的心跳检测
            let missedPings = 0
            const pingInterval = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN) {
                    try {
                        socket.ping()
                        missedPings++
                        if (missedPings > 2) {
                            log('心跳超时，关闭连接')
                            clearInterval(pingInterval)
                            socket.terminate()
                            ws = null
                            sendToRenderer('connection-status', '等待客户端重新连接...')
                        }
                    } catch (error) {
                        logError('发送心跳失败:', error)
                        clearInterval(pingInterval)
                        if (socket) {
                            socket.terminate()
                            ws = null
                            sendToRenderer('connection-status', '等待客户端重新连接...')
                        }
                    }
                } else {
                    clearInterval(pingInterval)
                    if (ws === socket) {
                        ws = null
                        sendToRenderer('connection-status', '等待客户端重新连接...')
                    }
                }
            }, 15000)

            socket.on('pong', () => {
                log('收到客户端心跳响应')
                missedPings = 0
                // 确保连接状态正确显示
                if (ws === socket && socket.readyState === WebSocket.OPEN) {
                    sendToRenderer('connection-status', `已连接到客户端 (${clientIP})`)
                }
            })

            socket.on('error', (error) => {
                logError('WebSocket连接错误:', error)
                if (ws === socket) {
                    ws = null
                    sendToRenderer('connection-status', '连接错误')
                }
            })

            // 只注册一次close事件
            socket.on('close', () => {
                log('客户端断开连接')
                clearInterval(pingInterval)
                if (ws === socket) {
                    ws = null
                    sendToRenderer('connection-status', '等待客户端重新连接...')
                }
            })

            // 定期检查连接状态
            const statusCheckInterval = setInterval(() => {
                if (socket.readyState === WebSocket.OPEN && ws === socket) {
                    sendToRenderer('connection-status', `已连接到客户端 (${clientIP})`)
                } else if (ws === socket) {
                    ws = null
                    sendToRenderer('connection-status', '等待客户端重新连接...')
                }
                if (socket.readyState === WebSocket.CLOSED) {
                    clearInterval(statusCheckInterval)
                }
            }, 5000)
        })

        wss.on('error', (error) => {
            logError('WebSocket服务器错误:', error)
            sendToRenderer('connection-status', '服务器错误，正在重启...')
            
            if (wss) {
                try {
                    wss.close(() => {
                        setTimeout(() => {
                            startWebSocketServer()
                        }, 5000)
                    })
                } catch (e) {
                    logError('关闭WebSocket服务器失败:', e)
                }
            }
            wss = null
        })
    } catch (error) {
        logError('创建WebSocket服务器失败:', error)
        sendToRenderer('connection-status', '服务器启动失败，正在重试...')
        wss = null
        
        setTimeout(() => {
            startWebSocketServer()
        }, 5000)
    }
}

// 创建托盘图标
function createTray() {
    // 创建一个简单的图标
    const iconPath = process.platform === 'win32' ? 'windows-icon.ico' : 'icon.png'
    tray = new Tray(path.join(__dirname, iconPath))
    
    // 获取连接状态
    function getConnectionStatus() {
        try {
            if (!ws) return '未连接'
            switch (ws.readyState) {
                case WebSocket.CONNECTING:
                    return '正在连接...'
                case WebSocket.OPEN:
                    return '已连接'
                case WebSocket.CLOSING:
                    return '正在断开...'
                case WebSocket.CLOSED:
                    return '未连接'
                default:
                    return '未连接'
            }
        } catch (error) {
            logError('获取连接状态失败:', error)
            return '未连接'
        }
    }
    
    // 检查是否可以重新连接
    function canReconnect() {
        try {
            return !ws || ws.readyState === WebSocket.CLOSED
        } catch (error) {
            logError('检查重连状态失败:', error)
            return true
        }
    }
    
    function getContextMenu() {
        try {
            return Menu.buildFromTemplate([
                {
                    enabled: false,
                    label: getConnectionStatus()
                },
                { type: 'separator' },
                { 
                    label: '重新连接',
                    enabled: canReconnect(),
                    click: () => {
                        if (process.platform === 'win32') {
                            try {
                                // Windows端重新搜索服务器
                                if (discoveryServer) {
                                    const message = Buffer.from('FIND_CLIPBOARD_SERVER')
                                    discoveryServer.send(message, 0, message.length, DISCOVERY_PORT, '255.255.255.255', (err) => {
                                        if (err) {
                                            logError('发送广播失败:', err)
                                        } else {
                                            log('已发送重新连接请求')
                                        }
                                    })
                                } else {
                                    log('重新初始化发现服务')
                                    setupDiscoveryService()
                                }
                            } catch (error) {
                                logError('重新连接失败:', error)
                            }
                        }
                    }
                },
                { 
                    label: '显示主窗口', 
                    click: () => {
                        try {
                            if (mainWindow === null) {
                                createWindow()
                            } else {
                                mainWindow.show()
                            }
                        } catch (error) {
                            logError('显示主窗口失败:', error)
                        }
                    }
                },
                { type: 'separator' },
                { 
                    label: '退出', 
                    click: () => {
                        try {
                            app.isQuitting = true
                            app.quit()
                        } catch (error) {
                            logError('退出程序失败:', error)
                            process.exit(1)
                        }
                    }
                }
            ])
        } catch (error) {
            logError('创建托盘菜单失败:', error)
            return Menu.buildFromTemplate([
                { 
                    label: '错误',
                    enabled: false
                },
                { type: 'separator' },
                { 
                    label: '退出', 
                    click: () => process.exit(1)
                }
            ])
        }
    }
    
    // 设置初始菜单
    try {
        tray.setContextMenu(getContextMenu())
        
        // 定期更新菜单以反映最新状态
        const menuUpdateInterval = setInterval(() => {
            if (tray && !tray.isDestroyed()) {
                try {
                    tray.setContextMenu(getContextMenu())
                } catch (error) {
                    logError('更新托盘菜单失败:', error)
                }
            } else {
                clearInterval(menuUpdateInterval)
            }
        }, 1000)
        
        // 清理函数
        app.on('before-quit', () => {
            clearInterval(menuUpdateInterval)
        })
        
        tray.setToolTip('剪贴板同步工具')
        
        tray.on('click', () => {
            try {
                if (mainWindow === null) {
                    createWindow()
                } else {
                    mainWindow.show()
                }
            } catch (error) {
                logError('处理托盘点击事件失败:', error)
            }
        })
    } catch (error) {
        logError('初始化托盘失败:', error)
    }
}

const createWindow = () => {
    if (mainWindow !== null) {
        mainWindow.show()  // 如果窗口已存在，直接显示
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
    // 首先创建主窗口
    createWindow()
    
    // 启动剪贴板监控
    const clipboardCheckInterval = setInterval(checkClipboard, 500)
    
    // 等待主窗口创建完成
    setTimeout(() => {
        // 然后创建托盘图标
        createTray()
        
        // 最后设置网络服务
        setupWebSocket()
        setupDiscoveryService()
    }, 1000)

    // 修改 activate 事件处理
    app.on('activate', () => {
        if (mainWindow === null) {
            createWindow()
        } else {
            mainWindow.show()
        }
    })
    
    // 添加清理
    app.on('before-quit', () => {
        clearInterval(clipboardCheckInterval)
    })
})

// 修改ipcMain事件处理
ipcMain.on('update-clipboard', (event, data) => {
    try {
        // 更新lastText或lastImage以避免重复发送
        if (data.type === 'text') {
            lastText = data.content
        } else if (data.type === 'image') {
            const image = nativeImage.createFromDataURL(data.content)
            if (!image.isEmpty()) {
                lastImage = image
            }
        }
        
        // 发送到另一端
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(data))
        }

        // 更新本地剪贴板
        if (data.type === 'text' && data.content) {
            clipboard.writeText(data.content)
        } else if (data.type === 'image' && data.content) {
            try {
                const image = nativeImage.createFromDataURL(data.content)
                if (!image.isEmpty()) {
                    clipboard.writeImage(image)
                }
            } catch (error) {
                logError('处理图片数据失败:', error)
            }
        }
    } catch (error) {
        logError('更新剪贴板失败:', error)
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