const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sentera', {
  onEstado: (cb) => ipcRenderer.on('estado', (_e, d) => cb(d)),
  onLinea: (cb) => ipcRenderer.on('copia-linea', (_e, l) => cb(l)),
  onFin: (cb) => ipcRenderer.on('copia-fin', (_e, d) => cb(d)),
  onMiniatura: (cb) => ipcRenderer.on('miniatura', (_e, d) => cb(d)),
  onDestinos: (cb) => ipcRenderer.on('destinos', (_e, d) => cb(d)),
  refrescar: () => ipcRenderer.send('refrescar'),
  elegirDestino: () => ipcRenderer.invoke('elegir-destino'),
  fijarDisco: (ruta) => ipcRenderer.invoke('fijar-disco', ruta),
  iniciarCopia: (o) => ipcRenderer.invoke('iniciar-copia', o),
  cancelarCopia: () => ipcRenderer.send('cancelar-copia'),
  abrirDestino: () => ipcRenderer.send('abrir-destino'),
  volver: () => ipcRenderer.send('volver'),
});
