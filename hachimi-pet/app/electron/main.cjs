const { app, BrowserWindow, Tray, Menu, dialog, globalShortcut, ipcMain, nativeImage, screen, shell } = require('electron');
const path = require('node:path');
const zlib = require('node:zlib');
const { createBridgeServer, DEFAULT_PORT } = require('./bridge-server.cjs');

const isDev = process.argv.includes('--dev');
const FORWARD_MOVES = process.platform !== 'win32';

// Ensure single instance (important when launched via Antigravity Sidecar + manual shortcut)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

/** @type {BrowserWindow | null} */
let mainWin = null;
/** @type {Tray | null} */
let tray = null;
let clickThroughLocked = false;
let bridge = null;

// Mouse capture lease state (inspired by Coopanion's mouse-lease.cjs)
let wantedCapture = false;
let leaseExpiresAt = 0;
let appliedIgnore = null;

function applyMouseState() {
  if (!mainWin || mainWin.isDestroyed()) return;
  const now = Date.now();
  const shouldCapture = !clickThroughLocked && wantedCapture && now < leaseExpiresAt && mainWin.isVisible();
  const shouldIgnore = !shouldCapture;
  if (appliedIgnore === shouldIgnore) return;
  appliedIgnore = shouldIgnore;
  if (shouldIgnore) {
    mainWin.setIgnoreMouseEvents(true, FORWARD_MOVES ? { forward: true } : undefined);
  } else {
    mainWin.setIgnoreMouseEvents(false);
  }
}

/**
 * Compute work-area bounds leaving a 2px safety margin from full monitor bounds
 * so Windows DWM never classifies the transparent overlay as a fullscreen exclusive app.
 */
function getOverlayBounds() {
  const disp = screen.getPrimaryDisplay();
  const wa = disp.workArea;
  const b = disp.bounds;
  let { x, y, width, height } = wa;
  if (x === b.x && y === b.y && width === b.width && height === b.height) {
    height = Math.max(200, height - 2);
  }
  return { x, y, width, height };
}

/**
 * Generate a clean 32x32 RGBA whale icon PNG in memory without external binary dependencies.
 */
function createWhaleTrayImage() {
  const W = 32, H = 32;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    const rowStart = y * (1 + W * 4);
    raw[rowStart] = 0; // filter: None
    for (let x = 0; x < W; x++) {
      const px = rowStart + 1 + x * 4;
      const dx = (x - 15.5) / 11.5;
      const dy = (y - 17.0) / 9.5;
      const inBody = dx * dx + dy * dy <= 1.0;
      const inTail = x >= 23 && x <= 30 && Math.abs(y - 15 - (x - 23) * 0.3) < 4.2;
      const inBelly = dx * dx + ((y - 20.5) / 5.5) ** 2 <= 0.72 && y >= 18 && x < 23;
      const inEye = (x - 10) ** 2 + (y - 15) ** 2 <= 3.2;

      if (inEye) {
        raw[px] = 20; raw[px + 1] = 30; raw[px + 2] = 60; raw[px + 3] = 255;
      } else if (inBelly) {
        raw[px] = 238; raw[px + 1] = 245; raw[px + 2] = 255; raw[px + 3] = 255;
      } else if (inBody || inTail) {
        raw[px] = 77; raw[px + 1] = 115; raw[px + 2] = 254; raw[px + 3] = 255;
      } else {
        raw[px] = 0; raw[px + 1] = 0; raw[px + 2] = 0; raw[px + 3] = 0;
      }
    }
  }

  function pngChunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crcBuf = Buffer.concat([t, data]);
    let crc = 0xffffffff;
    for (let i = 0; i < crcBuf.length; i++) {
      crc ^= crcBuf[i];
      for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const crcOut = Buffer.alloc(4);
    crcOut.writeUInt32BE((crc ^ 0xffffffff) >>> 0, 0);
    return Buffer.concat([len, t, data, crcOut]);
  }

  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const idat = zlib.deflateSync(raw);
  const png = Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))]);
  return nativeImage.createFromBuffer(png);
}

