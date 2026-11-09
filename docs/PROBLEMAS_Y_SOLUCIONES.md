# Problemas encontrados y soluciones

Qué se observó al copiar vuelos de una Sentera 65R a un Mac. Se separa lo **comprobado** de lo que es **hipótesis**.

## 1. Errores -40 / -50 en Finder y archivos dañados

**Observado:** copiar con Finder fallaba a ratos y dejaba archivos truncados o de 0 bytes en el destino (por ejemplo, un JPG de exactamente 25 165 824 bytes = 24 MiB, y varios `IMG_xxxx.jpg` de 0 bytes).

**Comprobado:**
- El destino era un SSD **exFAT** montado con el driver `fskit` de macOS 26.
- La cámara no es un disco: se accede por **SMB sobre USB** (`smbfs`).
- Dentro de la cámara hay entradas de archivo realmente ilegibles (ver punto 3). Un copiado en bloque con Finder choca con ellas.

**Hipótesis (no confirmada):** la combinación de red SMB, exFAT/fskit y entradas ilegibles explica los errores de Finder.

**Solución aplicada:** `copiar_sentera.py` copia a un archivo `.part`, verifica por hash y renombra al final, con reintentos y sin tocar la cámara.

## 2. La cámara informa un tamaño falso (33 bytes)

**Observado:** durante una copia, 19 archivos fallaron en el primer intento con *"se leyeron 29 475 368 bytes de 33"*. `stat` devolvía 33 bytes para archivos que en realidad pesaban ~29 MB; en el reintento devolvía el tamaño real.

**Consecuencia:** una primera versión del script descartaba como "inválido" todo JPG de menos de 4 KB según el tamaño informado. Con eso se saltaron **16 imágenes buenas** de un vuelo.

**Solución aplicada:**
- Un archivo pequeño solo se declara inválido si **no se puede leer** o no empieza con `FFD8`. Si se lee bien, se vuelve a consultar el tamaño y se trata como archivo normal.
- Si el tamaño no coincide con lo leído, la copia **falla y se reintenta**, nunca se acepta en silencio.
- Por esa misma razón `verificar_copia.py` solo marca diferencia de tamaño contra la cámara cuando el tamaño informado es plausible (> 4 KB).

## 3. Archivos realmente ilegibles en la cámara

**Observado:** bloques consecutivos de imágenes (48 al final de un vuelo y 48 al principio del siguiente) aparecían con **33 bytes**, fecha anterior al vuelo, y cualquier lectura fallaba con `errno 22 (Invalid argument)`. Se repitió igual al volver a probarlos más tarde.

**Qué hace el script:** los marca como `INVALIDO EN LA CAMARA`, no los reintenta, no cuentan para el aborto por fallos seguidos, y los lista aparte en el resumen. El script termina con código `3`.

**No se pudo comprobar:** la causa. Opciones a explorar: revisar el almacenamiento desde la propia cámara o sacar la unidad y leerla en un lector.

## 4. El espacio libre que reporta el Mac es engañoso

`df /Volumes/data` mostraba **24 GiB totales y 1 GiB usado**. Ese dato corresponde a la microSD del sistema de la cámara, no al NVMe donde se guardan las imágenes (según el usuario, ~500 GB).

**Qué hacer:** consultar el espacio real en la interfaz de la propia cámara. Para estimar, sumar el tamaño de los vuelos.

## 5. El Mac no detecta la cámara

**Síntomas:** no aparece `/Volumes/data`; en *Red*, el servicio **Sentera 65R Sensor** no tiene IP ni dirección Ethernet; en USB no aparece el dispositivo.

**Diagnóstico (solo lectura):**
```bash
ioreg -p IOUSB -w0 | grep "+-o"                  # ¿aparece "Sentera 65R Sensor"?
networksetup -getinfo "Sentera 65R Sensor"       # ¿tiene IP 192.168.42.x?
ping -c 1 192.168.42.1                           # ¿responde la cámara?
nc -z -G 2 192.168.42.1 445 && echo SMB abierto  # ¿está el puerto SMB?
```

**Causas posibles (no confirmadas):** cable de solo carga, puerto USB-C o adaptador distinto, la cámara aún arrancando (esperar 1–2 minutos), o el permiso de accesorios de macOS (*Privacidad y seguridad > Permitir que se conecten accesorios*) con el Mac bloqueado. Si el USB aparece y hay IP pero no hay volumen, montar a mano:
```bash
open "smb://sentera@192.168.42.1/data"
```

No eran la causa en este caso: firewall (desactivado), VPN (ninguna), `nsmb.conf` personalizado (no existe) ni el Wi-Fi.

## 6. Borrar y expulsar

- El borrado de miles de archivos por SMB desde Finder **se trabó** (*"Eliminando IMG_0491.jpg"*). Si pasa, cancelar el diálogo antes de expulsar.
- Mientras un montaje SMB está atascado, **cualquier comando que toque `/Volumes`** (`ls /Volumes`, `df`) puede quedarse colgado en la terminal. Usar `mount | grep smbfs` (no toca el volumen) y expulsar desde Finder, o `diskutil unmount force /Volumes/data` si hace falta.
- Cmd+Supr en un disco externo manda los archivos a una papelera dentro del propio disco y **no libera espacio**; usar Cmd+Opción+Supr.

## 7. Archivos `._*` en el SSD

macOS escribe un archivo AppleDouble `._IMG_xxxx.jpg` (4096 bytes) junto a cada imagen en volúmenes exFAT cuando se copia con Finder o se abre la carpeta. No los crea el script, pero pueden molestar en software de fotogrametría. Limpiarlos con `dot_clean <carpeta>` o borrándolos; `verificar_copia.py` y `copiar_sentera.py` los ignoran.
