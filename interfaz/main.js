// Proceso principal: busca la camara sin mostrar dialogos de Finder, la monta,
// lista los vuelos y lanza copiar_sentera.py, reenviando su salida a la ventana.
const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const { execFile, spawn } = require('child_process');

const CAMARA_IP = '192.168.42.1';
const PYTHON = '/usr/bin/python3';
const REPO = path.join(__dirname, '..');
const SCRIPT = path.join(REPO, 'copiar_sentera.py');
const PUNTO_MONTAJE = path.join(os.homedir(), 'Library', 'Application Support', 'TransferirSentera', 'camara');
const VUELO_RE = /^\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/;
const SONDEO_MS = 3000;
// Version de la interfaz: v2 por defecto; `npm run v1` abre la anterior.
const UI = process.env.SENTERA_UI === 'v1' ? 'v1' : 'v2';

let win = null;
let copia = null;          // proceso de copia en curso
let buscando = false;      // evita sondeos solapados
let estadoActual = null;
let ultimoDestino = null;
let destino = null;        // carpeta destino elegida (se recuerda entre sesiones)

const CONFIG = () => path.join(app.getPath('userData'), 'config.json');

function leerConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG(), 'utf8')); } catch { return {}; }
}

function guardarConfig(c) {
  try { fs.writeFileSync(CONFIG(), JSON.stringify(c, null, 2)); } catch { /* no es critico */ }
}

function humano(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : n) + ' ' + u[i];
}

function espacio(ruta) {
  try {
    const s = fs.statfsSync(ruta);
    const libreB = s.bavail * s.bsize;
    const totalB = s.blocks * s.bsize;
    return { libre: humano(libreB), total: humano(totalB), libreB, totalB };
  } catch { return null; }
}

// Discos locales montados en /Volumes (SSD/discos externos). Se leen de `mount`, sin recorrer
// /Volumes, para no colgarse si el montaje SMB de la camara esta atascado.
async function discosExternos() {
  const { stdout } = await ejecutar('/sbin/mount', []);
  const discos = [];
  for (const linea of stdout.split('\n')) {
    const m = linea.match(/^\S+ on (\/Volumes\/.+?) \(([^,)]+)(.*)\)$/);
    // fuera: la camara (smbfs), lo que no es local y lo de solo lectura (instaladores .dmg)
    if (!m || m[2] === 'smbfs' || !/\blocal\b/.test(m[3]) || /\bread-only\b/.test(m[3])) continue;
    const e = espacio(m[1]);
    if (e) discos.push({ ruta: m[1], nombre: path.basename(m[1]), ...e });
  }
  return discos;
}

function infoDestino() {
  if (!destino) return null;
  const existe = fs.existsSync(destino);
  return { ruta: destino, existe, ...(existe ? espacio(destino) : {}) };
}

async function enviarDestinos() {
  enviar('destinos', { discos: await discosExternos(), destino: infoDestino() });
}

function fijarDestino(ruta) {
  if (copia) return false;   // no cambiar el destino a mitad de una copia
  try {
    if (typeof ruta !== 'string' || !fs.statSync(ruta).isDirectory()) return false;
  } catch { return false; }
  destino = ruta;
  guardarConfig({ ...leerConfig(), destino });
  enviarDestinos();
  return true;
}

function enviar(canal, datos) {
  if (win && !win.isDestroyed()) win.webContents.send(canal, datos);
}

function estado(e) {
  estadoActual = e;
  enviar('estado', e);
}

function ejecutar(cmd, args, timeout = 15000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

// Punto de montaje SMB de la camara, leido de `mount` (no toca /Volumes, no se cuelga).
async function montajeActual() {
  const { stdout } = await ejecutar('/sbin/mount', []);
  const re = new RegExp('^//(?:[^@\\s]*@)?' + CAMARA_IP.replace(/\./g, '\\.') + '/\\S+ on (.+?) \\(smbfs');
  for (const linea of stdout.split('\n')) {
    const m = linea.match(re);
    if (m) return m[1];
  }
  return null;
}

function hayRedCamara() {
  return Object.values(os.networkInterfaces()).flat().some(
    (i) => i && (i.family === 'IPv4' || i.family === 4) && i.address.startsWith('192.168.42.'));
}

function puertoSmbAbierto(timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.createConnection({ host: CAMARA_IP, port: 445 });
    const fin = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(timeout, () => fin(false));
    s.once('connect', () => fin(true));
    s.once('error', () => fin(false));
  });
}

