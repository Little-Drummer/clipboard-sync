const { app, BrowserWindow, clipboard, ipcMain } = require('electron')
const path = require('path')
const WebSocket = require('ws')
const os = require('os')

let mainWindow
let ws
const PORT = 3000

const createWindow = () => {
    mainWindow = new BrowserWindow({
        width: 800,
        height: 600,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            webSecurity: true
        }
    })

    // 开发时打开开发者工具，方便调试
    mainWindow.webContents.openDevTools()

    mainWindow.loadFile('index.html')
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
                const text = message.toString()
                clipboard.writeText(text)
                mainWindow.webContents.send('clipboard-updated', text)
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
        })
        
        ws.on('message', (message) => {
            const text = message.toString()
            clipboard.writeText(text)
            mainWindow.webContents.send('clipboard-updated', text)
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
    setupWebSocket()

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow()
        }
    })
})

// 处理从渲染进程发来的剪贴板更新请求
ipcMain.on('update-clipboard', (event, text) => {
    clipboard.writeText(text)
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(text)
    }
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit()
    }
})