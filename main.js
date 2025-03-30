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
let httpServer;
let broadcastServer;
let fileReceiveServer;
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
    
    httpServer = expressApp.listen(3000, () => {
        console.log('Express server running on port 3000');
    });
}

// 获取本机所有 IP 地址
function getAllLocalIPs() {
    const interfaces = require('os').networkInterfaces();
    const allIPs = [];
    
    for (const name of Object.keys(interfaces)) {
        for (const interface of interfaces[name]) {
            // 只考虑IPv4地址，排除回环地址
            if (interface.family === 'IPv4' && !interface.internal) {
                allIPs.push(interface.address);
            }
        }
    }
    
    // 始终包含本地回环地址
    allIPs.push('127.0.0.1');
    allIPs.push('localhost');
    
    return allIPs;
}

// 获取主要的本机 IP 地址 (兼容旧代码)
function getLocalIP() {
    const allIPs = getAllLocalIPs();
    return allIPs.length > 0 ? allIPs[0] : '127.0.0.1';
}

// 检查IP是否是本机IP
function isLocalIP(ip) {
    const allLocalIPs = getAllLocalIPs();
    return allLocalIPs.includes(ip);
}

// 初始化 UDP 广播服务
function initBroadcastServer() {
    // 创建 UDP socket
    broadcastServer = dgram.createSocket('udp4');
    
    // 获取本机所有IP和子网信息
    const interfaces = require('os').networkInterfaces();
    const localIPs = getAllLocalIPs();
    
    // 打印所有网络接口信息以便调试
    console.log('所有网络接口信息:');
    for (const name of Object.keys(interfaces)) {
        console.log(`接口 ${name}:`);
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4') {
                console.log(`  地址: ${iface.address}, 掩码: ${iface.netmask}, 内部: ${iface.internal}`);
            }
        }
    }
    
    console.log('本机所有IP:', localIPs);
    
    // 监听消息
    broadcastServer.on('message', (msg, rinfo) => {
        try {
            const deviceInfo = JSON.parse(msg.toString());
            // 添加设备IP和最后在线时间
            deviceInfo.ip = rinfo.address;
            deviceInfo.lastSeen = Date.now();
            
            // 检查是否是本机设备（过滤掉自己）
            if (isLocalIP(deviceInfo.ip)) {
                console.log('收到本机广播，已忽略', deviceInfo.ip);
                return;
            }
            
            console.log(`接收到来自 ${deviceInfo.ip} 的设备信息: ${deviceInfo.name}`);
            // 通知渲染进程发现新设备
            mainWindow.webContents.send('device-discovered', deviceInfo);
        } catch (error) {
            console.error('Error parsing device info:', error);
        }
    });
    
    // 设置服务器选项
    broadcastServer.on('listening', () => {
        // 设置广播选项
        broadcastServer.setBroadcast(true);
        const address = broadcastServer.address();
        console.log(`UDP服务器监听 ${address.address}:${address.port}`);
    });
    
    // 绑定端口
    broadcastServer.bind(12345, () => {
        console.log('UDP broadcast server initialized on port 12345');
    });
    
    // 定期广播本机信息到多个地址
    setInterval(() => {
        const deviceInfo = {
            name: app.getName(),
            ip: localIPs[0], // 使用主要的本机IP
            status: 'online',
            lastSeen: Date.now(),
            sharedDir: store.get('sharedDir') || path.join(app.getPath('home'), 'SharedFiles')
        };
        
        // 发送广播消息
        const message = Buffer.from(JSON.stringify(deviceInfo));
        
        // 1. 发送到标准的UDP广播地址
        broadcastServer.send(message, 0, message.length, 12345, '255.255.255.255', (err) => {
            if (err) console.error('Error sending broadcast to 255.255.255.255:', err);
        });
        
        // 2. 发送到之前使用的组播地址
        broadcastServer.send(message, 0, message.length, 12345, '224.0.0.114', (err) => {
            if (err) console.error('Error sending multicast to 224.0.0.114:', err);
        });
        
        // 3. 针对每个网络接口发送子网广播
        for (const name of Object.keys(interfaces)) {
            for (const iface of interfaces[name]) {
                // 只处理IPv4且非内部接口
                if (iface.family === 'IPv4' && !iface.internal) {
                    // 计算广播地址
                    const netmask = iface.netmask;
                    const ipAddress = iface.address;
                    const broadcastAddress = calculateBroadcastAddress(ipAddress, netmask);
                    
                    if (broadcastAddress) {
                        console.log(`发送广播到子网: ${broadcastAddress} (来自 ${ipAddress})`);
                        broadcastServer.send(message, 0, message.length, 12345, broadcastAddress, (err) => {
                            if (err) console.error(`Error sending broadcast to ${broadcastAddress}:`, err);
                        });
                    }
                }
            }
        }
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

// 计算广播地址
function calculateBroadcastAddress(ip, netmask) {
    try {
        const ipParts = ip.split('.').map(Number);
        const maskParts = netmask.split('.').map(Number);
        
        if (ipParts.length !== 4 || maskParts.length !== 4) {
            return null;
        }
        
        const broadcastParts = ipParts.map((part, index) => {
            return (part & maskParts[index]) | (~maskParts[index] & 255);
        });
        
        return broadcastParts.join('.');
    } catch (error) {
        console.error('计算广播地址时出错:', error);
        return null;
    }
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

// 检查设备是否在线并可连接
async function checkDeviceConnectivity(ip, port, timeout = 3000) {
    return new Promise((resolve) => {
        const socket = new (require('net').Socket)();
        let isResolved = false;
        
        // 设置连接超时
        socket.setTimeout(timeout);
        
        socket.on('connect', () => {
            isResolved = true;
            socket.destroy();
            resolve(true);
        });
        
        socket.on('timeout', () => {
            if (!isResolved) {
                socket.destroy();
                resolve(false);
            }
        });
        
        socket.on('error', () => {
            if (!isResolved) {
                socket.destroy();
                resolve(false);
            }
        });
        
        // 尝试连接
        socket.connect(port, ip);
    });
}

// 处理文件传输请求
ipcMain.handle('start-transfer', async (event, { filePath, targetDevice }) => {
    // 检查目标设备是否是本机
    if (isLocalIP(targetDevice.ip)) {
        console.error(`尝试向自己发送文件 (${targetDevice.ip})`);
        return { 
            error: '不能向自己发送文件。请选择其他设备作为目标。', 
            code: 'SELF_TRANSFER' 
        };
    }
    
    // 修正文件路径，确保正确的路径分隔符
    let correctedFilePath = filePath;
    
    // Windows 路径修正
    if (process.platform === 'win32') {
        // 检查路径是否缺少分隔符
        if (filePath.match(/^[A-Z]:(?![\\\/])/)) {
            // 在驱动器号后添加分隔符
            correctedFilePath = filePath.replace(/^([A-Z]:)/, '$1\\');
        }
        
        // 将所有正斜杠替换为反斜杠
        correctedFilePath = correctedFilePath.replace(/\//g, '\\');
        
        // 修复可能的连续分隔符
        correctedFilePath = correctedFilePath.replace(/\\{2,}/g, '\\');
    }
    
    console.log(`原始路径: ${filePath}`);
    console.log(`修正路径: ${correctedFilePath}`);
    
    // 检查文件是否存在
    try {
        fs.accessSync(correctedFilePath, fs.constants.F_OK);
    } catch (err) {
        console.error(`文件不存在: ${correctedFilePath}`);
        return { error: `文件不存在: ${correctedFilePath}`, code: 'ENOENT' };
    }
    
    // 检查目标设备是否可连接
    console.log(`检查设备连接: ${targetDevice.ip}:3001`);
    const isConnectable = await checkDeviceConnectivity(targetDevice.ip, 3001);
    if (!isConnectable) {
        console.error(`无法连接到设备: ${targetDevice.ip}:3001`);
        return { 
            error: `无法连接到设备 ${targetDevice.name} (${targetDevice.ip})。请确保目标设备在线且接收服务已启动。`, 
            code: 'ECONNREFUSED' 
        };
    }
    
    const transferId = Date.now().toString();
    const transfer = {
        id: transferId,
        filePath: correctedFilePath,
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
    try {
        // 检查文件是否存在并可读
        fs.accessSync(transfer.filePath, fs.constants.R_OK);
        const stats = fs.statSync(transfer.filePath);
        const fileSize = stats.size;
        
        // 创建文件读取流
        const fileStream = fs.createReadStream(transfer.filePath);
        let transferredBytes = 0;
        let lastSpeedUpdate = Date.now();
        
        // 处理文件读取错误
        fileStream.on('error', (error) => {
            console.error(`文件读取错误: ${error.message}`);
            transfer.status = 'error';
            transfer.error = `文件读取错误: ${error.message}`;
            
            if (client && !client.destroyed) {
                client.destroy();
            }
            
            // 通知渲染进程传输错误
            mainWindow.webContents.send('transfer-error', {
                id: transfer.id,
                error: error.message
            });
        });
        
        // 创建到目标设备的连接
        const client = new (require('net').Socket)();
        
        // 设置连接超时
        client.setTimeout(5000);
        
        // 处理连接超时
        client.on('timeout', () => {
            console.error(`连接超时: ${transfer.targetDevice.ip}:3001`);
            transfer.status = 'error';
            transfer.error = '连接超时';
            fileStream.destroy();
            client.destroy();
            
            // 通知渲染进程传输错误
            mainWindow.webContents.send('transfer-error', {
                id: transfer.id,
                error: '连接超时，请检查目标设备是否在线'
            });
        });
        
        // 处理连接错误
        client.on('error', (error) => {
            console.error(`连接错误: ${error.message}`);
            transfer.status = 'error';
            transfer.error = `连接错误: ${error.message}`;
            fileStream.destroy();
            
            // 通知渲染进程传输错误
            mainWindow.webContents.send('transfer-error', {
                id: transfer.id,
                error: `无法连接到目标设备: ${error.message}`
            });
        });
        
        client.connect(3001, transfer.targetDevice.ip);
        
        client.on('connect', () => {
            console.log(`已连接到设备: ${transfer.targetDevice.ip}:3001`);
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
            
            // 确保客户端连接可写
            if (client.writable) {
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
            }
        });
        
        fileStream.on('end', () => {
            transfer.status = 'completed';
            if (client.writable) {
                client.end();
            }
            // 通知渲染进程传输完成
            mainWindow.webContents.send('transfer-completed', transfer.id);
        });
    } catch (error) {
        console.error(`文件传输初始化错误: ${error.message}`);
        transfer.status = 'error';
        transfer.error = error.message;
        
        // 通知渲染进程传输错误
        mainWindow.webContents.send('transfer-error', {
            id: transfer.id,
            error: error.message
        });
    }
}

// 初始化文件接收服务器
function initFileReceiveServer() {
    const net = require('net');
    const path = require('path');
    const fs = require('fs');
    
    // 创建接收文件的目录
    const receiveDir = store.get('receiveDir') || path.join(app.getPath('downloads'), 'LinkyReceived');
    if (!fs.existsSync(receiveDir)) {
        fs.mkdirSync(receiveDir, { recursive: true });
    }
    
    // 创建TCP服务器
    fileReceiveServer = net.createServer((socket) => {
        // 获取客户端IP
        const clientIP = socket.remoteAddress.replace(/^::ffff:/, ''); // 移除IPv6前缀
        console.log(`新的文件传输连接，来源IP: ${clientIP}`);
        
        // 检查是否是来自本机的连接
        if (isLocalIP(clientIP)) {
            console.log(`拒绝来自本机的连接 (${clientIP})`);
            socket.end();
            return;
        }
        
        let fileInfo = null;
        let fileStream = null;
        let receivedBytes = 0;
        
        // 处理数据
        socket.on('data', (data) => {
            // 如果还没有收到文件信息，尝试解析文件信息
            if (!fileInfo) {
                try {
                    // 尝试从数据中解析出JSON信息和文件内容
                    const dataStr = data.toString();
                    const newlineIndex = dataStr.indexOf('\n');
                    
                    if (newlineIndex !== -1) {
                        // 提取JSON信息
                        const jsonStr = dataStr.substring(0, newlineIndex);
                        fileInfo = JSON.parse(jsonStr);
                        
                        console.log('收到文件信息:', fileInfo);
                        
                        // 创建保存文件的流
                        const saveFilePath = path.join(receiveDir, fileInfo.fileName);
                        fileStream = fs.createWriteStream(saveFilePath);
                        
                        // 处理剩余的数据作为文件内容
                        const remainingData = data.slice(newlineIndex + 1);
                        if (remainingData.length > 0) {
                            fileStream.write(remainingData);
                            receivedBytes += remainingData.length;
                            
                            // 通知主窗口更新进度
                            if (mainWindow) {
                                mainWindow.webContents.send('receive-progress', {
                                    fileName: fileInfo.fileName,
                                    progress: (receivedBytes / fileInfo.fileSize) * 100,
                                    receivedBytes,
                                    totalBytes: fileInfo.fileSize
                                });
                            }
                        }
                    }
                } catch (error) {
                    console.error('解析文件信息错误:', error);
                }
            } else {
                // 继续接收文件内容
                fileStream.write(data);
                receivedBytes += data.length;
                
                // 通知主窗口更新进度
                if (mainWindow) {
                    mainWindow.webContents.send('receive-progress', {
                        fileName: fileInfo.fileName,
                        progress: (receivedBytes / fileInfo.fileSize) * 100,
                        receivedBytes,
                        totalBytes: fileInfo.fileSize
                    });
                }
            }
        });
        
        // 处理连接关闭
        socket.on('close', () => {
            console.log('文件传输连接关闭');
            if (fileStream) {
                fileStream.end();
                
                // 通知主窗口文件接收完成
                if (mainWindow && fileInfo) {
                    mainWindow.webContents.send('receive-completed', {
                        fileName: fileInfo.fileName,
                        filePath: path.join(receiveDir, fileInfo.fileName),
                        fileSize: fileInfo.fileSize
                    });
                }
            }
        });
        
        // 处理错误
        socket.on('error', (error) => {
            console.error('文件传输连接错误:', error);
            if (fileStream) {
                fileStream.end();
            }
        });
    });
    
    // 监听错误
    fileReceiveServer.on('error', (error) => {
        console.error('文件接收服务器错误:', error);
    });
    
    // 开始监听
    fileReceiveServer.listen(3001, () => {
        console.log('文件接收服务器运行在端口 3001');
    });
}

// 应用启动
app.whenReady().then(() => {
    createWindow();
    
    // 等待主窗口创建完成后发送本机IP列表
    mainWindow.webContents.on('did-finish-load', () => {
        const localIPs = getAllLocalIPs();
        console.log('向渲染进程发送本机IP列表:', localIPs);
        mainWindow.webContents.send('local-ips', localIPs);
    });
    
    initExpressServer();
    initBroadcastServer();
    initFileReceiveServer();
    
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
    if (httpServer) {
        httpServer.close();
    }
    if (fileReceiveServer) {
        fileReceiveServer.close();
    }
}); 