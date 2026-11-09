# Bitácora: cómo se hizo

Resumen cronológico de cómo se llegó al script y qué se comprobó en cada paso.

## 1. Diagnóstico de lo ya copiado

Se revisó en el SSD qué vuelos se habían copiado bien con Finder. Sin acceso a la cámara solo se puede comprobar **integridad**:

- carpetas vacías o con archivos de 0 bytes,
- cantidad de imágenes y huecos en la numeración `IMG_0001 … IMG_N`,
- cabecera `FFD8` y final `FFD9` de cada JPEG.

Detalle técnico importante: la Sentera rellena con bytes `0xFF` **después** de `FFD9`. Una primera comprobación de "termina en FFD9" marcó casi todo como dañado; hay que quitar el relleno `0xFF` final antes de comprobar. Con eso apareció un único truncado real (un JPG de exactamente 24 MiB).

## 2. Diseño del script

Objetivos: no usar Finder, no tocar la cámara y no confiar en que "copió sin error" significa "copió bien".

Decisiones:
- **Solo lectura en el origen.** No existe ninguna operación de borrado, movimiento o renombrado sobre la cámara.
- **`.part` + renombrado atómico**, para que nunca exista un JPG a medias con nombre válido.
- **Releer lo escrito sin caché** (`F_NOCACHE`) y vaciar a disco con `F_FULLFSYNC`; de lo contrario la verificación leería de la caché de memoria y no probaría nada.
- **SHA-256** calculado mientras se lee la cámara y comparado con el del archivo releído del destino.
- **Reanudable:** salta lo que ya está bien (tamaño igual y JPEG completo) y reemplaza lo truncado, vacío o dañado. `--verify-existing` agrega comparación por hash.
- **Reintentos** con espera, y **aborto tras 5 fallos seguidos** para no machacar un cable o cámara caídos.
- **Evitar archivos `._*`:** se escribe con `open()`, sin copiar atributos extendidos (no usar `cp -p`, `ditto` ni `shutil.copystat`).
- **`caffeinate`** para que el Mac no se suspenda a mitad de una copia de decenas de GB.
- **Manifiesto SHA-256 y log** de cada ejecución.

## 3. Pruebas antes de usarlo con la cámara real

Se probó con una cámara simulada en `/tmp` (imágenes aleatorias con cabecera y cola JPEG, una carpeta de vuelo vacía, un archivo `._*` y un hueco en la numeración):

| Prueba | Resultado esperado |
|---|---|
| Copia normal | 5 de 5 copiados, estructura correcta, `._*` ignorado |
| Destino truncado + destino de 0 bytes + `.part` huérfano | Se reemplazan los dos archivos y se quita el `.part` |
| Un byte alterado con el mismo tamaño | Solo lo detecta `--verify-existing` |
| Archivo de origen ilegible (permisos 000) | 3 reintentos, queda como fallido, sigue con los demás, sin `.part` sobrante |
| Hash del origen antes y después | Idéntico: la fuente no se modificó |

Un fallo real encontrado en las pruebas: `caffeinate` heredaba la salida del script y dejaba colgada la consola; se arregló redirigiendo su salida a `/dev/null`.

## 4. Copia con la cámara real y hallazgos

Se copiaron vuelos de ~1.5 a ~1.8 mil imágenes (30–55 GB cada uno) a 55–70 MB/s, siempre con el script en segundo plano y vigilando el log.

1. **Aborto por fallos seguidos.** El primer vuelo con entradas ilegibles hizo fallar 5 archivos seguidos y el script abortó, lo que habría dejado sin copiar el vuelo siguiente. Se añadió la categoría `INVALIDO EN LA CAMARA` (no se reintenta ni cuenta para el aborto) y el código de salida `3`.
2. **Tamaño falso de 33 bytes.** Al copiar otro vuelo, 19 archivos fallaron una vez con *"se leyeron N bytes de 33"* y pasaron en el reintento. Al releer los 16 marcados como inválidos en ese vuelo resultaron ser JPG completos de ~31 MB. Se corrigió la clasificación para no fiarse del tamaño informado (ver `PROBLEMAS_Y_SOLUCIONES.md`) y se relanzó: omitió los 1470 ya verificados y copió los 16 que faltaban.
3. **Los 96 archivos de otros dos vuelos siguen ilegibles** (`errno 22`) al volver a probarlos.

## 5. Verificación independiente

Para cada vuelo se corrió una segunda comprobación aparte del script (hoy `verificar_copia.py`):

- número exacto de imágenes y numeración sin huecos,
- sin `.part`, sin archivos de 0 bytes,
- todos los JPG completos,
- mismo tamaño que en la cámara,
- SHA-256 de las imágenes releídas del SSD contra el manifiesto: coincidieron todas.

## 6. Espacio de la cámara y conexión

- El espacio libre que reporta el Mac por SMB corresponde a la microSD del sistema, no al NVMe de datos.
- Para diagnosticar por qué el Mac no veía la cámara se revisó USB (`ioreg`), el servicio de red "Sentera 65R Sensor" (`networksetup`), la IP de la cámara (`192.168.42.1`), el puerto SMB 445 y la configuración de SMB/firewall/VPN. Ver `PROBLEMAS_Y_SOLUCIONES.md`.

## Pendiente / ideas

- Averiguar la causa de los bloques de archivos ilegibles (probar leer la unidad en un lector).
- Los archivos que el script omite por estar ya bien copiados **no quedan en el manifiesto** salvo que se use `--verify-existing` (que sí los compara por hash y los anota). Para vuelos copiados antes con Finder, conviene correr una vez con `--verify-existing` para dejar su manifiesto.
