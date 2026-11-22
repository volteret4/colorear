# Láminas para colorear

Web estática (GitHub Pages) para montar un PDF con láminas sueltas de varios libros de colorear escaneados, con botón aleatorio.

Las imágenes **no están en el repositorio**: la web las lee de una carpeta de MEGA (o de una carpeta local) cuyo enlace se guarda solo en el navegador.

## Preparar las láminas

```bash
python3 tools/preparar.py /ruta/a/los/pdf /ruta/salida/colorear-web
```

Necesita `pdftoppm` (poppler) y Pillow. Genera `index.json`, una carpeta por libro con `pNNN.jpg` y `thumbs.jpg`. Se puede relanzar: salta los libros ya hechos.

Sube la carpeta de salida a MEGA, crea un enlace de carpeta y pégalo en la web. También se puede abrir con `#mega=<enlace>` al final de la URL.
