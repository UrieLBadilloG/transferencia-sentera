// v2: rejilla de vuelos con miniatura (como Fotos > Importar).
const $ = (id) => document.getElementById(id);

let estado = null;          // ultimo estado de la camara enviado por main.js
let destino = null;         // { ruta, existe, libre, total, libreB, totalB }
let discos = [];
let modo = 'normal';        // 'normal' | 'copiando' | 'terminado'
const seleccion = new Set();
const miniaturas = {};      // nombre -> data URL
let enCopia = [];           // vuelos de la copia actual, en el orden en que los copia el script
let vueloActual = null;
const estadoVuelo = {};     // nombre -> 'cola' | 'copiando' | 'ok' | 'mal' | 'detenido'
const pctVuelo = {};        // nombre -> 0..100
let estimadoTotal = '';

const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
function partes(nombre) {
  const m = nombre.match(/^(\d{4})-(\d{2})-(\d{2})_(\d{2})-(\d{2})-(\d{2})$/);
  if (!m) return { fecha: nombre, hora: '', dia: '' };
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return { fecha: `${Number(m[3])} de ${MESES[Number(m[2]) - 1]} de ${m[1]}`, hora: `${m[4]}:${m[5]}`, dia: DIAS[d.getDay()] };
}
function corto(d) {
  const m = d.match(/(\d+)h (\d+)m (\d+)s/);
  if (!m) return d;
  const [h, mi, s] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (h) return `${h} h ${String(mi).padStart(2, '0')} min`;
  if (mi) return `${mi} min ${String(s).padStart(2, '0')} s`;
  return `${s} s`;
}
// "31.0 GB" -> bytes (aproximado; solo para la barra de espacio)
function aBytes(t) {
  const m = String(t).match(/([\d.]+)\s*([KMGT]?B)/);
  if (!m) return 0;
  return Number(m[1]) * 1024 ** ['B', 'KB', 'MB', 'GB', 'TB'].indexOf(m[2]);
}
function humano(n) {
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return (i ? n.toFixed(1) : Math.round(n)) + ' ' + u[i];
}
function el(tag, props = {}, ...hijos) {
  const e = document.createElement(tag);
  Object.assign(e, props);
  e.append(...hijos);
  return e;
}
function svg(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

const SVG_CHECK = '<svg viewBox="0 0 12 12"><path d="M2.5 6.2 5 8.6l4.6-5" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SVG_OK = '<svg viewBox="0 0 22 22"><path d="M5.5 11.5 9.3 15l7.2-8" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SVG_MAL = '<svg viewBox="0 0 22 22"><path d="M11 6v6.5M11 16v.2" fill="none" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/></svg>';
const SVG_PAUSA = '<svg viewBox="0 0 22 22"><path d="M8.5 7v8M13.5 7v8" fill="none" stroke="#fff" stroke-width="2.4" stroke-linecap="round"/></svg>';
const SVG_FOTO = '<svg viewBox="0 0 40 40"><rect x="5" y="9" width="30" height="22" rx="3" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="14" cy="17" r="2.6" fill="currentColor"/><path d="m8 28 8-8 6 6 4-4 7 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/></svg>';
const ANILLO_LARGO = 150.8;   // 2 * pi * 24

// ------------------------------------------------------------------ camara
const ESTADO_CAMARA = {
  esperando: ['No conectada', ''],
  montando: ['Conectando…', 'medio'],
  leyendo: ['Leyendo vuelos…', 'medio'],
  lista: ['Conectada', 'on'],
};
const TITULO_CARGA = {
  esperando: 'Conecta la cámara',
  montando: 'Conectando con la cámara',
  leyendo: 'Leyendo vuelos',
};

window.sentera.onEstado((e) => {
  const [txt, cls] = ESTADO_CAMARA[e.fase] || ['Buscando…', ''];
  $('camara-estado').textContent = txt;
  $('camara-punto').className = 'punto ' + cls;
  $('camara').classList.toggle('apagado', e.fase === 'esperando');
  if (modo !== 'normal') return;   // durante la copia la rejilla no cambia
  estado = e;
  if (e.fase === 'lista') {
    const nombres = new Set(e.vuelos.map((v) => v.nombre));
    for (const s of [...seleccion]) if (!nombres.has(s)) seleccion.delete(s);
  }
  const hayVuelos = e.fase === 'lista' && e.vuelos.length > 0;
  $('rejilla').classList.toggle('oculto', !hayVuelos);
  $('cargando').classList.toggle('oculto', hayVuelos);
  $('cargando').querySelector('.spinner').classList.toggle('oculto', e.fase === 'lista');
  if (!hayVuelos) {
    $('cargando-titulo').textContent = e.fase === 'lista' ? 'La cámara no tiene vuelos' : (TITULO_CARGA[e.fase] || 'Buscando la cámara');
    $('cargando-detalle').textContent = e.fase === 'lista' ? '' : (e.detalle || '');
  }
  pintarRejilla();
  pintarBarra();
});

window.sentera.onMiniatura(({ nombre, datos }) => {
  miniaturas[nombre] = datos;
  const img = document.querySelector(`.vuelo[data-nombre="${nombre}"] img`);
  if (img && !img.src) { img.src = datos; img.onload = () => img.classList.add('cargada'); }
});

// ------------------------------------------------------------------ destino
window.sentera.onDestinos((d) => {
  discos = d.discos;
  destino = d.destino;
  pintarDestinos();
  pintarUso();
  pintarBarra();
});

function pintarDestinos() {
  const cont = $('discos');
  cont.textContent = '';
  let destinoEsDisco = false;
  for (const k of discos) {
    const sel = destino && destino.ruta === k.ruta;
    if (sel) destinoEsDisco = true;
    const item = el('div', { className: 'item clic' + (sel ? ' sel' : ''), title: k.ruta });
    item.append(
      svg('<span class="insignia naranja"><svg viewBox="0 0 16 16"><rect x="2" y="4.2" width="12" height="7.6" rx="1.6" fill="#fff"/><circle cx="11.4" cy="8" r=".9" fill="#f08a00"/></svg></span>'),
      el('div', { className: 'txt' }, el('span', { textContent: k.nombre }), el('small', { textContent: `${k.libre} disponibles` })));
    item.addEventListener('click', () => { if (modo === 'normal') window.sentera.fijarDisco(k.ruta); });
    cont.appendChild(item);
  }
  if (!discos.length) {
    cont.appendChild(el('div', { className: 'item apagado' },
      svg('<span class="insignia gris"><svg viewBox="0 0 16 16"><rect x="2" y="4.2" width="12" height="7.6" rx="1.6" fill="#fff"/></svg></span>'),
      el('div', { className: 'txt' }, el('span', { textContent: 'Ningún disco' }), el('small', { textContent: 'Conecta el disco externo' }))));
  }

  const c = $('carpeta-elegida');
  c.textContent = '';
  if (destino && !destinoEsDisco) {
    const nombre = destino.ruta.split('/').filter(Boolean).pop() || destino.ruta;
    const item = el('div', { className: 'item ' + (destino.existe ? 'sel' : 'apagado'), title: destino.ruta });
    item.append(
      svg('<span class="insignia azul"><svg viewBox="0 0 16 16"><path d="M1.6 4.2a1 1 0 0 1 1-1h3.5l1.3 1.4h5.9a1 1 0 0 1 1 1v6.2a1 1 0 0 1-1 1H2.6a1 1 0 0 1-1-1Z" fill="#fff"/></svg></span>'),
      el('div', { className: 'txt' }, el('span', { textContent: nombre }),
        el('small', { textContent: destino.existe ? `${destino.libre || ''} disponibles` : 'No disponible' })));
    c.appendChild(item);
  }
}

$('btn-destino').addEventListener('click', () => { if (modo === 'normal') window.sentera.elegirDestino(); });

// barra de espacio del destino: ocupado + lo que se va a copiar
function pintarUso() {
  if (!destino || !destino.existe || !destino.totalB) { $('uso').classList.add('oculto'); return; }
  $('uso').classList.remove('oculto');
  const nombre = destino.ruta.split('/').filter(Boolean).pop() || destino.ruta;
  const nuevo = modo === 'normal' ? seleccionados().reduce((a, v) => a + aBytes(v.tamano), 0) : 0;
  const ocupado = destino.totalB - destino.libreB;
  $('uso-nombre').textContent = nombre;
  $('uso-libre').textContent = `${destino.libre} libres`;
  $('uso-ocupado').style.width = (100 * ocupado / destino.totalB).toFixed(1) + '%';
  $('uso-nuevo').style.width = (100 * Math.min(nuevo, destino.libreB) / destino.totalB).toFixed(1) + '%';
  const nota = $('uso-nota');
  if (nuevo > destino.libreB) { nota.textContent = `Faltan ${humano(nuevo - destino.libreB)} de espacio`; nota.className = 'uso-nota mal'; }
  else if (nuevo) { nota.textContent = `La selección ocupará ${humano(nuevo)}`; nota.className = 'uso-nota'; }
  else { nota.textContent = ''; nota.className = 'uso-nota'; }
}

// ------------------------------------------------------------------ rejilla
function seleccionados() {
  return estado && estado.vuelos ? estado.vuelos.filter((v) => seleccion.has(v.nombre)) : [];
}

function crearTarjeta(v) {
  const p = partes(v.nombre);
  const img = el('img', { alt: '' });
  if (miniaturas[v.nombre]) { img.src = miniaturas[v.nombre]; img.className = 'cargada'; }
  const anillo = el('div', { className: 'anillo' },
    svg(`<svg viewBox="0 0 54 54"><circle class="fondo" cx="27" cy="27" r="24" fill="none" stroke-width="3.5"/><circle class="frente" cx="27" cy="27" r="24" fill="none" stroke-width="3.5" stroke-dasharray="${ANILLO_LARGO}" stroke-dashoffset="${ANILLO_LARGO}"/></svg>`),
    el('div', { className: 'pct' }));
  const sello = el('div', { className: 'sello' });
  const foto = el('div', { className: 'foto' },
    el('div', { className: 'marcador' }, svg(SVG_FOTO)), img,
    el('div', { className: 'capa' }, anillo, sello),
    el('div', { className: 'circulo' }, svg(SVG_CHECK)));
  const tarjeta = el('div', { className: 'vuelo', title: v.nombre },
    foto,
    el('div', { className: 'nom', textContent: `${p.fecha}` }),
    el('div', { className: 'meta' }));
  tarjeta.dataset.nombre = v.nombre;
  tarjeta.addEventListener('click', () => {
    if (modo !== 'normal') return;
    seleccion.has(v.nombre) ? seleccion.delete(v.nombre) : seleccion.add(v.nombre);
    pintarRejilla();
    pintarBarra();
  });
  return tarjeta;
}

function pintarRejilla() {
  const cont = $('rejilla');
  if (!estado || estado.fase !== 'lista') { cont.textContent = ''; return; }
  // reutilizar tarjetas existentes para no parpadear las miniaturas
  const existentes = new Map([...cont.children].map((c) => [c.dataset.nombre, c]));
  const orden = [];
  for (const v of estado.vuelos) {
    const t = existentes.get(v.nombre) || crearTarjeta(v);
    existentes.delete(v.nombre);
    actualizarTarjeta(t, v);
    orden.push(t);
  }
  for (const t of existentes.values()) t.remove();
  orden.forEach((t, i) => { if (cont.children[i] !== t) cont.insertBefore(t, cont.children[i] || null); });
}

function actualizarTarjeta(t, v) {
  const p = partes(v.nombre);
  const ev = estadoVuelo[v.nombre];
  t.className = 'vuelo' + (seleccion.has(v.nombre) && !ev ? ' sel' : '') + (modo !== 'normal' ? ' bloqueado' : '') + (ev ? ' ' + ev : '');
  const pct = Math.floor(pctVuelo[v.nombre] || 0);
  const meta = {
    cola: 'En espera',
    copiando: `Copiando… ${pct}%`,
    ok: 'Copiado y verificado',
    mal: 'Con problemas — ver Registro',
    detenido: 'Detenido',
  }[ev] || `${p.hora} · ${v.imagenes.toLocaleString('es-MX')} fotos · ${v.tamano}`;
  t.querySelector('.meta').textContent = meta;
  t.querySelector('.anillo .pct').textContent = ev === 'cola' ? 'En cola' : `${pct}%`;
  t.querySelector('.anillo .frente').style.strokeDashoffset = String(ANILLO_LARGO * (1 - (ev === 'cola' ? 0 : pct / 100)));
  t.querySelector('.sello').innerHTML = ev === 'ok' ? SVG_OK : ev === 'mal' ? SVG_MAL : ev === 'detenido' ? SVG_PAUSA : '';
}

$('btn-todos').addEventListener('click', () => {
  if (modo !== 'normal' || !estado || !estado.vuelos) return;
  const todos = estado.vuelos.every((v) => seleccion.has(v.nombre));
  seleccion.clear();
  if (!todos) for (const v of estado.vuelos) seleccion.add(v.nombre);
  pintarRejilla();
  pintarBarra();
});

$('btn-refrescar').addEventListener('click', () => { if (modo === 'normal') window.sentera.refrescar(); });

// ------------------------------------------------------------------ barra superior y de estado
function pintarBarra() {
  const sel = seleccionados();
  const destinoOk = destino && destino.existe;
  const lista = estado && estado.fase === 'lista';
  let sub = lista ? `${estado.vuelos.length} ${estado.vuelos.length === 1 ? 'vuelo' : 'vuelos'}` : ($('camara-estado').textContent);
  if (lista && sel.length) {
    const fotos = sel.reduce((a, v) => a + v.imagenes, 0);
    const bytes = sel.reduce((a, v) => a + aBytes(v.tamano), 0);
    sub = `${sel.length} de ${estado.vuelos.length} seleccionados · ${fotos.toLocaleString('es-MX')} fotos · ${humano(bytes)}`;
  }
  $('subtitulo').textContent = sub;
  const todos = lista && estado.vuelos.length && estado.vuelos.every((v) => seleccion.has(v.nombre));
  $('btn-todos').textContent = todos ? 'Deseleccionar' : 'Seleccionar todo';
  $('btn-todos').disabled = !(modo === 'normal' && lista && estado.vuelos.length);
  const n = sel.length;
  $('btn-copiar').textContent = n ? `Copiar ${n} ${n === 1 ? 'vuelo' : 'vuelos'}` : 'Copiar';
  $('btn-copiar').disabled = !(modo === 'normal' && n && destinoOk);
  $('btn-copiar').title = !destinoOk ? 'Elige un destino en la barra lateral' : !n ? 'Haz clic en los vuelos que quieras copiar' : '';
  if (modo === 'normal') {
    pintarUso();
    if (!destino) pintarEstado('Elige dónde copiar en la barra lateral.');
    else if (!destino.existe) pintarEstado('El destino no está disponible. ¿Está conectado el disco?', '', 'aviso');
    else if (lista && !n) pintarEstado('Haz clic en los vuelos que quieras copiar.', `Se copiarán en ${destino.ruta}`);
    else if (lista) pintarEstado(`Listo para copiar a ${destino.ruta}`, 'Cada vuelo queda en una carpeta con su mismo nombre.');
    else pintarEstado(`Destino: ${destino.ruta}`);
  }
}

function pintarEstado(linea1, linea2, clase) {
  $('estado-1').textContent = linea1 || '';
  $('estado-1').className = clase || '';
  $('estado-2').textContent = linea2 || '';
}

// ------------------------------------------------------------------ copia
$('btn-copiar').addEventListener('click', async () => {
  // el script copia los vuelos ordenados por nombre: mismo orden aqui para el % por vuelo
  const vuelos = seleccionados().map((v) => v.nombre).sort();
  if (!vuelos.length) return;
  modo = 'copiando';
  enCopia = vuelos;
  vueloActual = null;
  estimadoTotal = '';
  for (const k of Object.keys(estadoVuelo)) delete estadoVuelo[k];
  for (const k of Object.keys(pctVuelo)) delete pctVuelo[k];
  for (const v of vuelos) { estadoVuelo[v] = 'cola'; pctVuelo[v] = 0; }
  $('log').textContent = '';
  setBarra(0);
  $('progreso').classList.remove('oculto');
  mostrarBotones('copiando');
  pintarRejilla();
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

function infoVuelo(nombre) { return estado.vuelos.find((v) => v.nombre === nombre); }

// indice global del plan (1..N) -> % dentro del vuelo; el plan va vuelo por vuelo en orden
function actualizarAvance(nombre, indiceGlobal) {
  if (!(nombre in estadoVuelo)) return;
  let antes = 0;
  for (const v of enCopia) {
    if (v === nombre) break;
    antes += (infoVuelo(v) || { imagenes: 0 }).imagenes;
    if (estadoVuelo[v] === 'cola' || estadoVuelo[v] === 'copiando') { estadoVuelo[v] = 'ok'; pctVuelo[v] = 100; }
  }
  const total = (infoVuelo(nombre) || { imagenes: 1 }).imagenes || 1;
  vueloActual = nombre;
  estadoVuelo[nombre] = 'copiando';
  pctVuelo[nombre] = Math.max(0, Math.min(100, 100 * (indiceGlobal - antes) / total));
  pintarRejilla();
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
    actualizarAvance(vuelo, Number(i));
    setBarra(100 * i / n);
    const p = partes(vuelo);
    pintarEstado(
      `Copiando ${p.fecha}, ${p.hora} — ${img || ruta}`,
      `Faltan ~${corto(resta)} (${Number(faltan).toLocaleString('es-MX')} fotos) · lleva ${corto(lleva)} · ` +
        `${Number(seg).toFixed(2)} s por foto · ${mbs} MB/s` + (estimadoTotal ? ` · estimado ${estimadoTotal}` : ''));
  } else if ((m = l.match(RE_IDX))) {
    actualizarAvance(m[3].split('/')[0], Number(m[1]));
    setBarra(100 * m[1] / m[2]);
  }
});

window.sentera.onFin(({ code }) => terminar(code));

function terminar(code, detalle) {
  modo = 'terminado';
  const textos = {
    0: ['Todo copiado y verificado.', 'ok'],
    3: ['Copiado y verificado todo lo válido. Hay archivos dañados en la propia cámara.', 'aviso'],
    1: ['Quedaron archivos con problema. Vuelve a copiar: seguirá donde se quedó.', 'mal'],
    2: [detalle || 'No se pudo empezar. Abre el Registro para ver por qué.', 'mal'],
    130: ['Copia detenida. No se dañó nada; al volver a copiar sigue donde se quedó.', 'aviso'],
  };
  const [txt, cls] = textos[code] || [`Terminó con código ${code}. Abre el Registro.`, 'mal'];
  for (const v of enCopia) {
    if (code === 0 || code === 3) { estadoVuelo[v] = 'ok'; pctVuelo[v] = 100; }
    else if (estadoVuelo[v] === 'copiando' || estadoVuelo[v] === 'cola') estadoVuelo[v] = code === 130 ? 'detenido' : 'mal';
  }
  if (code === 0 || code === 3) setBarra(100);
  pintarRejilla();
  pintarEstado(txt, code === 0 || code === 3 ? `En ${destino ? destino.ruta : 'el destino'}` : $('estado-2').textContent, cls);
  mostrarBotones('terminado');
}

$('btn-cancelar').addEventListener('click', () => {
  $('btn-cancelar').disabled = true;
  pintarEstado('Deteniendo… termina la foto actual de forma segura.', $('estado-2').textContent);
  window.sentera.cancelarCopia();
});
$('btn-abrir').addEventListener('click', () => window.sentera.abrirDestino());
$('btn-listo').addEventListener('click', () => {
  modo = 'normal';
  for (const k of Object.keys(estadoVuelo)) delete estadoVuelo[k];
  seleccion.clear();
  $('progreso').classList.add('oculto');
  mostrarBotones('normal');
  pintarRejilla();
  pintarBarra();
  window.sentera.volver();
});
$('btn-log').addEventListener('click', () => {
  const oculto = $('log').classList.toggle('oculto');
  $('btn-log').classList.toggle('activo', !oculto);
  if (!oculto) $('log').scrollTop = $('log').scrollHeight;
});

pintarBarra();
