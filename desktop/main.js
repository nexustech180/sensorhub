// Gold Var Sensor Hub - Windows app (Electron).
// Shows the same dashboard as the Android app (www/ is copied in by the build).
const { app, BrowserWindow, shell } = require('electron');
const path = require('path');

// "Open in app" links: goldvar://open opens this app, goldvar://live (db, settings, home) opens that page.
const SCHEME = 'goldvar';
const PAGES = ['home', 'live', 'db', 'settings'];
const pageFromArgs = argv => {
  const url = argv.find(a => a.toLowerCase().startsWith(SCHEME + '://'));
  const m = url && /^goldvar:\/\/\/?([a-z]*)/i.exec(url);
  const page = m && m[1].toLowerCase();
  return PAGES.includes(page) ? page : null;
};

function registerScheme() {
  if (!app.isPackaged) return;   // only the built .exe registers itself
  // The portable .exe unpacks to a temp folder on each start; register the real .exe instead.
  const exe = process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  app.setAsDefaultProtocolClient(SCHEME, exe, []);
}

function createWindow(page) {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 360,
    title: 'Gold Var Sensor Hub',
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  win.loadFile(path.join(__dirname, 'www', 'index.html'), page ? { hash: '/' + page } : {});

  // Links that open a new window (e.g. a camera URL) go to the normal web browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
}

// Only one copy of the app at a time
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // A link clicked while the app is already open arrives here
  app.on('second-instance', (_e, argv) => {
    const [win] = BrowserWindow.getAllWindows();
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.focus();
    const page = pageFromArgs(argv);
    if (page) win.webContents.executeJavaScript(`location.hash = ${JSON.stringify('#/' + page)}`).catch(() => {});
  });
  app.whenReady().then(() => {
    registerScheme();
    createWindow(pageFromArgs(process.argv));
  });
  app.on('window-all-closed', () => app.quit());
}
