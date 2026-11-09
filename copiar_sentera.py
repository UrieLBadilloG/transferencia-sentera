#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
copiar_sentera.py - Copia segura de vuelos de la Sentera 65R al SSD externo.

REGLAS DE SEGURIDAD
  * La camara solo se LEE. El script nunca mueve, renombra ni borra nada en la fuente.
  * Cada archivo se escribe como "<nombre>.part", se fuerza a disco (F_FULLFSYNC),
    se vuelve a leer del SSD sin cache y se compara su SHA-256 contra el de la fuente.
    Solo si coincide se renombra al nombre final. Nunca queda un JPG a medias con nombre valido.
  * Si un archivo falla (error de E/S, -36, -50, etc.) se reintenta; si sigue fallando
    se registra y se continua con el siguiente.
  * Es reanudable: se puede volver a ejecutar y salta lo que ya esta bien copiado.

USO
  python3 copiar_sentera.py --dry-run                 # solo muestra el plan
  python3 copiar_sentera.py                           # copia (detecta la camara sola)
  python3 copiar_sentera.py --verify-existing         # ademas compara por hash lo ya copiado
  python3 copiar_sentera.py --source /Volumes/XXXX    # indicar la camara a mano
  python3 copiar_sentera.py --vuelo 2026-11-06_17-23-58   # solo ese vuelo (se puede repetir)

Estructura de destino (igual a la que ya existe en el SSD):
  <dest>/<AAAA-MM-DD>/<AAAA-MM-DD_HH-MM-SS>/rgb/IMG_xxxx.jpg
