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

// 状态管理
let devices = new Map();
let files = [];
let transfers = new Map();

// 设备发现处理
ipcRenderer.on('device-discovered', (event, deviceInfo) => {
    devices.set(deviceInfo.ip, deviceInfo);
    updateDeviceList();
});

// 更新设备列表
function updateDeviceList() {
    deviceList.innerHTML = Array.from(devices.values())
        .map(device => `
            <div class="device-item" data-ip="${device.ip}">
                <div class="device-status ${device.status === 'online' ? 'status-online' : 'status-offline'}"></div>
                <div class="device-info">
                    <div class="device-name">${device.name}</div>
                    <div class="device-ip">${device.ip}</div>
                </div>
            </div>
        `).join('');
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

    fileList.innerHTML = filteredFiles.map(file => `
        <div class="file-item">
            <div class="col-name">
                <span class="file-icon">${file.isDirectory ? '📁' : '📄'}</span>
                ${file.name}
            </div>
            <div class="col-size">${formatFileSize(file.size)}</div>
            <div class="col-date">${formatDate(file.modified)}</div>
            <div class="col-actions">
                <button class="btn" onclick="shareFile('${file.path}')">分享</button>
            </div>
        </div>
    `).join('');
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
function shareFile(filePath) {
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

// 初始化
document.addEventListener('DOMContentLoaded', () => {
    // 加载已保存的共享目录
    const savedDir = localStorage.getItem('sharedDir');
    if (savedDir) {
        loadFiles(savedDir);
    }
}); 