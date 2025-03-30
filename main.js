const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const express = require('express');
const dgram = require('dgram');
const Store = require('electron-store');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const upload = multer({ dest: 'uploads/' });
const store = new Store();

let mainWindow;
let expressApp;
let broadcastServer;
let transferTasks = new Map();

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1200,
        height: 800,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false
        }
    });

    mainWindow.loadFile('src/index.html');
    
    // 开发时打开开发者工具
    if (process.argv.includes('--debug')) {
        mainWindow.webContents.openDevTools();
    }
}

// 初始化 Express 服务器
function initExpressServer() {
    expressApp = express();
    expressApp.use(express.json());
    
    // 静态文件服务
    const sharedDir = store.get('sharedDir') || path.join(app.getPath('home'), 'SharedFiles');
    expressApp.use('/shared', express.static(sharedDir));
    
    // 文件上传接口
    expressApp.post('/upload', upload.single('file'), (req, res) => {
        if (!req.file) {
            return res.status(400).json({ error: '没有文件被上传' });
        }
        
        const fileInfo = {
            id: generateFileId(),
            originalName: req.file.originalname,
            path: req.file.path,
            size: req.file.size,
            mimeType: req.file.mimetype
        };
        
        // 通知渲染进程文件上传成功
        mainWindow.webContents.send('file-uploaded', fileInfo);
        res.json(fileInfo);
    });
    
    // 文件下载接口
    expressApp.get('/download/:fileId', (req, res) => {
        const fileId = req.params.fileId;
        const fileInfo = getFileInfo(fileId);
        
        if (!fileInfo) {
            return res.status(404).json({ error: '文件不存在' });
        }
        
        res.download(fileInfo.path, fileInfo.originalName);
    });
    
    // 获取文件列表接口
    expressApp.get('/files', (req, res) => {
        const sharedDir = store.get('sharedDir') || path.join(app.getPath('home'), 'SharedFiles');
        fs.readdir(sharedDir, (err, files) => {
            if (err) {
                return res.status(500).json({ error: '读取目录失败' });
            }
            
            const fileList = files.map(file => {
                const filePath = path.join(sharedDir, file);
                const stats = fs.statSync(filePath);
                return {
                    name: file,
                    path: filePath,
                    size: stats.size,
                    modified: stats.mtime,
                    isDirectory: stats.isDirectory()
                };
            });
            
            res.json(fileList);
        });
    });
    
    // 文件传输状态接口
    expressApp.get('/transfer/:transferId', (req, res) => {
        const transferId = req.params.transferId;
        const transfer = transferTasks.get(transferId);
        
        if (!transfer) {
            return res.status(404).json({ error: '传输任务不存在' });
        }
        
        res.json(transfer);
    });
    
    expressApp.listen(3000, () => {
        console.log('Express server running on port 3000');
    });
}

// 初始化 UDP 广播服务
function initBroadcastServer() {
    // 创建 UDP socket
    broadcastServer = dgram.createSocket('udp4');
    
    // 设置广播选项
    broadcastServer.setBroadcast(true);
    
    // 绑定端口
    broadcastServer.bind(12345, () => {
        // 加入广播组
        broadcastServer.addMembership('224.0.0.114');
    });
    
    // 监听消息
    broadcastServer.on('message', (msg, rinfo) => {
        try {
            const deviceInfo = JSON.parse(msg.toString());
            // 添加设备IP和最后在线时间
            deviceInfo.ip = rinfo.address;
            deviceInfo.lastSeen = Date.now();
            
            // 通知渲染进程发现新设备
            mainWindow.webContents.send('device-discovered', deviceInfo);
        } catch (error) {
            console.error('Error parsing device info:', error);
        }
    });
    
    // 定期广播本机信息
    setInterval(() => {
        const deviceInfo = {
            name: app.getName(),
            ip: getLocalIP(),
            status: 'online',
            lastSeen: Date.now(),
            sharedDir: store.get('sharedDir') || path.join(app.getPath('home'), 'SharedFiles')
        };
        
        // 发送广播消息
        const message = Buffer.from(JSON.stringify(deviceInfo));
        broadcastServer.send(message, 0, message.length, 12345, '224.0.0.114', (err) => {
            if (err) {
                console.error('Error sending broadcast:', err);
            }
        });
    }, 5000);
    
    // 定期清理离线设备
    setInterval(() => {
        const now = Date.now();
        const offlineThreshold = 15000; // 15秒无响应视为离线
        
        mainWindow.webContents.send('clean-offline-devices', {
            threshold: offlineThreshold,
            currentTime: now
        });
    }, 5000);
}

