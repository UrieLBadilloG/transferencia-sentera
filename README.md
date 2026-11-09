# transferencia-sentera

Copia **segura y verificada** de vuelos de una cámara **Sentera 65R** a un disco externo (SSD) desde macOS.

Nació porque copiar las imágenes con Finder fallaba a ratos (errores -40 / -50) y dejaba archivos truncados o de 0 bytes. Este script reemplaza a Finder en esa tarea: **solo lee la cámara, nunca mueve ni borra nada en ella**, y no da por buena ninguna imagen hasta comprobar que quedó idéntica en el destino.

- Solo usa la biblioteca estándar de Python 3 (sin dependencias).
- Probado en macOS 26 con la cámara montada por SMB y un SSD exFAT.

## Contenido

| Archivo | Para qué sirve |
|---|---|
| `copiar_sentera.py` | Copia los vuelos de la cámara al SSD con verificación por hash, reintentos y reanudación. |
| `verificar_copia.py` | Comprobación independiente (solo lectura) de un vuelo ya copiado. |
| `docs/BITACORA.md` | Cómo se construyó y se usó, paso a paso. |
| `docs/PROBLEMAS_Y_SOLUCIONES.md` | Fallos encontrados (tamaños falsos, archivos ilegibles, espacio libre engañoso, cámara que no se detecta) y qué hacer. |

## Cómo se conecta la cámara

La Sentera 65R **no se monta como disco**: al conectarla por USB-C aparece como un dispositivo de red.

1. En *Ajustes del Sistema > Red* debe aparecer el servicio **Sentera 65R Sensor** con punto verde y una IP `192.168.42.x`.
2. La cámara responde en `192.168.42.1`. Se monta en Finder con *Ir > Conectarse al servidor* usando `smb://sentera@192.168.42.1/data`, o desde la terminal:
   ```bash
   open "smb://sentera@192.168.42.1/data"
   ```
3. Queda en `/Volumes/data`. Los vuelos están en `/Volumes/data/snapshots/<AAAA-MM-DD_HH-MM-SS>/rgb/IMG_xxxx.jpg`.

Si el Mac no la detecta, ver `docs/PROBLEMAS_Y_SOLUCIONES.md`.

## Uso rápido

```bash
# 1) Ver el plan sin copiar nada (qué vuelos hay, cuántos archivos, cuánto pesan, cuáles ya están)
python3 copiar_sentera.py --dry-run

# 2) Copiar todo lo que falte (detecta la cámara sola)
python3 copiar_sentera.py

# 3) Copiar solo ciertos vuelos
python3 copiar_sentera.py --vuelo 2026-11-07_15-12-03 --vuelo 2026-11-07_19-36-02

# 4) Copiar dentro de una carpeta concreta, sin la carpeta de fecha intermedia
python3 copiar_sentera.py --plano --source /Volumes/data \
    --dest /Volumes/MiSSD/Sentera_65R/lote1 --vuelo 2026-11-07_19-36-02

# 5) Además, comparar por hash lo que ya existe en el destino (más lento)
python3 copiar_sentera.py --verify-existing
```

Se puede volver a ejecutar cuantas veces haga falta: **omite lo que ya está bien** y reemplaza lo que esté truncado, vacío o dañado.

### Opciones

| Opción | Efecto |
|---|---|
| `--source RUTA` | Volumen o carpeta de la cámara. Por defecto se detecta sola en `/Volumes`. |
| `--dest RUTA` | Carpeta destino. Por defecto `/Volumes/Uriel-Artif/Sentera_65R` (cámbialo a tu disco). |
| `--vuelo NOMBRE` | Copia solo ese vuelo. Se puede repetir. |
| `--plano` | Destino `<dest>/<vuelo>/rgb/...` en lugar de `<dest>/<fecha>/<vuelo>/rgb/...`. |
| `--verify-existing` | Compara por hash fuente y destino de los archivos que ya existen con el mismo tamaño. |
| `--dry-run` | Muestra el plan y termina. |
| `--log-dir RUTA` | Dónde guardar logs y manifiestos (por defecto `_copia_logs/` junto al script). |

