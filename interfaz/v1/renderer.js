const $ = (id) => document.getElementById(id);

let estado = null;          // ultimo estado de la camara enviado por main.js
let destino = null;         // { ruta, existe, libre, total }
let discos = [];
let modo = 'normal';        // 'normal' | 'copiando' | 'terminado'
const seleccion = new Set();
let enCopia = [];           // vuelos de la copia actual, en orden
let vueloActual = null;
const estadoVuelo = {};     // nombre -> 'cola' | 'copiando' | 'ok' | 'mal' | 'detenido'
let estimadoTotal = '';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
function partes(nombre) {
  const m = nombre.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return { fecha: nombre, hora: '' };
  return { fecha: `${Number(m[3])} ${MESES[Number(m[2]) - 1]} ${m[1]}`, hora: `${m[4]}:${m[5]}:${m[6]}` };
}
function corto(d) {
  // "0h 14m 30s" -> "14 min 30 s"; "1h 02m 05s" -> "1 h 02 min"
  const m = d.match(/(\d+)h (\d+)m (\d+)s/);
  if (!m) return d;
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (h) return `${h} h ${String(mi).padStart(2, '0')} min`;
  if (mi) return `${mi} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}
function el(tag, props = {}, ...hijos) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...hijos);
  return e;
}

// ------------------------------------------------------------------ camara
const ESTADO_CAMARA = {
  esperando: ['No conectada', ''],
  montando: ['Conectando…', 'medio'],
  leyendo: ['Leyendo vuelos…', 'medio'],
  lista: ['Conectada', 'on'],
};
const TITULO_CARGA = {
  esperando: 'Esperando la cámara',
  montando: 'Conectando con la cámara',
  leyendo: 'Leyendo vuelos',
};

window.sentera.onEstado((e) => {
  const [txt, cls] = ESTADO_CAMARA[e.fase] || ['Buscando…', ''];
  $('camara-estado').textContent = txt;
  $('camara-punto').className = 'punto ' + cls;
  $('camara').classList.toggle('desconectado', e.fase !== 'lista');
  if (modo !== 'normal') return;   // durante la copia la tabla no cambia
  estado = e;
  if (e.fase !== 'lista') {
    $('cargando-titulo').textContent = TITULO_CARGA[e.fase] || 'Buscando la cámara';
    $('cargando-detalle').textContent = e.detalle || '';
    $('cargando').classList.remove('oculto');
    $('tabla').classList.add('oculto');
  } else {
    const nombres = new Set(e.vuelos.map((v) => v.nombre));
    for (const s of [...seleccion]) if (!nombres.has(s)) seleccion.delete(s);
    $('cargando').classList.add('oculto');
    $('tabla').classList.remove('oculto');
    if (!e.vuelos.length) {
      $('cargando-titulo').textContent = 'La cámara no tiene vuelos';
      $('cargando-detalle').textContent = '';
      $('cargando').classList.remove('oculto');
      $('tabla').classList.add('oculto');
    }
  }
  pintarTabla();
  pintarEstado();
});

// ------------------------------------------------------------------ destino
window.sentera.onDestinos((d) => {
  discos = d.discos;
  destino = d.destino;
  pintarDestinos();
  pintarBarra();
  if (modo === 'normal') pintarEstado();
});

function pintarDestinos() {
  const cont = $('discos');
  cont.textContent = '';
  const icoDisco = '<svg class="ico" viewBox="0 0 16 16"><rect x="1.5" y="4" width="13" height="8" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.1"/><circle cx="11.8" cy="8" r=".9" fill="currentColor"/></svg>';
  let destinoEsDisco = false;
  for (const k of discos) {
    const sel = destino && destino.ruta === k.ruta;
    if (sel) destinoEsDisco = true;
    const item = el('div', { className: 'item clic' + (sel ? ' sel' : ''), title: k.ruta });
    item.innerHTML = icoDisco;
    item.append(el('div', { className: 'txt' }, el('span', { textContent: k.nombre }), el('small', { textContent: `${k.libre} libres` })));
    item.addEventListener('click', () => { if (modo === 'normal') window.sentera.fijarDisco(k.ruta); });
    cont.appendChild(item);
  }
  if (!discos.length) {
    cont.appendChild(el('div', { className: 'item desconectado' },
      el('div', { className: 'txt' }, el('span', { textContent: 'Sin discos externos' }), el('small', { textContent: 'Conecta el disco' }))));
  }

  // carpeta elegida que no es la raiz de un disco
  const c = $('carpeta-elegida');
  c.textContent = '';
  if (destino && !destinoEsDisco) {
    const item = el('div', { className: 'item ' + (destino.existe ? 'sel' : 'desconectado'), title: destino.ruta });
    item.innerHTML = '<svg class="ico" viewBox="0 0 16 16"><path d="M1.5 4a1 1 0 0 1 1-1h3.6l1.4 1.5h6a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1Z" fill="none" stroke="currentColor" stroke-width="1.1"/></svg>';
    const partesRuta = destino.ruta.split('/');
    item.append(el('div', { className: 'txt' },
      el('span', { textContent: partesRuta[partesRuta.length - 1] || destino.ruta }),
      el('small', { textContent: destino.existe ? `${destino.libre || ''} libres` : 'No disponible' })));
    c.appendChild(item);
  }
}

$('btn-destino').addEventListener('click', () => { if (modo === 'normal') window.sentera.elegirDestino(); });

// ------------------------------------------------------------------ tabla
function pintarTabla() {
  const tb = $('filas');
  tb.textContent = '';
  if (!estado || estado.fase !== 'lista') return;
  for (const v of estado.vuelos) {
    const p = partes(v.nombre);
    const marcado = seleccion.has(v.nombre);
    const cb = el('input', { type: 'checkbox', checked: marcado, disabled: modo !== 'normal' });
    const ev = estadoVuelo[v.nombre];
    const [txtEstado, clsEstado] = {
      cola: ['En cola', 'tenue'],
      copiando: ['Copiando…', 'activo'],
      ok: ['Copiado y verificado', 'ok'],
      mal: ['Con problemas', 'mal'],
      detenido: ['Detenido', 'tenue'],
    }[ev] || ['', ''];
    const tr = el('tr', { className: marcado ? 'sel' : '', title: v.nombre },
      el('td', { className: 'c-check' }, cb),
      el('td', { textContent: p.fecha }),
      el('td', { className: 'tenue', textContent: p.hora }),
      el('td', { className: 'num', textContent: v.imagenes.toLocaleString('es-MX') }),
      el('td', { className: 'num tenue', textContent: v.tamano }),
      el('td', { className: 'c-estado ' + clsEstado, textContent: txtEstado }));
    tr.addEventListener('click', () => {
      if (modo !== 'normal') return;
      seleccion.has(v.nombre) ? seleccion.delete(v.nombre) : seleccion.add(v.nombre);
      pintarTabla();
      pintarBarra();
    });
    tb.appendChild(tr);
  }
  const todos = estado.vuelos.length > 0 && estado.vuelos.every((v) => seleccion.has(v.nombre));
  $('todos').checked = todos;
  $('todos').disabled = modo !== 'normal';
}

$('todos').addEventListener('change', (ev) => {
  seleccion.clear();
  if (ev.target.checked && estado && estado.vuelos) for (const v of estado.vuelos) seleccion.add(v.nombre);
  pintarTabla();
  pintarBarra();
});

$('btn-refrescar').addEventListener('click', () => { if (modo === 'normal') window.sentera.refrescar(); });

// ------------------------------------------------------------------ barra de herramientas
function seleccionados() {
  return estado && estado.vuelos ? estado.vuelos.filter((v) => seleccion.has(v.nombre)) : [];
}

function pintarBarra() {
  const sel = seleccionados();
  const destinoOk = destino && destino.existe;
  let sub = '';
  if (estado && estado.fase === 'lista') {
    sub = sel.length
      ? `${sel.length} de ${estado.vuelos.length} seleccionados · ${sel.reduce((a, v) => a + v.imagenes, 0).toLocaleString('es-MX')} imágenes`
      : `${estado.vuelos.length} en la cámara`;
  }
  $('subtitulo').textContent = sub;
  $('btn-copiar').disabled = !(modo === 'normal' && sel.length && destinoOk);
  $('btn-copiar').title = !destinoOk ? 'Elige un destino en la barra lateral' : !sel.length ? 'Marca uno o más vuelos' : '';
}

// ------------------------------------------------------------------ barra de estado
function pintarEstado(linea1, linea2, clase) {
  if (modo === 'normal') {
    if (!destino) { linea1 = 'Elige un destino en la barra lateral.'; }
    else if (!destino.existe) { linea1 = 'El destino no está disponible. ¿Está conectado el disco?'; clase = 'aviso'; }
    else { linea1 = 'Destino: ' + destino.ruta; linea2 = destino.libre ? `${destino.libre} libres de ${destino.total}` : ''; }
  }
  $('estado-1').textContent = linea1 || '';
  $('estado-1').className = clase || '';
  $('estado-2').textContent = linea2 || '';
}

// ------------------------------------------------------------------ copia
$('btn-copiar').addEventListener('click', async () => {
  const vuelos = seleccionados().map((v) => v.nombre);
  if (!vuelos.length) return;
  modo = 'copiando';
  enCopia = vuelos;
  vueloActual = null;
  estimadoTotal = '';
  for (const k of Object.keys(estadoVuelo)) delete estadoVuelo[k];
  for (const v of vuelos) estadoVuelo[v] = 'cola';
  $('log').textContent = '';
  setBarra(0);
  $('progreso').classList.remove('oculto');
  mostrarBotones('copiando');
  pintarTabla();
  pintarBarra();
  pintarEstado('Preparando la copia…', 'Revisando qué falta en el destino');
  const r = await window.sentera.iniciarCopia({ fuente: estado.fuente, vuelos });
  if (!r.ok) { agregarLog('ERROR: ' + r.error, 'err'); terminar(2, r.error); }
});

function mostrarBotones(m) {
  $('btn-cancelar').classList.toggle('oculto', m !== 'copiando');
  $('btn-cancelar').disabled = false;
  $('btn-abrir').classList.toggle('oculto', m !== 'terminado');
  $('btn-listo').classList.toggle('oculto', m !== 'terminado');
}

function setBarra(p) { $('barra').style.width = Math.min(100, p).toFixed(1) + '%'; }

function agregarLog(texto, clase) {
  const log = $('log');
  const abajo = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.appendChild(el('span', { className: clase || '', textContent: texto + '\n' }));
  while (log.childNodes.length > 3000) log.removeChild(log.firstChild);
  if (abajo) log.scrollTop = log.scrollHeight;
}

function cambiarVuelo(nombre) {
  if (nombre === vueloActual || !(nombre in estadoVuelo)) return;
  if (vueloActual && estadoVuelo[vueloActual] === 'copiando') estadoVuelo[vueloActual] = 'ok';
  // los vuelos anteriores en la cola que no imprimieron nada ya estaban completos
  for (const v of enCopia) { if (v === nombre) break; if (estadoVuelo[v] === 'cola') estadoVuelo[v] = 'ok'; }
  vueloActual = nombre;
  estadoVuelo[nombre] = 'copiando';
  pintarTabla();
}

const RE_OK = /^\[\s*(\d+)\/(\d+)\]\s+(\S+)\s+OK.*?\s([\d.]+ [KMGT]?B) en ([\d.]+) s \((\d+) MB\/s\) \| lleva (.+?) \| faltan (\d+) img, ~(.+)$/;
const RE_IDX = /^\[\s*(\d+)\/(\d+)\]\s+(\S+)/;
const RE_EST = /^Tiempo estimado .*?: (.+)$/;

window.sentera.onLinea((linea) => {
  const l = linea.replace(/^\d\d:\d\d:\d\d /, '');
  let clase = '';
  if (/FALLO|ERROR|ABORTO|INVALIDO|PROBLEMA/.test(l)) clase = 'err';
  else if (/^RESULTADO: (TODO|COPIADO)/.test(l)) clase = 'ok';
  agregarLog(l, clase);

  let m;
  if ((m = l.match(RE_EST))) {
    estimadoTotal = corto(m[1]);
    pintarEstado('Copiando…', `Tiempo estimado: ${estimadoTotal}`);
  }
  if ((m = l.match(RE_OK))) {
    const [, i, n, ruta, , seg, mbs, lleva, faltan, resta] = m;
    const [vuelo, , img] = ruta.split('/');
    cambiarVuelo(vuelo);
    setBarra(100 * i / n);
    const p = partes(vuelo);
    pintarEstado(
      `Copiando ${p.fecha} ${p.hora.slice(0, 5)} — ${img || ruta} (${i} de ${n})`,
      `${Number(seg).toFixed(2)} s por imagen · ${mbs} MB/s · lleva ${corto(lleva)} · faltan ${faltan} imágenes, ~${corto(resta)}` +
        (estimadoTotal ? ` · estimado inicial ${estimadoTotal}` : ''));
  } else if ((m = l.match(RE_IDX))) {
    cambiarVuelo(m[3].split('/')[0]);
    setBarra(100 * m[1] / m[2]);
  }
});

window.sentera.onFin(({ code }) => terminar(code));

function terminar(code, detalle) {
  modo = 'terminado';
  const textos = {
    0: ['Todo copiado y verificado.', 'ok'],
    3: ['Copiado y verificado todo lo válido. Hay archivos dañados en la propia cámara (ver Registro).', 'aviso'],
    1: ['Quedaron archivos con problema. Vuelve a copiar: seguirá donde se quedó.', 'mal'],
    2: [detalle || 'No se pudo empezar (ver Registro).', 'mal'],
    130: ['Copia detenida. No se dañó nada; al volver a copiar sigue donde se quedó.', 'aviso'],
  };
  const [txt, cls] = textos[code] || [`Terminó con código ${code} (ver Registro).`, 'mal'];
  for (const v of enCopia) {
    if (code === 0 || code === 3) estadoVuelo[v] = 'ok';
    else if (estadoVuelo[v] === 'copiando') estadoVuelo[v] = code === 130 ? 'detenido' : 'mal';
    else if (estadoVuelo[v] === 'cola') estadoVuelo[v] = code === 130 ? 'detenido' : 'mal';
  }
  if (code === 0 || code === 3) setBarra(100);
  pintarTabla();
  pintarEstado(txt, $('estado-2').textContent, cls);
  mostrarBotones('terminado');
}

$('btn-cancelar').addEventListener('click', () => {
  $('btn-cancelar').disabled = true;
  pintarEstado('Deteniendo… termina la imagen actual de forma segura.', $('estado-2').textContent);
  window.sentera.cancelarCopia();
});
$('btn-abrir').addEventListener('click', () => window.sentera.abrirDestino());
$('btn-listo').addEventListener('click', () => {
  modo = 'normal';
  for (const k of Object.keys(estadoVuelo)) delete estadoVuelo[k];
  $('progreso').classList.add('oculto');
  mostrarBotones('normal');
  pintarTabla();
  pintarBarra();
  pintarEstado();
  window.sentera.volver();
});
$('btn-log').addEventListener('click', () => {
  const oculto = $('log').classList.toggle('oculto');
  $('btn-log').classList.toggle('activo', !oculto);
  if (!oculto) $('log').scrollTop = $('log').scrollHeight;
});

pintarEstado();