// 获取本机 IP 地址
function getLocalIP() {
    const interfaces = require('os').networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            if (interface.family === 'IPv4' && !interface.internal) {
                return interface.address;
            }
        }
    }
    return '127.0.0.1';
}

// 生成文件ID
function generateFileId() {
    return crypto.randomBytes(16).toString('hex');
}

// 获取文件信息
function getFileInfo(fileId) {
    const sharedDir = store.get('sharedDir') || path.join(app.getPath('home'), 'SharedFiles');
    const files = fs.readdirSync(sharedDir);
    
    for (const file of files) {
        const filePath = path.join(sharedDir, file);
        const stats = fs.statSync(filePath);
        const fileHash = crypto.createHash('md5')
            .update(filePath + stats.mtime.getTime())
            .digest('hex');
            
        if (fileHash === fileId) {
            return {
                id: fileId,
                originalName: file,
                path: filePath,
                size: stats.size,
                mimeType: require('mime-types').lookup(file)
            };
        }
    }
    
    return null;
}

// IPC 通信处理
ipcMain.handle('select-directory', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
        properties: ['openDirectory']
    });
    if (!result.canceled) {
        store.set('sharedDir', result.filePaths[0]);
        return result.filePaths[0];
    }
    return null;
});

// 处理文件传输请求
ipcMain.handle('start-transfer', async (event, { filePath, targetDevice }) => {
    const transferId = Date.now().toString();
    const transfer = {
        id: transferId,
        filePath,
        targetDevice,
        progress: 0,
        status: 'pending',
        startTime: Date.now(),
        speed: 0
    };
    
    transferTasks.set(transferId, transfer);
    
    // 开始传输
    startFileTransfer(transfer);
    
    return transferId;
});

// 处理传输取消请求
ipcMain.handle('cancel-transfer', (event, transferId) => {
    const transfer = transferTasks.get(transferId);
    if (transfer) {
        transfer.status = 'cancelled';
        transferTasks.delete(transferId);
        return true;
    }
    return false;
});

// 开始文件传输
function startFileTransfer(transfer) {
    const fileStream = fs.createReadStream(transfer.filePath);
    const fileSize = fs.statSync(transfer.filePath).size;
    let transferredBytes = 0;
    let lastSpeedUpdate = Date.now();
    
    // 创建到目标设备的连接
    const client = new (require('net').Socket)();
    client.connect(3001, transfer.targetDevice.ip);
    
    client.on('connect', () => {
        transfer.status = 'transferring';
        // 发送文件信息
        client.write(JSON.stringify({
            fileName: path.basename(transfer.filePath),
            fileSize,
            transferId: transfer.id
        }) + '\n');
    });
    
    fileStream.on('data', (chunk) => {
        if (transfer.status === 'cancelled') {
            fileStream.destroy();
            client.destroy();
            return;
        }
        
        client.write(chunk);
        transferredBytes += chunk.length;
        transfer.progress = (transferredBytes / fileSize) * 100;
        
        // 更新传输速度
        const now = Date.now();
        if (now - lastSpeedUpdate >= 1000) {
            transfer.speed = transferredBytes / ((now - transfer.startTime) / 1000);
            lastSpeedUpdate = now;
        }
        
        // 通知渲染进程更新进度
        mainWindow.webContents.send('transfer-progress', {
            id: transfer.id,
            progress: transfer.progress,
            speed: transfer.speed
        });
    });
    
    fileStream.on('end', () => {
        transfer.status = 'completed';
        client.end();
        // 通知渲染进程传输完成
        mainWindow.webContents.send('transfer-completed', transfer.id);
    });
    
    fileStream.on('error', (error) => {
        transfer.status = 'error';
        transfer.error = error.message;
        client.destroy();
        // 通知渲染进程传输错误
        mainWindow.webContents.send('transfer-error', {
            id: transfer.id,
            error: error.message
        });
    });
}

// 应用启动
app.whenReady().then(() => {
    createWindow();
    initExpressServer();
    initBroadcastServer();
    
    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

// 应用退出时清理资源
app.on('before-quit', () => {
    if (broadcastServer) {
        broadcastServer.close();
    }
    if (expressApp) {
        expressApp.close();
    }
}); 