### Estructura de destino

```
<dest>/<AAAA-MM-DD>/<AAAA-MM-DD_HH-MM-SS>/rgb/IMG_0001.jpg ...     (por defecto)
<dest>/<AAAA-MM-DD_HH-MM-SS>/rgb/IMG_0001.jpg ...                   (con --plano)
```

## Cómo funciona la copia segura

Por cada archivo:

1. **Lee** de la cámara en bloques de 8 MiB, sin caché (`F_NOCACHE`), calculando SHA-256 al vuelo.
2. **Escribe** en `IMG_xxxx.jpg.part` en el destino y fuerza el vaciado real a disco (`F_FULLFSYNC`; en macOS `fsync` no basta).
3. **Relee** el `.part` desde el disco, sin caché, y compara tamaño y SHA-256 con lo leído de la cámara.
4. Comprueba que el archivo de la cámara **no cambió** durante la copia.
5. Solo si todo coincide, conserva la fecha de modificación y **renombra** a `IMG_xxxx.jpg` (operación atómica). Nunca queda un JPG a medias con nombre válido.
6. Si algo falla (error de E/S, tamaño que no cuadra, verificación distinta), borra el `.part`, **espera y reintenta** (3 intentos: 5 s y 15 s de espera). Si sigue fallando lo anota y pasa al siguiente.
7. Si fallan **5 archivos seguidos** se aborta: casi seguro es el cable, el puerto o la cámara desconectada.

Además:
- Impide que el Mac se suspenda mientras copia (`caffeinate`).
- Al iniciar borra los `.part` que haya dejado una copia interrumpida (son archivos propios del script).
- Antes de copiar comprueba que haya espacio suficiente en el destino.
- Un JPG de la cámara solo se descarta como "inválido" si **no se puede leer** o no empieza como JPEG. El tamaño que informa la cámara **no es confiable** (ver documentación).

### Salidas

- `_copia_logs/copia_<fecha>.log`: una línea por archivo con velocidad y tiempo restante, y un resumen final por vuelo.
- `_copia_logs/copia_<fecha>.sha256`: manifiesto `hash  ruta` de cada archivo copiado.

### Códigos de salida

| Código | Significado |
|---|---|
| `0` | Todo copiado y verificado. |
| `1` | Quedaron archivos con problema de copia. Volver a ejecutar. |
| `2` | No pudo empezar (cámara o SSD no encontrados, sin espacio, etc.). |
| `3` | Todo lo válido se copió y verificó, pero hay archivos ilegibles en la propia cámara. |
| `130` | Interrumpido por el usuario (Ctrl-C). Nada se modificó en la cámara. |

## Verificación independiente

Después de copiar, se puede releer el destino y compararlo con el manifiesto, sin tocar la cámara:

```bash
python3 verificar_copia.py \
    --vuelo-dir /Volumes/MiSSD/Sentera_65R/lote1/2026-11-07_19-36-02 \
    --manifiesto _copia_logs/copia_20261107_161925.sha256 \
    --esperados 1699
```

Revisa cantidad y numeración (`IMG_0001` a `IMG_N` sin huecos), restos `.part`, archivos de 0 bytes, JPEG completo (`FFD8` … `FFD9`) y el SHA-256 de cada imagen contra el manifiesto. `--camara` es opcional y solo agrega la comparación de tamaños.

## Buenas prácticas

- **No borres nada de la cámara** hasta que el script diga `TODO COPIADO Y VERIFICADO` (o `COPIADO Y VERIFICADO TODO LO QUE ES VALIDO`) y, si quieres doble seguridad, hasta correr `verificar_copia.py`.
- No uses Finder (ni cortar/pegar) para mover imágenes desde la cámara.
- Conecta directo al Mac, con el cable original o uno de datos, sin hubs.
- No expulses el SSD ni la cámara mientras el script corre.
- Para borrar en la cámara desde Finder usa **Cmd+Opción+Supr** ("Eliminar inmediatamente"). Con solo Cmd+Supr los archivos pasan a la papelera de la cámara y no se libera espacio.