function createTrayIcon() {
  const candidates = [
    path.join(__dirname, '..', 'dist', 'coopanion', 'whale', 'thumbs', 'astral.png'),
    path.join(__dirname, '..', 'public', 'coopanion', 'whale', 'thumbs', 'astral.png'),
  ];
  for (const p of candidates) {
    try {
      const im = nativeImage.createFromPath(p);
      if (!im.isEmpty()) {
        return im.resize({ width: 32, height: 32, quality: 'best' });
      }
    } catch { /* fallback */ }
  }
  return createWhaleTrayImage();
}

function rebuildTrayMenu() {
  if (!tray) return;
  const s = bridge?.getSettings?.() || { scheme: 'astral', outfit: 'maid', roam: 'free', scale: 0.95, opacity: 1, soundOn: true };
  const schemes = [
    ['astral', '星瞳紫 (Astral · 原设)'],
    ['sakura', '樱桃粉 (Sakura)'],
    ['azure', '苍穹蓝 (Azure)'],
    ['emerald', '森灵翠 (Emerald)'],
    ['amber', '流光金 (Amber)'],
    ['crimson', '绯夜红 (Crimson)'],
    ['arctic', '霜月银 (Arctic)'],
    ['obsidian', '暗夜黑 (Obsidian)'],
  ];

  const menu = Menu.buildFromTemplate([
    {
      label: '📍 召唤回右下角',
      click: () => sendRendererCommand({ type: 'resetPosition' }),
    },
    {
      label: '📊 模型消耗与缓存统计',
      click: () => sendRendererCommand({ type: 'openStats' }),
    },
    {
      label: '🎨 切换哈基米配色',
      submenu: schemes.map(([id, label]) => ({
        label,
        type: 'radio',
        checked: s.scheme === id || (id === 'astral' && s.scheme === 'gemini'),
        click: () => {
          bridge?.updateSettings?.({ scheme: id, outfit: 'maid' });
          rebuildTrayMenu();
        },
      })),
    },
    {
      label: '📏 桌宠大小',
      submenu: [0.5, 0.6, 0.7, 0.8, 0.9, 0.95, 1, 1.1].map((scale) => ({
        label: `${Math.round(scale * 100)}%`,
        type: 'radio',
        checked: Math.abs((s.scale ?? 0.95) - scale) < 0.001,
        click: () => {
          bridge?.updateSettings?.({ scale });
          rebuildTrayMenu();
        },
      })),
    },
    {
      label: '👻 桌宠透明度',
      submenu: [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4].map((opacity) => ({
        label: opacity >= 0.999 ? '100% (不透明)' : `${Math.round(opacity * 100)}%`,
        type: 'radio',
        checked: Math.abs((s.opacity ?? 1) - opacity) < 0.001,
        click: () => {
          bridge?.updateSettings?.({ opacity });
          rebuildTrayMenu();
        },
      })),
    },
    {
      label: '🐱 子代理预览',
      submenu: [
        {
          label: '✨ 召唤测试子代理 (天降与淡出)',
          click: () => bridge?.spawnTestSubagent?.(),
        },
        {
          label: '🧹 清空当前子代理',
          click: () => bridge?.clearSubagents?.(),
        },
      ],
    },
    { type: 'separator' },
    {
      label: '🚶 允许自由散步',
      type: 'checkbox',
      checked: s.roam === 'free',
      click: (item) => {
        bridge?.updateSettings?.({ roam: item.checked ? 'free' : 'off' });
        rebuildTrayMenu();
      },
    },
    {
      label: '🔊 开启音效',
      type: 'checkbox',
      checked: s.soundOn !== false,
      click: (item) => {
        bridge?.updateSettings?.({ soundOn: item.checked });
        rebuildTrayMenu();
      },
    },
    {
      label: '🔒 鼠标完全穿透 (免打扰 · Alt+Shift+W)',
      type: 'checkbox',
      checked: clickThroughLocked,
      click: (item) => {
        clickThroughLocked = item.checked;
        appliedIgnore = null;
        applyMouseState();
        rebuildTrayMenu();
      },
    },
    { type: 'separator' },
    {
      label: '⬆️ 检测并更新',
      click: async () => {
        try {
          const checkRes = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/update/check`);
          const info = await checkRes.json();
          if (!checkRes.ok || !info.ok) {
            throw new Error(info.error || `HTTP ${checkRes.status}`);
          }
          if (!info.hasUpdate) {
            await dialog.showMessageBox({
              type: 'info',
              title: 'Hachimi Pet 检测更新',
              message: `当前已是最新版本 (v${info.currentVersion})`,
            });
            return;
          }
          const choice = await dialog.showMessageBox({
            type: 'question',
            buttons: ['立即更新', '取消'],
            defaultId: 0,
            cancelId: 1,
            title: '发现新版本',
            message: `发现新版本 v${info.latestVersion}（当前 v${info.currentVersion}）`,
            detail: info.notes ? info.notes.slice(0, 320) : '是否立即下载更新包并自动重启桌宠？',
          });
          if (choice.response !== 0) return;
          const applyRes = await fetch(`http://127.0.0.1:${DEFAULT_PORT}/api/update/apply`, { method: 'POST', body: '{}' });
          const applyData = await applyRes.json();
          if (!applyRes.ok || !applyData.ok) {
            throw new Error(applyData.error || `HTTP ${applyRes.status}`);
          }
        } catch (err) {
          await dialog.showMessageBox({
            type: 'error',
            title: 'Hachimi Pet 更新失败',
            message: err instanceof Error ? err.message : String(err),
          });
        }
      },
    },
    {
      label: '🚪 退出哈基米桌宠',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);
}

function sendRendererCommand(cmd) {
  if (!mainWin || mainWin.isDestroyed()) return;
  mainWin.webContents.send('petHost:command', cmd);
}

function createOverlayWindow() {
  const bounds = getOverlayBounds();
  mainWin = new BrowserWindow({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });

  mainWin.setAlwaysOnTop(true, 'screen-saver');
  mainWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Start in click-through mode until cursor enters pet or UI
  appliedIgnore = null;
  applyMouseState();

  if (isDev) {
    mainWin.loadURL('http://127.0.0.1:5179');
  } else {
    mainWin.loadURL(`http://127.0.0.1:${DEFAULT_PORT}/`);
  }

  // Explicitly call show() + showInactive() on load so Win32 STARTUPINFO SW_HIDE
  // inherited from headless sidecars/daemons never hides the first BrowserWindow!
  mainWin.webContents.once('did-finish-load', () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    mainWin.show();
    mainWin.showInactive();
    mainWin.setAlwaysOnTop(true, 'screen-saver');
    appliedIgnore = null;
    applyMouseState();
  });

  mainWin.webContents.on('console-message', (_ev, level, message, line, sourceId) => {
    bridge?.pushRendererLog?.({ level, message, line, sourceId, ts: Date.now() });
  });

  let overlayBounds = getOverlayBounds();
  const updateBounds = () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    overlayBounds = getOverlayBounds();
    mainWin.setBounds(overlayBounds);
  };
  screen.on('display-metrics-changed', updateBounds);
  screen.on('display-added', updateBounds);
  screen.on('display-removed', updateBounds);

  // Adaptive ~30Hz cursor hit-test loop for Windows click-through without starving main thread
  let lastX = -99999, lastY = -99999, lastSentAt = 0, lastTopmostAt = 0;
  const cursorTimer = setInterval(() => {
    if (!mainWin || mainWin.isDestroyed()) return;
    const now = Date.now();
    applyMouseState();
    // Re-assert topmost gently every 6s instead of modulo jitter
    if (now - lastTopmostAt > 6000) {
      lastTopmostAt = now;
      mainWin.setAlwaysOnTop(true, 'screen-saver');
    }

    const pt = screen.getCursorScreenPoint();
    const wb = overlayBounds;
    const rx = pt.x - wb.x;
    const ry = pt.y - wb.y;

    if (rx !== lastX || ry !== lastY || now - lastSentAt > 400) {
      lastX = rx;
      lastY = ry;
      lastSentAt = now;
      mainWin.webContents.send('petHost:cursor', {
        x: rx,
        y: ry,
        insideWindow: rx >= 0 && ry >= 0 && rx <= wb.width && ry <= wb.height,
        locked: clickThroughLocked,
      });
    }
  }, 33);

  mainWin.on('closed', () => {
    clearInterval(cursorTimer);
    mainWin = null;
  });
}

