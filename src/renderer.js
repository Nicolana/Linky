const { ipcRenderer } = require('electron');
const path = require('path');
const fs = require('fs');

// DOM 元素
const deviceList = document.getElementById('deviceList');
const fileList = document.getElementById('fileList');
const searchInput = document.getElementById('searchInput');
const selectDirBtn = document.getElementById('selectDir');
const transferWindow = document.getElementById('transferWindow');
const transferList = document.getElementById('transferList');
const networkSpeed = document.getElementById('networkSpeed');
const transferCount = document.getElementById('transferCount');
const receiveList = document.getElementById('receiveList');

// 状态管理
let devices = new Map();
let files = [];
let transfers = new Map();
let receives = new Map();
let selectedDeviceIp = null;
let localIPs = []; // 保存本机IP列表

// 接收本机IP列表
ipcRenderer.on('local-ips', (event, ips) => {
    console.log('收到本机IP列表:', ips);
    localIPs = ips;
});

// 检查IP是否为本机IP
function isLocalIP(ip) {
    return localIPs.includes(ip) || ip === '127.0.0.1' || ip === 'localhost';
}

// 设备发现处理
ipcRenderer.on('device-discovered', (event, deviceInfo) => {
    console.log('发现设备:', deviceInfo);
    
    // 检查是否是本机IP
    if (isLocalIP(deviceInfo.ip)) {
        console.log('忽略本机设备:', deviceInfo.ip);
        return;
    }
    
    // 更新设备信息
    devices.set(deviceInfo.ip, deviceInfo);
    updateDeviceList();
});

// 清理离线设备
ipcRenderer.on('clean-offline-devices', (event, { threshold, currentTime }) => {
    let hasChanges = false;
    
    // 遍历所有设备，移除超时的设备
    for (const [ip, device] of devices.entries()) {
        if (currentTime - device.lastSeen > threshold) {
            console.log(`设备离线: ${device.name} (${ip})`);
            devices.delete(ip);
            hasChanges = true;
            
            // 如果当前选中的设备离线了，清除选中状态
            if (selectedDeviceIp === ip) {
                selectedDeviceIp = null;
            }
        }
    }
    
    // 如果有设备被移除，更新设备列表
    if (hasChanges) {
        updateDeviceList();
    }
});

// 更新设备列表
function updateDeviceList() {
    deviceList.innerHTML = Array.from(devices.values())
        .map(device => `
            <div class="device-item ${device.ip === selectedDeviceIp ? 'selected' : ''}" data-ip="${device.ip}">
                <div class="device-status ${device.status === 'online' ? 'status-online' : 'status-offline'}"></div>
                <div class="device-info">
                    <div class="device-name">${device.name}</div>
                    <div class="device-ip">${device.ip}</div>
                </div>
            </div>
        `).join('');

    // 添加设备选择事件监听
    deviceList.querySelectorAll('.device-item').forEach(item => {
        item.addEventListener('click', () => {
            // 更新选中设备IP
            selectedDeviceIp = item.dataset.ip;
            // 移除其他设备的选中状态
            deviceList.querySelectorAll('.device-item').forEach(d => d.classList.remove('selected'));
            // 添加当前设备的选中状态
            item.classList.add('selected');
        });
    });
}

// 选择共享目录
selectDirBtn.addEventListener('click', async () => {
    const dirPath = await ipcRenderer.invoke('select-directory');
    if (dirPath) {
        loadFiles(dirPath);
    }
});

// 加载文件列表
function loadFiles(dirPath) {
    fs.readdir(dirPath, (err, items) => {
        if (err) {
            console.error('Error reading directory:', err);
            return;
        }

        files = items.map(item => {
            const fullPath = path.join(dirPath, item);
            const stats = fs.statSync(fullPath);
            return {
                name: item,
                path: fullPath,
                size: stats.size,
                modified: stats.mtime,
                isDirectory: stats.isDirectory()
            };
        });

        updateFileList();
    });
}