// Monta sin dialogos: mount_smbfs a una carpeta propia; si falla, AppleScript "mount volume".
async function montar() {
  fs.mkdirSync(PUNTO_MONTAJE, { recursive: true });
  const r = await ejecutar('/sbin/mount_smbfs', ['-N', `//sentera:@${CAMARA_IP}/data`, PUNTO_MONTAJE], 30000);
  if (r.code !== 0) {
    await ejecutar('/usr/bin/osascript', ['-e',
      `mount volume "smb://${CAMARA_IP}/data" as user name "sentera" with password ""`], 30000);
  }
  return montajeActual();
}

function listarVuelos(fuente) {
  return new Promise((resolve) => {
    const vuelos = [];
    const p = spawn(PYTHON, ['-u', SCRIPT, '--listar', '--source', fuente], { cwd: REPO });
    let resto = '';
    p.stdout.on('data', (d) => {
      const lineas = (resto + d.toString()).split('\n');
      resto = lineas.pop();
      for (const l of lineas) {
        const t = l.split('\t');
        if (t[0] === 'VUELO' && t.length >= 4) {
          vuelos.push({ nombre: t[1], imagenes: Number(t[2]), tamano: t[3] });
          if (t[4]) primeraImagen.set(t[1], t[4]);
          estado({ fase: 'leyendo', fuente, detalle: `Leyendo vuelos de la cámara… (${vuelos.length} encontrados)` });
        }
      }
    });
    p.on('error', () => resolve(null));
    p.on('close', (code) => resolve(code === 0 ? vuelos : null));
  });
}

async function buscarCamara(forzar = false) {
  if (buscando || copia) return;
  buscando = true;
  try {
    let fuente = await montajeActual();
    if (!fuente) {
      if (!(await puertoSmbAbierto())) {
        estado({
          fase: 'esperando',
          detalle: hayRedCamara()
            ? 'La red de la cámara aparece, pero la cámara aún no responde. Esperando a que termine de arrancar…'
            : 'Conecta la Sentera por USB-C y enciéndela. Tarda 1–2 minutos en arrancar.',
        });
        return;
      }
      estado({ fase: 'montando', detalle: 'Cámara detectada. Conectando (usuario sentera, sin contraseña)…' });
      fuente = await montar();
      if (!fuente) {
        estado({ fase: 'esperando', detalle: 'La cámara responde pero no pude conectarme. Reintentando…' });
        return;
      }
    }
    if (!forzar && estadoActual && estadoActual.fase === 'lista' && estadoActual.fuente === fuente) return;
    estado({ fase: 'leyendo', fuente, detalle: 'Leyendo vuelos de la cámara…' });
    const vuelos = await listarVuelos(fuente);
    if (vuelos === null) {
      estado({ fase: 'esperando', detalle: 'No pude leer la cámara. Reintentando…' });
      return;
    }
    estado({ fase: 'lista', fuente, vuelos });
    for (const v of vuelos) pedirMiniatura(v.nombre);
  } finally {
    buscando = false;
  }
}

// ---------------------------------------------------------------- miniaturas
// Una por vuelo, de su primera imagen. Se hacen con `sips` (solo LEE la camara) y se guardan
// en la carpeta de la app; se generan de una en una y nunca durante una copia.
const primeraImagen = new Map();
const colaMini = [];
let generandoMini = false;
const DIR_MINI = () => path.join(app.getPath('userData'), 'miniaturas');

function enviarMiniatura(nombre, archivo) {
  try {
    enviar('miniatura', { nombre, datos: 'data:image/jpeg;base64,' + fs.readFileSync(archivo).toString('base64') });
  } catch { /* sin miniatura */ }
}

function pedirMiniatura(nombre) {
  if (!VUELO_RE.test(nombre)) return;
  const archivo = path.join(DIR_MINI(), nombre + '.jpg');
  if (fs.existsSync(archivo)) return enviarMiniatura(nombre, archivo);
  if (!colaMini.includes(nombre)) colaMini.push(nombre);
  procesarMiniaturas();
}

