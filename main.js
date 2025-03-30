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

// 处理设备刷新请求
ipcMain.on('refresh-devices', (event) => {
    console.log('收到设备刷新请求');
    // 立即发送一次广播消息
    if (broadcastServer) {
        const deviceInfo = {
            name: app.getName(),
            ip: getLocalIP(), // 使用主要的本机IP
            status: 'online',
            lastSeen: Date.now(),
            sharedDir: store.get('sharedDir') || path.join(app.getPath('home'), 'SharedFiles')
        };
        
        // 发送广播消息
        const message = Buffer.from(JSON.stringify(deviceInfo));
        
        // 发送到标准的UDP广播地址
        broadcastServer.send(message, 0, message.length, 12345, '255.255.255.255', (err) => {
            if (err) console.error('Error sending broadcast to 255.255.255.255:', err);
        });
        
        console.log('已发送设备刷新广播');
    }
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
        
        // 创建到目标设备的连接
        const client = new (require('net').Socket)();
        
        // 重要：设置为二进制模式，防止数据损坏
        client.setNoDelay(true);
        client.setEncoding(null); // 确保使用二进制模式
        
        // 设置连接超时
        client.setTimeout(5000);
        
        // 标记客户端状态
        let isClientClosed = false;
        let headerSent = false;
        
        // 创建文件读取流
        const fileStream = fs.createReadStream(transfer.filePath, { 
            highWaterMark: 64 * 1024 // 64KB 缓冲区，优化传输性能
        });
        let transferredBytes = 0;
        let lastSpeedUpdate = Date.now();
        
        // 处理文件读取错误
        fileStream.on('error', (error) => {
            console.error(`文件读取错误: ${error.message}`);
            transfer.status = 'error';
            transfer.error = `文件读取错误: ${error.message}`;
            
            if (client && !isClientClosed) {
                isClientClosed = true;
                client.destroy();
            }
            
            // 通知渲染进程传输错误
            mainWindow.webContents.send('transfer-error', {
                id: transfer.id,
                error: error.message
            });
        });
        
        // 处理连接超时
        client.on('timeout', () => {
            console.error(`连接超时: ${transfer.targetDevice.ip}:3001`);
            transfer.status = 'error';
            transfer.error = '连接超时';
            fileStream.destroy();
            
            if (!isClientClosed) {
                isClientClosed = true;
                client.destroy();
            }
            
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
            
            if (!isClientClosed) {
                isClientClosed = true;
            }
            
            // 通知渲染进程传输错误
            mainWindow.webContents.send('transfer-error', {
                id: transfer.id,
                error: `无法连接到目标设备: ${error.message}`
            });
        });
        
        // 处理连接关闭
        client.on('close', () => {
            console.log(`连接关闭: ${transfer.targetDevice.ip}:3001`);
            isClientClosed = true;
            
            // 如果传输未完成且状态不是error或cancelled，则报告错误
            if (transfer.progress < 100 && 
                transfer.status !== 'error' && 
                transfer.status !== 'cancelled') {
                transfer.status = 'error';
                transfer.error = '连接意外关闭';
                
                // 通知渲染进程传输错误
                mainWindow.webContents.send('transfer-error', {
                    id: transfer.id,
                    error: '连接意外关闭，传输未完成'
                });
            }
            
            // 清理文件流
            fileStream.destroy();
        });
        
        client.connect(3001, transfer.targetDevice.ip);
        
        client.on('connect', () => {
            console.log(`已连接到设备: ${transfer.targetDevice.ip}:3001`);
            transfer.status = 'transferring';
            
            // 发送文件信息头
            const header = JSON.stringify({
                fileName: path.basename(transfer.filePath),
                fileSize,
                transferId: transfer.id
            }) + '\n';
            
            // 发送文本头信息
            client.write(header, 'utf8', () => {
                headerSent = true;
                
                // 文件数据流开始传输
                fileStream.on('data', (chunk) => {
                    if (transfer.status === 'cancelled' || isClientClosed) {
                        fileStream.destroy();
                        
                        if (!isClientClosed) {
                            isClientClosed = true;
                            client.destroy();
                        }
                        return;
                    }
                    
                    // 确保客户端连接可写
                    if (client.writable) {
                        // 使用drain事件处理背压 - 直接写入二进制数据
                        const canContinue = client.write(chunk);
                        
                        if (!canContinue) {
                            // 暂停文件流直到socket准备好接收更多数据
                            fileStream.pause();
                            
                            client.once('drain', () => {
                                // 当socket准备好时恢复文件流
                                if (!fileStream.destroyed) {
                                    fileStream.resume();
                                }
                            });
                        }
                        
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
                    } else if (!isClientClosed) {
                        // 如果客户端不可写但未关闭，中止传输
                        console.error('客户端连接不可写，中止传输');
                        transfer.status = 'error';
                        transfer.error = '连接中断';
                        fileStream.destroy();
                        
                        isClientClosed = true;
                        client.destroy();
                        
                        // 通知渲染进程传输错误
                        mainWindow.webContents.send('transfer-error', {
                            id: transfer.id,
                            error: '连接中断，传输失败'
                        });
                    }
                });
                
                fileStream.on('end', () => {
                    if (transfer.status !== 'cancelled' && transfer.status !== 'error') {
                        transfer.status = 'completed';
                        
                        // 通知渲染进程传输完成
                        mainWindow.webContents.send('transfer-completed', transfer.id);
                        
                        // 确保所有数据都被刷新后再关闭连接
                        if (client.writable && !isClientClosed) {
                            // 等待所有数据刷新后再关闭
                            setTimeout(() => {
                                isClientClosed = true;
                                client.end();
                            }, 500);
                        }
                    }
                });
            });
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
        // 增加缓冲区大小
        socket.setNoDelay(true);
        socket.setEncoding(null); // 确保使用二进制模式
        
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
        let fileProcessingActive = true;
        let headerBuffer = Buffer.alloc(0); // 用于累积头部信息
        let isHeaderReceived = false;
        
        // 设置超时
        socket.setTimeout(120000); // 120秒超时
        
        // 处理超时
        socket.on('timeout', () => {
            console.error(`接收文件连接超时，来源IP: ${clientIP}`);
            fileProcessingActive = false;
            
            if (fileStream) {
                fileStream.end();
            }
            
            socket.end();
        });
        
        // 处理数据
        socket.on('data', (data) => {
            if (!fileProcessingActive) return;
            
            try {
                // 如果头部信息还未接收完成
                if (!isHeaderReceived) {
                    // 将新数据追加到头部缓冲区
                    headerBuffer = Buffer.concat([headerBuffer, data]);
                    
                    // 尝试查找头部结束标记（换行符）
                    const headerEndIndex = headerBuffer.indexOf('\n');
                    
                    if (headerEndIndex !== -1) {
                        // 提取头部信息（UTF-8 文本）
                        const headerStr = headerBuffer.slice(0, headerEndIndex).toString('utf8');
                        try {
                            fileInfo = JSON.parse(headerStr);
                            console.log('收到文件信息:', fileInfo);
                            
                            // 创建保存文件的流
                            const saveFilePath = path.join(receiveDir, fileInfo.fileName);
                            
                            // 检查如果同名文件已存在，则添加时间戳
                            let finalFilePath = saveFilePath;
                            if (fs.existsSync(saveFilePath)) {
                                const ext = path.extname(fileInfo.fileName);
                                const baseName = path.basename(fileInfo.fileName, ext);
                                const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
                                finalFilePath = path.join(receiveDir, `${baseName}_${timestamp}${ext}`);
                                console.log(`文件已存在，使用新路径: ${finalFilePath}`);
                            }
                            
                            // 优化写入选项，提高性能和完整性
                            fileStream = fs.createWriteStream(finalFilePath, {
                                highWaterMark: 64 * 1024, // 64KB 写缓冲区
                                flags: 'wx' // 文件必须不存在
                            });
                            
                            // 处理文件流错误
                            fileStream.on('error', (err) => {
                                console.error(`文件写入错误: ${err.message}`);
                                fileProcessingActive = false;
                                
                                try {
                                    // 尝试删除部分写入的文件
                                    fs.unlinkSync(finalFilePath);
                                } catch (deleteErr) {
                                    console.error(`无法删除部分文件: ${deleteErr.message}`);
                                }
                                
                                socket.end();
                            });
                            
                            // 更新文件信息中的路径
                            fileInfo.filePath = finalFilePath;
                            
                            // 标记头部已接收
                            isHeaderReceived = true;
                            
                            // 处理头部后的数据作为文件内容（二进制数据）
                            const bodyData = headerBuffer.slice(headerEndIndex + 1);
                            if (bodyData.length > 0) {
                                fileStream.write(bodyData);
                                receivedBytes += bodyData.length;
                                
                                // 通知主窗口更新进度
                                if (mainWindow) {
                                    mainWindow.webContents.send('receive-progress', {
                                        fileName: path.basename(finalFilePath),
                                        progress: (receivedBytes / fileInfo.fileSize) * 100,
                                        receivedBytes,
                                        totalBytes: fileInfo.fileSize
                                    });
                                }
                            }
                            
                            // 清除头部缓冲区以释放内存
                            headerBuffer = null;
                            
                        } catch (jsonError) {
                            console.error('解析文件头部JSON信息错误:', jsonError);
                            fileProcessingActive = false;
                            socket.end();
                            return;
                        }
                    }
                } else {
                    // 头部已接收，直接处理文件数据
                    if (fileStream && fileStream.writable) {
                        // 使用drain事件处理背压
                        const canContinue = fileStream.write(data);
                        receivedBytes += data.length;
                        
                        if (!canContinue) {
                            // 如果文件流背压，暂停socket
                            socket.pause();
                            
                            fileStream.once('drain', () => {
                                // 文件流准备好继续，恢复socket
                                if (!socket.destroyed) {
                                    socket.resume();
                                }
                            });
                        }
                        
                        // 通知主窗口更新进度
                        if (mainWindow) {
                            mainWindow.webContents.send('receive-progress', {
                                fileName: path.basename(fileInfo.filePath),
                                progress: (receivedBytes / fileInfo.fileSize) * 100,
                                receivedBytes,
                                totalBytes: fileInfo.fileSize
                            });
                        }
                    } else {
                        // 文件流出错，结束socket
                        fileProcessingActive = false;
                        socket.end();
                    }
                }
            } catch (err) {
                console.error('处理接收数据时出错:', err);
                fileProcessingActive = false;
                
                if (fileStream) {
                    fileStream.end();
                }
                
                socket.end();
            }
        });
        
        // 处理连接关闭
        socket.on('close', () => {
            console.log('文件传输连接关闭');
            
            if (fileStream) {
                fileStream.end(() => {
                    // 检查文件是否完全接收
                    if (fileInfo && receivedBytes > 0) {
                        let isComplete = false;
                        
                        // 检查文件大小是否匹配或接近
                        try {
                            const stats = fs.statSync(fileInfo.filePath);
                            // 如果接收的字节数与文件信息中的大小接近（允许1%误差）
                            const sizeMatch = Math.abs(stats.size - fileInfo.fileSize) / fileInfo.fileSize < 0.01;
                            isComplete = sizeMatch || receivedBytes >= fileInfo.fileSize;
                            
                            console.log(`文件接收完成状态: ${isComplete}, 实际大小: ${stats.size}, 预期大小: ${fileInfo.fileSize}, 接收字节: ${receivedBytes}`);
                        } catch (err) {
                            console.error(`检查文件状态出错: ${err.message}`);
                            isComplete = false;
                        }
                        
                        if (isComplete) {
                            // 通知主窗口文件接收完成
                            if (mainWindow) {
                                mainWindow.webContents.send('receive-completed', {
                                    fileName: path.basename(fileInfo.filePath),
                                    filePath: fileInfo.filePath,
                                    fileSize: fileInfo.fileSize
                                });
                            }
                        } else {
                            console.log(`文件接收不完整: ${receivedBytes}/${fileInfo.fileSize} 字节`);
                            
                            // 尝试删除不完整文件
                            try {
                                fs.unlinkSync(fileInfo.filePath);
                                console.log(`已删除不完整文件: ${fileInfo.filePath}`);
                            } catch (err) {
                                console.error(`删除不完整文件出错: ${err.message}`);
                            }
                        }
                    }
                });
            }
        });
        
        // 处理错误
        socket.on('error', (error) => {
            console.error('文件传输连接错误:', error);
            fileProcessingActive = false;
            
            if (fileStream) {
                fileStream.end();
                
                // 尝试删除不完整文件
                if (fileInfo && fileInfo.filePath) {
                    try {
                        fs.unlinkSync(fileInfo.filePath);
                        console.log(`已删除不完整文件: ${fileInfo.filePath}`);
                    } catch (err) {
                        console.error(`删除不完整文件出错: ${err.message}`);
                    }
                }
            }
        });
    });
    
    // 监听错误
    fileReceiveServer.on('error', (error) => {
        console.error('文件接收服务器错误:', error);
        
        // 尝试重启服务器
        setTimeout(() => {
            try {
                if (fileReceiveServer) {
                    fileReceiveServer.close();
                }
                
                console.log('尝试重启文件接收服务器...');
                initFileReceiveServer();
            } catch (restartError) {
                console.error('重启文件接收服务器失败:', restartError);
            }
        }, 5000);
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