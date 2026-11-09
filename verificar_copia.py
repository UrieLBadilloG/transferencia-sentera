#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
verificar_copia.py - Comprobacion INDEPENDIENTE (solo lectura) de un vuelo ya copiado.

Relee cada imagen del destino y la compara con el manifiesto SHA-256 que genero
copiar_sentera.py. Sirve para confirmar que lo que quedo en el SSD es identico a lo copiado,
sin volver a leer la camara (la camara es opcional: solo se usa para comparar tamanos).

Uso:
  python3 verificar_copia.py --vuelo-dir /ruta/destino/2026-11-07_15-12-03 \\
        --manifiesto _copia_logs/copia_AAAAMMDD_HHMMSS.sha256 --esperados 1363 \\
        [--camara /Volumes/data/snapshots/2026-11-07_15-12-03]

Comprueba:
  A) cantidad de imagenes, numeracion IMG_0001..IMG_N sin huecos ni sobrantes, restos .part
  B) (si hay camara) mismo tamano que en la camara; JPEG completo (FFD8 ... FFD9)
  C) SHA-256 de cada imagen del destino contra el manifiesto
"""

import argparse
import fcntl
import hashlib
import os
import re
import sys
import time


def out(s):
    print(s, flush=True)


def main():
    ap = argparse.ArgumentParser(description='Verificacion independiente de un vuelo copiado.')
    ap.add_argument('--vuelo-dir', required=True, help='Carpeta del vuelo en el destino (la que contiene rgb/)')
    ap.add_argument('--manifiesto', required=True, help='Archivo .sha256 generado por copiar_sentera.py')
    ap.add_argument('--esperados', required=True, type=int, help='Cantidad de imagenes validas esperadas')
    ap.add_argument('--camara', help='Carpeta del mismo vuelo en la camara (opcional, para comparar tamanos)')
    args = ap.parse_args()

    rgb = os.path.join(args.vuelo_dir, 'rgb')
    esperados = args.esperados
    reales = sorted(f for f in os.listdir(rgb) if not f.startswith('._') and f != '.DS_Store')

    out('== A) CANTIDAD Y NUMERACION')
    out('archivos en destino: %d (esperados %d)' % (len(reales), esperados))
    nums = sorted(int(m.group(1)) for m in (re.match(r'IMG_(\d+)\.jpe?g$', f, re.I) for f in reales) if m)
    faltan = sorted(set(range(1, esperados + 1)) - set(nums))
    sobran = sorted(set(nums) - set(range(1, esperados + 1)))
    out('faltan en la secuencia 1..%d: %d %s' % (esperados, len(faltan), faltan[:30]))
    out('sobran fuera de 1..%d: %d %s' % (esperados, len(sobran), sobran[:30]))
    otros = [f for f in reales if not re.match(r'IMG_\d+\.jpe?g$', f, re.I)]
    out('nombres inesperados: %s' % otros)
    part = [f for d, _, fs in os.walk(args.vuelo_dir) for f in fs if f.endswith('.part')]
    out('restos .part: %d' % len(part))

    out('')
    out('== B) TAMANO CONTRA LA CAMARA + JPEG COMPLETO')
    ceros, dif, mal_jpeg = [], [], []
    for f in reales:
        p = os.path.join(rgb, f)
        sz = os.path.getsize(p)
        if sz == 0:
            ceros.append(f)
            continue
        if args.camara:
            try:
                sc = os.path.getsize(os.path.join(args.camara, 'rgb', f))
                # OJO: la camara a veces informa un tamano falso (33 bytes); solo se marca si es plausible
                if sc != sz and sc > 4096:
                    dif.append((f, sz, sc))
            except OSError:
                pass
        with open(p, 'rb') as fh:
            cab = fh.read(2)
            fh.seek(max(0, sz - 4096))
            cola = fh.read()
        if cab != b'\xff\xd8' or not cola.rstrip(b'\xff').endswith(b'\xff\xd9'):
            mal_jpeg.append(f)
    out('de 0 bytes: %s' % ceros)
    out('tamano distinto al de la camara: %s' % (dif[:20] if args.camara else '(sin camara, no comparado)'))
    out('JPEG incompleto (sin FFD8 o sin FFD9): %s' % mal_jpeg)

    out('')
    out('== C) SHA-256 DEL DESTINO vs MANIFIESTO')
    man = {}
    with open(args.manifiesto, encoding='utf-8') as fh:
        for linea in fh:
            h, _, ruta = linea.rstrip('\n').partition('  ')
            man[ruta] = h
    out('entradas en el manifiesto: %d' % len(man))
    bien, malos, sin_man = 0, [], []
    t0 = time.time()
    for i, f in enumerate(reales, 1):
        p = os.path.join(rgb, f)
        esperado = man.get(p)
        if esperado is None:
            sin_man.append(f)
            continue
        h = hashlib.sha256()
        with open(p, 'rb') as fh:
            try:
                fcntl.fcntl(fh.fileno(), fcntl.F_NOCACHE, 1)   # leer del disco, no de la cache
            except OSError:
                pass
            while True:
                b = fh.read(8 * 1024 * 1024)
                if not b:
                    break
                h.update(b)
        if h.hexdigest() == esperado:
            bien += 1
        else:
            malos.append(f)
        if i % 200 == 0:
            out('  ... %d/%d releidos (%.0fs)' % (i, len(reales), time.time() - t0))
    out('hash coincide: %d de %d' % (bien, len(reales)))
    out('hash NO coincide: %s' % malos)
    out('sin entrada en el manifiesto: %s' % sin_man)

    ok = (len(reales) == esperados and not faltan and not sobran and not part and not ceros
          and not dif and not mal_jpeg and not malos and not sin_man and not otros)
    out('')
    out('RESULTADO: %s' % ('TODO CORRECTO: %d/%d imagenes completas e identicas a lo copiado' % (bien, esperados)
                           if ok else 'HAY DISCREPANCIAS (ver arriba)'))
    return 0 if ok else 1


if __name__ == '__main__':
    sys.exit(main())