async function procesarMiniaturas() {
  if (generandoMini) return;
  generandoMini = true;
  try {
    while (colaMini.length && !copia) {
      const nombre = colaMini.shift();
      const src = primeraImagen.get(nombre);
      if (!src) continue;
      fs.mkdirSync(DIR_MINI(), { recursive: true });
      const archivo = path.join(DIR_MINI(), nombre + '.jpg');
      const tmp = archivo + '.tmp.jpg';
      const r = await ejecutar('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '70', '-Z', '480', src, '--out', tmp], 60000);
      if (r.code === 0 && fs.existsSync(tmp)) {
        fs.renameSync(tmp, archivo);
        enviarMiniatura(nombre, archivo);
      } else {
        try { fs.unlinkSync(tmp); } catch { /* nada */ }
      }
    }
  } finally {
    generandoMini = false;
  }
}

// ---------------------------------------------------------------- IPC
ipcMain.on('refrescar', () => buscarCamara(true));

ipcMain.handle('elegir-destino', async () => {
  const r = await dialog.showOpenDialog(win, {
    title: 'Carpeta destino',
    message: 'Cada vuelo se copia en una carpeta con su mismo nombre',
    defaultPath: destino && fs.existsSync(destino) ? destino : '/Volumes',
    properties: ['openDirectory', 'createDirectory'],
  });
  if (!r.canceled && r.filePaths.length) fijarDestino(r.filePaths[0]);
});

// Elegir un disco de la lista: solo se aceptan rutas que estan en la lista de discos montados.
ipcMain.handle('fijar-disco', async (_e, ruta) => {
  const discos = await discosExternos();
  if (discos.some((d) => d.ruta === ruta)) fijarDestino(ruta);
});

ipcMain.handle('iniciar-copia', (_e, { fuente, vuelos }) => {
  if (copia) return { ok: false, error: 'Ya hay una copia en curso.' };
  if (!estadoActual || estadoActual.fuente !== fuente) return { ok: false, error: 'La cámara cambió; vuelve a elegir.' };
  if (!Array.isArray(vuelos) || !vuelos.length || !vuelos.every((v) => VUELO_RE.test(v))) {
    return { ok: false, error: 'Selección de vuelos no válida.' };
  }
  if (!destino || !fs.existsSync(destino) || !fs.statSync(destino).isDirectory()) {
    return { ok: false, error: 'La carpeta destino no existe. ¿Está conectado el disco?' };
  }
  ultimoDestino = destino;
  const args = ['-u', SCRIPT, '--plano', '--source', fuente, '--dest', destino];
  for (const v of vuelos) args.push('--vuelo', v);
  copia = spawn(PYTHON, args, { cwd: REPO });
  let resto = '';
  const porLineas = (d) => {
    const lineas = (resto + d.toString()).split('\n');
    resto = lineas.pop();
    for (const l of lineas) if (l.trim()) enviar('copia-linea', l);
  };
  copia.stdout.on('data', porLineas);
  copia.stderr.on('data', porLineas);
  copia.on('error', (err) => enviar('copia-linea', 'ERROR: no pude ejecutar python3: ' + err.message));
  copia.on('close', (code, signal) => {
    if (resto.trim()) enviar('copia-linea', resto);
    copia = null;
    enviar('copia-fin', { code: code === null ? (signal ? 130 : 1) : code });
    procesarMiniaturas();   // si quedaron pendientes por la copia
  });
  return { ok: true };
});

// SIGINT = Ctrl-C: el script lo atrapa, borra el .part en curso y sale con 130.
ipcMain.on('cancelar-copia', () => { if (copia) copia.kill('SIGINT'); });

ipcMain.on('abrir-destino', () => { if (ultimoDestino) shell.openPath(ultimoDestino); });

ipcMain.on('volver', () => { estadoActual = null; buscarCamara(true); });

// ---------------------------------------------------------------- ventana
function crearVentana() {
  win = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: 'Transferir Sentera',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 18 },
    vibrancy: 'sidebar',
    visualEffectState: 'followWindow',
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, UI, 'index.html'));
  win.webContents.on('did-finish-load', () => {
    if (estadoActual) enviar('estado', estadoActual);
    if (estadoActual && estadoActual.vuelos) for (const v of estadoActual.vuelos) pedirMiniatura(v.nombre);
    enviarDestinos();
    buscarCamara();
  });
  win.on('close', (e) => {
    if (!copia) return;
    const r = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Seguir copiando', 'Detener y salir'],
      defaultId: 0,
      cancelId: 0,
      message: 'Hay una copia en curso.',
      detail: 'Si sales, se detiene. No se daña nada: al volver a copiar sigue donde se quedó.',
    });
    if (r === 0) e.preventDefault();
    else copia.kill('SIGINT');
  });
}

app.whenReady().then(() => {
  destino = leerConfig().destino || null;   // puede no existir ahora (disco desconectado)
  crearVentana();
  setInterval(() => { buscarCamara(); enviarDestinos(); }, SONDEO_MS);
});

app.on('window-all-closed', () => app.quit());