app.on('second-instance', () => {
  sendRendererCommand({ type: 'resetPosition' });
});

app.whenReady().then(async () => {
  bridge = createBridgeServer({
    port: DEFAULT_PORT,
    onShowPanel: () => {},
    onQuit: () => {
      app.isQuitting = true;
      app.quit();
    },
    onGetMouseState: () => ({
      clickThroughLocked,
      wantedCapture,
      ignoringMouseEvents: appliedIgnore,
      leaseRemainingMs: Math.max(0, leaseExpiresAt - Date.now()),
    }),
    onCheckPixels: async (box) => {
      if (!mainWin || mainWin.isDestroyed()) return null;
      const rx = Math.max(0, Math.floor(box.x));
      const ry = Math.max(0, Math.floor(box.y));
      const rw = Math.max(16, Math.min(320, Math.ceil(box.w)));
      const rh = Math.max(16, Math.min(320, Math.ceil(box.h)));
      const img = await Promise.race([
        mainWin.webContents.capturePage({ x: rx, y: ry, width: rw, height: rh }),
        new Promise((_, rej) => setTimeout(() => rej(new Error('capturePage timeout (transparent DWM idle)')), 900)),
      ]);
      const bmp = img.toBitmap(); // BGRA
      let visiblePixels = 0;
      for (let i = 3; i < bmp.length; i += 4) {
        if (bmp[i] > 16) visiblePixels++;
      }
      return { rect: { x: rx, y: ry, w: rw, h: rh }, totalPixels: bmp.length / 4, visiblePixels };
    },
  });
  await bridge.start();

  createOverlayWindow();

  tray = new Tray(createTrayIcon());
  tray.setToolTip('Hachimi Pet · Antigravity 哈基米伴侣 (右键托盘换色/设置)');
  tray.on('click', () => sendRendererCommand({ type: 'resetPosition' }));
  rebuildTrayMenu();

  // Register Alt+Shift+W emergency hotkey to toggle 100% click-through pass-through mode
  globalShortcut.register('Alt+Shift+W', () => {
    clickThroughLocked = !clickThroughLocked;
    wantedCapture = false;
    leaseExpiresAt = 0;
    appliedIgnore = null;
    applyMouseState();
    rebuildTrayMenu();
  });

  ipcMain.on('petHost:mouseCapture', (_ev, capture) => {
    wantedCapture = !!capture;
    if (wantedCapture) {
      leaseExpiresAt = Date.now() + 1600;
    } else {
      leaseExpiresAt = 0;
    }
    applyMouseState();
  });

  ipcMain.on('petHost:focusWindow', () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    wantedCapture = true;
    leaseExpiresAt = Date.now() + 5000;
    appliedIgnore = null;
    applyMouseState();
    mainWin.focus();
  });

  ipcMain.on('petHost:blurWindow', () => {
    if (!mainWin || mainWin.isDestroyed()) return;
    wantedCapture = false;
    leaseExpiresAt = 0;
    appliedIgnore = null;
    applyMouseState();
    mainWin.blur();
  });

  ipcMain.on('petHost:openExternal', (_ev, url) => {
    if (typeof url === 'string' && /^https?:\/\/|^file:\/\//i.test(url)) {
      shell.openExternal(url);
    }
  });

  ipcMain.on('petHost:quit', () => {
    app.isQuitting = true;
    app.quit();
  });

  ipcMain.handle('petHost:pickDirectory', async () => {
    wantedCapture = true;
    leaseExpiresAt = Date.now() + 60000;
    appliedIgnore = null;
    applyMouseState();
    const res = await dialog.showOpenDialog(mainWin || undefined, {
      title: '选择项目文件夹 (Project Workspace)',
      properties: ['openDirectory'],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) {
      return null;
    }
    return res.filePaths[0];
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  bridge?.close();
});