// 更新文件列表
function updateFileList() {
    const searchTerm = searchInput.value.toLowerCase();
    const filteredFiles = files.filter(file => 
        file.name.toLowerCase().includes(searchTerm)
    );

    fileList.innerHTML = filteredFiles.map((file, index) => `
        <div class="file-item" data-index="${index}">
            <div class="col-name">
                <span class="file-icon">${file.isDirectory ? '📁' : '📄'}</span>
                ${file.name}
            </div>
            <div class="col-size">${formatFileSize(file.size)}</div>
            <div class="col-date">${formatDate(file.modified)}</div>
            <div class="col-actions">
                <button class="btn share-btn" data-index="${index}">分享</button>
            </div>
        </div>
    `).join('');
    
    // 使用事件委托添加点击事件处理
    fileList.querySelectorAll('.share-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            const index = parseInt(e.target.dataset.index);
            const fileToShare = filteredFiles[index];
            shareFile(fileToShare.path);
        });
    });
}

// 文件搜索
searchInput.addEventListener('input', updateFileList);

// 格式化文件大小
function formatFileSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// 格式化日期
function formatDate(date) {
    return new Date(date).toLocaleString();
}

// 分享文件
async function shareFile(filePath) {
    console.log('准备分享文件:', filePath);
    
    // 确保文件路径格式正确（Windows 路径修正）
    if (process.platform === 'win32') {
        // 检查路径是否缺少分隔符
        if (filePath.match(/^[A-Z]:(?![\\\/])/)) {
            // 在驱动器号后添加分隔符
            filePath = filePath.replace(/^([A-Z]:)/, '$1\\');
            console.log('修正后的路径:', filePath);
        }
        
        // 确保使用反斜杠作为路径分隔符
        filePath = filePath.replace(/\//g, '\\');
        
        // 修复可能的连续分隔符
        filePath = filePath.replace(/\\{2,}/g, '\\');
    }
    
    // 检查文件是否存在
    try {
        fs.accessSync(filePath, fs.constants.F_OK);
        console.log('文件存在，开始传输');
    } catch (err) {
        console.error('文件不存在:', filePath, err);
        alert(`文件不存在: ${filePath}`);
        return;
    }
    
    // 获取选中的设备
    const selectedDevice = document.querySelector('.device-item.selected');
    if (!selectedDevice) {
        alert('请先选择一个目标设备');
        return;
    }

    const targetDevice = {
        ip: selectedDevice.dataset.ip,
        name: selectedDevice.querySelector('.device-name').textContent
    };
    
    console.log('传输目标设备:', targetDevice);
    
    // 检查是否正在向自己发送
    if (isLocalIP(targetDevice.ip)) {
        console.error('阻止向自己发送文件:', targetDevice.ip);
        alert('不能向自己发送文件。请选择其他设备作为目标。');
        return;
    }
    
    const transferId = Date.now().toString();
    const transfer = {
        id: transferId,
        filePath: filePath,
        progress: 0,
        status: 'pending'
    };

    transfers.set(transferId, transfer);
    updateTransferList();
    updateTransferCount();

    try {
        // 通知主进程开始传输
        const result = await ipcRenderer.invoke('start-transfer', {
            filePath,
            targetDevice
        });
        
        console.log('传输开始结果:', result);
        
        // 检查是否有错误
        if (result && result.error) {
            alert(`传输失败: ${result.error}`);
            transfers.delete(transferId);
            updateTransferList();
            updateTransferCount();
            return;
        }

        // 监听传输进度
        ipcRenderer.on('transfer-progress', (event, data) => {
            if (data.id === transferId) {
                transfer.progress = data.progress;
                updateTransferList();
            }
        });

        // 监听传输完成
        ipcRenderer.on('transfer-completed', (event, id) => {
            if (id === transferId) {
                transfer.status = 'completed';
                transfer.progress = 100;
                updateTransferList();
            }
        });

        // 监听传输错误
        ipcRenderer.on('transfer-error', (event, data) => {
            if (data.id === transferId) {
                transfer.status = 'error';
                alert(`传输失败: ${data.error}`);
                updateTransferList();
            }
        });

    } catch (error) {
        console.error('传输启动失败:', error);
        alert('传输启动失败，请重试');
        transfers.delete(transferId);
        updateTransferList();
        updateTransferCount();
    }
}

// 更新传输列表
function updateTransferList() {
    transferList.innerHTML = Array.from(transfers.values())
        .map(transfer => `
            <div class="transfer-item">
                <div class="transfer-info">
                    <div class="transfer-name">${path.basename(transfer.filePath)}</div>
                    <div class="transfer-progress">
                        <div class="progress-bar">
                            <div class="progress-bar-fill" style="width: ${transfer.progress}%"></div>
                        </div>
                        <span>${transfer.progress}%</span>
                    </div>
                </div>
                <div class="transfer-actions">
                    <button class="btn-icon" onclick="cancelTransfer('${transfer.id}')">×</button>
                </div>
            </div>
        `).join('');
}

// 更新传输计数
function updateTransferCount() {
    transferCount.textContent = transfers.size;
}

// 取消传输
function cancelTransfer(transferId) {
    transfers.delete(transferId);
    updateTransferList();
    updateTransferCount();
}

// 显示/隐藏传输窗口
document.querySelector('.close-btn').addEventListener('click', () => {
    transferWindow.classList.add('hidden');
});

// 更新网速显示
function updateNetworkSpeed(speed) {
    networkSpeed.textContent = `${formatFileSize(speed)}/s`;
}

// 监听文件接收进度
ipcRenderer.on('receive-progress', (event, data) => {
    // 更新或创建接收记录
    if (!receives.has(data.fileName)) {
        receives.set(data.fileName, {
            fileName: data.fileName,
            progress: data.progress,
            receivedBytes: data.receivedBytes,
            totalBytes: data.totalBytes,
            status: 'receiving'
        });
    } else {
        const receive = receives.get(data.fileName);
        receive.progress = data.progress;
        receive.receivedBytes = data.receivedBytes;
    }
    
    // 更新接收列表
    updateReceiveList();
    
    // 显示通知
    if (Notification.permission === 'granted' && data.progress === 0) {
        new Notification('正在接收文件', {
            body: `正在接收 ${data.fileName}`,
            icon: 'icon.png'
        });
    }
});

// 监听文件接收完成
ipcRenderer.on('receive-completed', (event, data) => {
    // 更新接收记录
    if (receives.has(data.fileName)) {
        const receive = receives.get(data.fileName);
        receive.status = 'completed';
        receive.progress = 100;
        receive.filePath = data.filePath;
        
        // 更新接收列表
        updateReceiveList();
        
        // 显示通知
        if (Notification.permission === 'granted') {
            const notification = new Notification('文件接收完成', {
                body: `${data.fileName} 已接收完成`,
                icon: 'icon.png'
            });
            
            // 点击通知打开文件
            notification.onclick = () => {
                const { shell } = require('electron');
                shell.showItemInFolder(data.filePath);
            };
        }
    }
});

// 更新接收列表
function updateReceiveList() {
    if (!receiveList) return; // 防止元素不存在
    
    receiveList.innerHTML = Array.from(receives.values())
        .map(receive => `
            <div class="receive-item">
                <div class="receive-info">
                    <div class="receive-name">${receive.fileName}</div>
                    <div class="receive-progress">
                        <div class="progress-bar">
                            <div class="progress-bar-fill" style="width: ${receive.progress}%"></div>
                        </div>
                        <span>${receive.progress.toFixed(1)}% - ${formatFileSize(receive.receivedBytes)} / ${formatFileSize(receive.totalBytes)}</span>
                    </div>
                </div>
                <div class="receive-actions">
                    ${receive.status === 'completed' ? 
                        `<button class="btn-icon" onclick="openReceivedFile('${receive.filePath}')">📂</button>` : 
                        ''}
                </div>
            </div>
        `).join('');
}

// 打开接收的文件
function openReceivedFile(filePath) {
    const { shell } = require('electron');
    shell.showItemInFolder(filePath);
}

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    // 加载已保存的共享目录
    const savedDir = localStorage.getItem('sharedDir');
    if (savedDir) {
        loadFiles(savedDir);
    }
    
    // 添加日志功能，用于调试
    window.logFilePath = (path) => {
        console.log(`文件路径: "${path}"`);
        console.log(`文件路径长度: ${path.length}`);
        console.log(`文件路径编码: ${encodeURIComponent(path)}`);
    };
    
    // 请求通知权限
    if (Notification.permission !== 'granted') {
        Notification.requestPermission();
    }
}); 