"""

import argparse
import datetime
import fcntl
import hashlib
import os
import re
import shutil
import subprocess
import sys
import time

FLIGHT_RE = re.compile(r'^(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}$')
IMG_RE = re.compile(r'^IMG_(\d+)\.jpe?g$', re.I)
IGNORAR = {'.DS_Store', '.Spotlight-V100', '.Trashes', '.fseventsd',
           'System Volume Information', '.TemporaryItems', '.DocumentRevisions-V100'}
CHUNK = 8 * 1024 * 1024
DEST_DEFAULT = '/Volumes/Uriel-Artif/Sentera_65R'
LOG_DEFAULT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '_copia_logs')
REINTENTOS = 3
ESPERA_REINTENTO = (5, 15, 30)   # segundos antes de cada reintento
MAX_FALLOS_SEGUIDOS = 5          # si fallan tantos archivos seguidos, se aborta (cable/camara desconectada)
TAM_MIN_JPEG = 4096              # una imagen real de la Sentera pesa decenas de MB; menos de esto = entrada danada


class ErrorVerificacion(IOError):
    pass


# ----------------------------------------------------------------- utilidades
_log_fh = None


def log(msg):
    linea = '%s %s' % (datetime.datetime.now().strftime('%H:%M:%S'), msg)
    print(linea, flush=True)
    if _log_fh:
        _log_fh.write(linea + '\n')
        _log_fh.flush()


def humano(n):
    for u in ('B', 'KB', 'MB', 'GB', 'TB'):
        if n < 1024 or u == 'TB':
            return '%.1f %s' % (n, u) if u != 'B' else '%d B' % n
        n /= 1024.0


def duracion(seg):
    seg = int(seg)
    return '%dh %02dm %02ds' % (seg // 3600, (seg % 3600) // 60, seg % 60)


def sin_cache(fd):
    try:
        fcntl.fcntl(fd, fcntl.F_NOCACHE, 1)
    except OSError:
        pass


def sincronizar(fd):
    """En macOS os.fsync no vacia la cache del disco; F_FULLFSYNC si."""
    try:
        fcntl.fcntl(fd, fcntl.F_FULLFSYNC)
    except OSError:
        os.fsync(fd)


def hash_archivo(ruta):
    h = hashlib.sha256()
    total = 0
    with open(ruta, 'rb') as f:
        sin_cache(f.fileno())
        while True:
            b = f.read(CHUNK)
            if not b:
                break
            h.update(b)
            total += len(b)
    return h.hexdigest(), total


def jpeg_completo(ruta):
    """Cabecera FFD8 y fin FFD9 (tolerando relleno 0xFF al final, como escribe la Sentera)."""
    try:
        sz = os.path.getsize(ruta)
        if sz < 4:
            return False
        with open(ruta, 'rb') as f:
            cab = f.read(2)
            f.seek(max(0, sz - 4096))
            cola = f.read()
        return cab == b'\xff\xd8' and cola.rstrip(b'\xff').endswith(b'\xff\xd9')
    except OSError:
        return False


def es_jpeg(ruta):
    return ruta.lower().endswith(('.jpg', '.jpeg'))


def ignorado(nombre):
    return nombre in IGNORAR or nombre.startswith('._')


# ------------------------------------------------------- deteccion de la fuente
def buscar_vuelos(raiz, max_prof=4):
    res = []
    base = raiz.rstrip(os.sep).count(os.sep)
    for dirpath, dirnames, _ in os.walk(raiz, onerror=lambda e: log('  (aviso) no pude leer %s' % e.filename)):
        dirnames[:] = [d for d in dirnames if not ignorado(d)]
        prof = dirpath.rstrip(os.sep).count(os.sep) - base
        for d in list(dirnames):
            if FLIGHT_RE.match(d):
                res.append((d, os.path.join(dirpath, d)))
                dirnames.remove(d)
        if prof >= max_prof:
            dirnames[:] = []
    return sorted(res)


def detectar_fuente(dest_root):
    dest_real = os.path.realpath(dest_root)
    partes = dest_real.split(os.sep)
    dest_vol = os.path.join('/Volumes', partes[2]) if len(partes) > 2 and partes[1] == 'Volumes' else None
    candidatos = []
    for nombre in sorted(os.listdir('/Volumes')):
        ruta = os.path.join('/Volumes', nombre)
        if os.path.islink(ruta):           # "Macintosh HD" apunta a /
            continue
        if dest_vol and os.path.realpath(ruta) == os.path.realpath(dest_vol):
            continue
        if not os.path.ismount(ruta):
            continue
        vuelos = buscar_vuelos(ruta)
        if vuelos:
            candidatos.append((ruta, vuelos))
    return candidatos


# --------------------------------------------------------------------- copia
def copiar_archivo(src, dst, st):
    """Copia src -> dst verificando. Devuelve el sha256. Lanza OSError si algo falla."""
    tmp = dst + '.part'
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    h = hashlib.sha256()
    leidos = 0
    try:
        with open(src, 'rb') as fi, open(tmp, 'wb') as fo:
            sin_cache(fi.fileno())
            sin_cache(fo.fileno())
            while True:
                b = fi.read(CHUNK)
                if not b:
                    break
                h.update(b)
                fo.write(b)
                leidos += len(b)
            fo.flush()
            sincronizar(fo.fileno())
        if leidos != st.st_size:
            raise ErrorVerificacion('se leyeron %d bytes de %d' % (leidos, st.st_size))
        # releer lo escrito en el SSD (sin cache) y comparar
        h_dest, n_dest = hash_archivo(tmp)
        if n_dest != st.st_size or h_dest != h.hexdigest():
            raise ErrorVerificacion('el archivo en el SSD no coincide con la fuente (%d de %d bytes)'
                                    % (n_dest, st.st_size))
        # la fuente no debe haber cambiado mientras copiaba
        st2 = os.stat(src)
        if st2.st_size != st.st_size or st2.st_mtime_ns != st.st_mtime_ns:
            raise ErrorVerificacion('la fuente cambio durante la copia')
        os.utime(tmp, ns=(st.st_atime_ns, st.st_mtime_ns))
        os.replace(tmp, dst)
        return h.hexdigest()
    except BaseException:
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        raise


def diagnosticar_invalido(src):
    """Explica por que un JPG diminuto de la camara no sirve (solo lectura)."""
    try:
        with open(src, 'rb') as f:
            datos = f.read(64)
        return 'solo %d bytes y no es un JPEG' % len(datos)
    except OSError as e:
        return 'la camara no permite leerlo ([errno %s] %s)' % (getattr(e, 'errno', '?'), e.strerror)


def origen_legible(src):
    """True si el archivo de la camara se puede leer y empieza como un JPEG (FFD8).
    OJO: la camara a veces informa un tamano falso (p. ej. 33 bytes) para archivos que estan bien,
    asi que el tamano por si solo NO sirve para declarar un archivo invalido."""
    try:
        with open(src, 'rb') as f:
            cab = f.read(4096)
        return len(cab) >= 2 and cab[:2] == b'\xff\xd8'
    except OSError:
        return False


def clasificar_barato(item):
    """Sin hashear: 'invalido en camara' | 'nuevo' | 'tamano distinto' | 'jpeg danado' | 'presente'."""
    if es_jpeg(item['src']) and item['size'] < TAM_MIN_JPEG:
        if not origen_legible(item['src']):
            return 'invalido en camara'
        # legible: el tamano informado era falso; se vuelve a consultar y se trata como archivo normal
        try:
            item['size'] = os.stat(item['src']).st_size
        except OSError:
            return 'invalido en camara'
    if not os.path.exists(item['dst']):
        return 'nuevo'
    try:
        if os.path.getsize(item['dst']) != item['size']:
            return 'tamano distinto'
        if es_jpeg(item['dst']) and not jpeg_completo(item['dst']):
            return 'jpeg danado'
    except OSError:
        return 'tamano distinto'
    return 'presente'


def carpeta_vuelo_destino(dest_root, nombre, plano):
    """<dest>/<fecha>/<vuelo> (por defecto) o <dest>/<vuelo> con --plano."""
    if plano:
        return os.path.join(dest_root, nombre)
    return os.path.join(dest_root, FLIGHT_RE.match(nombre).group(1), nombre)


def construir_plan(vuelos, dest_root, plano=False):
    plan = []
    for nombre, ruta in vuelos:
        for dirpath, dirnames, archivos in os.walk(ruta):
            dirnames[:] = sorted(d for d in dirnames if not ignorado(d))
            for f in sorted(archivos):
                if ignorado(f):
                    continue
                src = os.path.join(dirpath, f)
                rel = os.path.relpath(src, ruta)
                plan.append({
                    'vuelo': nombre, 'src': src, 'rel': rel,
                    'dst': os.path.join(carpeta_vuelo_destino(dest_root, nombre, plano), rel),
                    'size': os.stat(src).st_size,
                })
    return plan


def huecos_secuencia(nombres):
    nums = sorted(int(m.group(1)) for m in (IMG_RE.match(n) for n in nombres) if m)
    if not nums:
        return None, []
    faltan = sorted(set(range(nums[0], nums[-1] + 1)) - set(nums))
    return (nums[0], nums[-1]), faltan


# ---------------------------------------------------------------------- main
def main():
    global _log_fh
    ap = argparse.ArgumentParser(description='Copia segura de vuelos Sentera al SSD (solo lee la camara).')
    ap.add_argument('--source', help='Volumen o carpeta de la camara (por defecto se detecta sola)')
    ap.add_argument('--dest', default=DEST_DEFAULT, help='Carpeta destino (default: %s)' % DEST_DEFAULT)
    ap.add_argument('--vuelo', action='append', help='Copiar solo este vuelo (AAAA-MM-DD_HH-MM-SS). Repetible.')
    ap.add_argument('--verify-existing', action='store_true',
                    help='Comparar por hash (fuente vs SSD) los archivos que ya existen con igual tamano')
    ap.add_argument('--plano', action='store_true',
                    help='Sin carpeta de fecha: <dest>/<vuelo>/rgb/... (como arrastrar la carpeta en Finder)')
    ap.add_argument('--dry-run', action='store_true', help='Solo mostrar el plan, no copiar')
    ap.add_argument('--log-dir', default=LOG_DEFAULT)
    args = ap.parse_args()

    dest_root = os.path.abspath(args.dest)
    partes = os.path.realpath(dest_root).split(os.sep)
    if len(partes) > 2 and partes[1] == 'Volumes' and not os.path.isdir(os.path.join('/', 'Volumes', partes[2])):
        print('ERROR: el SSD (%s) no esta montado.' % os.path.join('/Volumes', partes[2]))
        return 2

    os.makedirs(args.log_dir, exist_ok=True)
    marca = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    log_path = os.path.join(args.log_dir, 'copia_%s.log' % marca)
    manifiesto = os.path.join(args.log_dir, 'copia_%s.sha256' % marca)
    _log_fh = open(log_path, 'a', encoding='utf-8')
    log('Log: %s' % log_path)

    # ---- fuente
    if args.source:
        fuente = os.path.abspath(args.source)
        if not os.path.isdir(fuente):
            log('ERROR: la fuente %s no existe.' % fuente)
            return 2
        vuelos = buscar_vuelos(fuente)
    else:
        cands = detectar_fuente(dest_root)
        if not cands:
            log('ERROR: no encuentro la camara. Volumenes vistos en /Volumes: %s' % ', '.join(sorted(os.listdir('/Volumes'))))
            log('       Conecta la camara o usa --source /Volumes/NOMBRE')
            return 2
        if len(cands) > 1:
            log('ERROR: hay varios volumenes con vuelos, indica cual con --source:')
            for ruta, v in cands:
                log('   %s (%d vuelos)' % (ruta, len(v)))
            return 2
        fuente, vuelos = cands[0]
    log('Fuente : %s' % fuente)
    log('Destino: %s' % dest_root)

    if args.vuelo:
        vuelos = [(n, r) for n, r in vuelos if n in args.vuelo]
        faltan_v = [v for v in args.vuelo if v not in [n for n, _ in vuelos]]
        if faltan_v:
            log('AVISO: no encontre en la fuente los vuelos: %s' % ', '.join(faltan_v))
    if not vuelos:
        log('ERROR: no se encontraron carpetas de vuelo (AAAA-MM-DD_HH-MM-SS) en la fuente.')
        try:
            log('Contenido de la raiz de la fuente: %s' % ', '.join(sorted(os.listdir(fuente))[:30]))
        except OSError:
            pass
        return 2

    # ---- plan
    plan = construir_plan(vuelos, dest_root, args.plano)
    por_vuelo = {}
    for it in plan:
        por_vuelo.setdefault(it['vuelo'], []).append(it)
    log('')
    log('Vuelos en la camara: %d' % len(vuelos))
    pendientes_bytes = 0
    for nombre, _ in vuelos:
        items = por_vuelo.get(nombre, [])
        if not items:
            log('  %s  VACIO en la camara (0 archivos)' % nombre)
            continue
        estados = {}
        for it in items:
            it['estado'] = clasificar_barato(it)
            estados[it['estado']] = estados.get(it['estado'], 0) + 1
            if it['estado'] not in ('presente', 'invalido en camara'):
                pendientes_bytes += it['size']
        rango, faltan = huecos_secuencia([os.path.basename(i['src']) for i in items])
        extra = ''
        if rango:
            extra = '  IMG %d-%d' % rango + ('  huecos en la camara: %d' % len(faltan) if faltan else '')
        log('  %s  %d archivos, %s  %s%s' % (
            nombre, len(items), humano(sum(i['size'] for i in items)),
            ', '.join('%s=%d' % kv for kv in sorted(estados.items())), extra))
    total_bytes = sum(i['size'] for i in plan)
    log('Total fuente: %d archivos, %s. Por copiar (estimado): %s' % (len(plan), humano(total_bytes), humano(pendientes_bytes)))

    libre = shutil.disk_usage(os.path.dirname(dest_root) if not os.path.exists(dest_root) else dest_root).free
    log('Espacio libre en destino: %s' % humano(libre))
    if pendientes_bytes * 1.02 > libre:
        log('ERROR: no hay espacio suficiente en el SSD.')
        return 2
    if args.dry_run:
        log('--dry-run: no se copio nada.')
        return 0

    # ---- evitar que el Mac se duerma mientras copia
    try:
        subprocess.Popen(['caffeinate', '-i', '-w', str(os.getpid())],
                         stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    except OSError:
        log('AVISO: no pude activar caffeinate; evita que el Mac se suspenda.')

    # ---- borrar restos ".part" de copias interrumpidas (son archivos propios de este script, en el SSD)
    for nombre, _ in vuelos:
        carpeta = carpeta_vuelo_destino(dest_root, nombre, args.plano)
        for dirpath, _, archivos in os.walk(carpeta):
            for f in archivos:
                if f.endswith('.part') and not f.startswith('._'):
                    try:
                        os.remove(os.path.join(dirpath, f))
                        log('Quitado resto de copia interrumpida: %s' % os.path.join(dirpath, f))
                    except OSError as e:
                        log('AVISO: no pude quitar %s: %s' % (f, e))

    # ---- copia
    n_total = len(plan)
    ok = saltados = recopiados = 0
    fallidos = []
    invalidos = []
    seguidos = 0
    bytes_copiados = 0
    t0 = time.time()
    with open(manifiesto, 'a', encoding='utf-8') as man:
        for idx, it in enumerate(plan, 1):
            etiqueta = '[%*d/%d] %s/%s' % (len(str(n_total)), idx, n_total, it['vuelo'], it['rel'])
            estado = it['estado'] if 'estado' in it else clasificar_barato(it)

            if estado == 'invalido en camara':
                # entrada danada en el ORIGEN (p. ej. 33 bytes e ilegible): no es un fallo de copia,
                # no se reintenta ni cuenta para el aborto por fallos seguidos
                invalidos.append(it)
                log('%s  INVALIDO EN LA CAMARA (%s). No se copia.' % (etiqueta, diagnosticar_invalido(it['src'])))
                continue

            if estado == 'presente' and args.verify_existing:
                try:
                    hs, _ = hash_archivo(it['src'])
                    hd, _ = hash_archivo(it['dst'])
                    if hs != hd:
                        estado = 'hash distinto'
                    else:
                        man.write('%s  %s\n' % (hs, it['dst']))
                        man.flush()
                except OSError as e:
                    log('%s  error verificando existente: %s' % (etiqueta, e))
                    estado = 'hash distinto'
            if estado == 'presente':
                saltados += 1
                seguidos = 0
                continue

            exito = False
            for intento in range(1, REINTENTOS + 1):
                t1 = time.time()
                try:
                    if not os.path.isdir(fuente):
                        raise OSError('la camara dejo de estar disponible')
                    st = os.stat(it['src'])
                    digest = copiar_archivo(it['src'], it['dst'], st)
                    dt = max(time.time() - t1, 1e-6)
                    if es_jpeg(it['dst']) and not jpeg_completo(it['dst']):
                        log('%s  AVISO: copiado y verificado, pero el JPEG de la fuente ya venia incompleto' % etiqueta)
                    man.write('%s  %s\n' % (digest, it['dst']))
                    man.flush()
                    bytes_copiados += st.st_size
                    if estado != 'nuevo':
                        recopiados += 1
                    ok += 1
                    transcurrido = time.time() - t0
                    vel = bytes_copiados / max(transcurrido, 1e-6)
                    restante = (pendientes_bytes - bytes_copiados) / vel if vel > 0 else 0
                    log('%s  OK%s %s %.0f MB/s  | resta ~%s' % (
                        etiqueta, '' if estado == 'nuevo' else ' (reemplaza: %s)' % estado,
                        humano(st.st_size), st.st_size / dt / 1048576.0, duracion(max(restante, 0))))
                    exito = True
                    break
                except KeyboardInterrupt:
                    log('Interrumpido por el usuario. Nada se modifico en la camara.')
                    log('Resumen parcial: ok=%d saltados=%d fallidos=%d' % (ok, saltados, len(fallidos)))
                    return 130
                except OSError as e:
                    log('%s  FALLO intento %d/%d: [errno %s] %s' % (etiqueta, intento, REINTENTOS, getattr(e, 'errno', '?'), e))
                    if intento < REINTENTOS:
                        time.sleep(ESPERA_REINTENTO[intento - 1])
            if exito:
                seguidos = 0
            else:
                fallidos.append(it)
                seguidos += 1
                log('%s  DEFINITIVAMENTE FALLIDO' % etiqueta)
                if seguidos >= MAX_FALLOS_SEGUIDOS:
                    log('ABORTO: %d archivos seguidos fallaron. Revisa el cable/puerto USB o si la camara sigue conectada.' % seguidos)
                    break

    # ---- resumen
    log('')
    log('=' * 70)
    log('RESUMEN  (tiempo %s, copiado %s)' % (duracion(time.time() - t0), humano(bytes_copiados)))
    log('  copiados y verificados: %d  (de ellos reemplazaron un archivo malo: %d)' % (ok, recopiados))
    log('  ya estaban bien (omitidos): %d' % saltados)
    log('  fallidos: %d' % len(fallidos))
    for it in fallidos:
        log('    - %s/%s' % (it['vuelo'], it['rel']))
    log('  invalidos en la camara (no se copian, el archivo de origen esta danado): %d' % len(invalidos))
    por_vuelo_inv = {}
    for it in invalidos:
        por_vuelo_inv.setdefault(it['vuelo'], []).append(os.path.basename(it['rel']))
    for v, nombres in sorted(por_vuelo_inv.items()):
        rango, _ = huecos_secuencia(nombres)
        log('    - %s: %d archivos%s' % (v, len(nombres), ' (IMG %d a IMG %d)' % rango if rango else ''))
    log('  Vuelos:')
    for nombre, _ in vuelos:
        items = por_vuelo.get(nombre, [])
        if not items:
            log('    %s  vacio en la camara' % nombre)
            continue
        estados = [clasificar_barato(i) for i in items]
        n_inv = estados.count('invalido en camara')
        n_ok = estados.count('presente')
        n_mal = len(items) - n_inv - n_ok
        rango, faltan = huecos_secuencia([os.path.basename(i['src']) for i in items])
        log('    %s  camara=%d archivos, SSD correcto=%d, con problema de copia=%d, invalidos en la camara=%d%s' % (
            nombre, len(items), n_ok, n_mal, n_inv,
            '  (huecos de numeracion ya en la camara: %d)' % len(faltan) if faltan else ''))
    log('  Manifiesto SHA-256: %s' % manifiesto)
    log('  Log: %s' % log_path)
    if fallidos:
        log('RESULTADO: HAY ARCHIVOS CON PROBLEMA. No expulses la camara; vuelve a ejecutar el script.')
        return 1
    if invalidos:
        log('RESULTADO: COPIADO Y VERIFICADO TODO LO QUE ES VALIDO. Hay %d archivos danados en la propia camara (no se pudieron copiar).' % len(invalidos))
        return 3
    log('RESULTADO: TODO COPIADO Y VERIFICADO.')
    return 0


if __name__ == '__main__':
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print('\nInterrumpido. Nada se modifico en la camara.')
        sys.exit(130)
