# Guía de uso de Clipping Studio

Esta guía explica cada pantalla y lo que pasa por dentro en cada paso. Para instalar, mira el
[README](../README.md).

- [1. La idea general](#1-la-idea-general)
- [2. Primer arranque: Ajustes](#2-primer-arranque-ajustes)
- [3. Nuevo vídeo](#3-nuevo-vídeo)
- [4. Qué hace el procesado, paso a paso](#4-qué-hace-el-procesado-paso-a-paso)
- [5. Revisar los clips (ficha del vídeo)](#5-revisar-los-clips-ficha-del-vídeo)
- [6. Marcar clips a mano](#6-marcar-clips-a-mano)
- [7. El editor](#7-el-editor)
- [8. Exportar](#8-exportar)
- [9. Plantillas de subtítulos](#9-plantillas-de-subtítulos)
- [10. Sonidos](#10-sonidos)
- [11. Actividad (cola de trabajos)](#11-actividad-cola-de-trabajos)
- [12. Cómo está hecho por dentro](#12-cómo-está-hecho-por-dentro)

---

## 1. La idea general

```
vídeo largo ──► descarga ──► transcripción ──► señales ──► la IA elige momentos ──► encuadre vertical
            ──► composición (subtítulos, gancho, efectos) ──► render de revisión ──► tú apruebas / editas
            ──► exportación por plataforma (.zip + metadata.csv)
```

- Todo corre en tu PC. El panel es una web local en http://127.0.0.1:8765 que sirve el backend (Python/FastAPI).
- Los trabajos pesados (procesar, renderizar, exportar) van a una **cola** y se hacen **de uno en uno**, porque la
  gráfica no da para dos a la vez.
- **Nada se publica solo.** La herramienta no sube nada a ninguna red: tú descargas el .zip y lo subes donde quieras.
- Cada clip es una **composición** (un JSON) que se dibuja igual en la vista previa del editor y en el render final.
  Por eso lo que ves en el editor es exactamente lo que sale.

## 2. Primer arranque: Ajustes

Abre **Ajustes** (menú izquierdo, abajo) antes de procesar el primer vídeo. Tiene cuatro pestañas:

### IA

- **Proveedor**: *Claude Code* (usa tu suscripción de Claude; mejor calidad) u *Ollama* (local y gratis).
- **Modelo y esfuerzo por tarea** (solo con Claude): cada tarea tiene un modelo recomendado (★):
  | Tarea | Recomendado | Qué hace |
  |---|---|---|
  | Restaurar puntuación | Ollama → si no está, Haiku | Pone comas y puntos a tramos de transcripción sin signos |
  | Puntuar clips marcados | Ollama → si no está, Haiku | Pone nota a los clips que marcas tú |
  | Buscar momentos | Sonnet, esfuerzo medio | Lee la transcripción entera y propone los clips |
  | Chat del editor | Sonnet, esfuerzo medio | La barra Ctrl+K del editor |
  | Otras | Sonnet, esfuerzo medio | El resto |

  Las tareas baratas van a Ollama si lo tienes abierto (no gastan cuota de Claude). Si Ollama no responde, pasan a
  Claude Haiku y la app te avisa.
- **Modelos de Claude**: el botón **Probar** hace una llamada mínima y te dice si tu cuenta tiene ese modelo.
- **Caché de respuestas**: si repites exactamente la misma petición con el mismo modelo, se reutiliza la respuesta
  guardada (no gasta). Se puede vaciar.

### Clips

- **Clips por defecto**: cuántos clips pedir por vídeo (5), duración mínima y máxima (30-60 s) y la plantilla de
  subtítulos por defecto. Cada vídeo puede cambiarlos en «Nuevo vídeo».
- **Instrucciones fijas para la IA**: tu nicho, tu público, qué buscas (máx. 2000 caracteres). Se suman a las de
  cada vídeo en todas las búsquedas de momentos. Escríbelas en inglés, como los prompts: *«Niche: personal finance.
  Prefer clips with a concrete tip or a surprising number. Avoid sponsor reads.»*
- **Efectos automáticos**: lo que la herramienta pone sola al montar cada clip (todo se puede quitar luego en el
  editor):
  - zoom suave mientras habla la persona;
  - *punch-in* (zoom seco) en los momentos fuertes;
  - cifras grandes que cuentan desde 0 cuando se dice un número;
  - emojis que entran con un pop;
  - transiciones (ninguna, algunas —una cada ~7 s como mucho— o muchas), con su whoosh;
  - movimiento de cámara sobre imágenes fijas.
- **Gancho adelantado** (*cold open*): si el inicio natural del clip es flojo, la IA elige 2-4 s potentes del propio
  clip para enseñarlos primero. Eliges la transición (destello, rebobinado tipo glitch o texto «unos segundos
  antes…») y si ese tramo se repite luego en su sitio o se quita del cuerpo.

### Vídeo y render

- **Transcripción (Whisper)**: modelo (`large-v3-turbo` por defecto), dispositivo (`cuda` = gráfica NVIDIA; `cpu` si
  no tienes) e idioma (vacío = lo detecta).
- **Calidad de descarga**: *Automática* elige según la duración (hasta 15 min: 4K; hasta 45 min: 1440p; más largo:
  1080p). Más resolución = vertical más nítido, pero más disco y más tiempo.
- **Render de revisión**: el formato con el que se renderiza la versión que revisas (YouTube Shorts por defecto) y
  la velocidad (*Rápido*, *Equilibrado*, *Máxima calidad*).

### Estado del sistema

Comprueba que encuentra FFmpeg (y si la gráfica puede codificar con NVENC), Claude Code, Ollama y sus modelos
instalados, y el entorno opcional de IA visual. Si algo sale apagado, el README explica cómo instalarlo.

## 3. Nuevo vídeo

Menú **Nuevo vídeo** (o tecla **N**).

1. **De dónde sale el vídeo**
   - *URL o ruta local*: un enlace de YouTube, TikTok o cualquier web que admita yt-dlp, o la ruta de un archivo de
     tu PC (`C:\Videos\episodio.mp4`). Con una ruta local no se copia ni se descarga nada.
   - *Subir archivo*: lo eliges con el explorador y se copia a `data/uploads/`.
2. **Tipo de clips**
   - *Clips tal cual*: los mejores momentos sueltos, que se entiendan sin el resto del vídeo.
   - *Podcast por temas*: agrupa el episodio por temas y saca el mejor momento de cada tema.
3. **¿Quién elige los clips?**
   - *La IA propone los mejores*: el procesado completo (sección 4).
   - *Los marco yo*: solo descarga y transcribe; después marcas tú los tramos (sección 6) y la IA solo los puntúa.
4. **Encuadre** (se puede cambiar por tramos en el editor):
   | Encuadre | Para qué |
   |---|---|
   | Siguiendo la cara | Una persona a cámara; el recorte vertical sigue a quien habla |
   | Automático | La herramienta decide por plano |
   | Dos personas | Podcast: pantalla partida, un panel por persona |
   | Gaming | Cámara del streamer arriba y juego abajo |
   | Vídeo entero con fondo difuminado | No recorta nada |
   | Vídeo entero con bandas negras | No recorta; subtítulos debajo |
5. **Avanzado** (desplegable): calidad de descarga, número de clips, qué IA usar en este vídeo, formato de salida
   (9:16, 1:1, 4:5, 16:9), plantilla de subtítulos y su posición/tamaño con vista previa, gancho en pantalla,
   duraciones y **instrucciones para la IA** solo para este vídeo (en inglés: *«Focus on the funniest moments»*,
   *«Avoid the sponsor segment»*…).
6. **Permiso**: escribe de dónde viene el permiso para usar el vídeo (es tuyo, el creador te autorizó, licencia…).
   Es obligatorio y se guarda con el vídeo.
7. **Procesar**. Te lleva a la ficha del vídeo, donde ves el progreso en directo.

## 4. Qué hace el procesado, paso a paso

Lo que ves en la barra de progreso de la ficha corresponde a estos pasos (código en
`backend/clipping/pipeline/process.py`):

1. **Descarga** (`pipeline/download.py`): yt-dlp baja el vídeo a `data/sources/<id>/` en la calidad elegida. Si viene
   en AV1, VP9 o HEVC (lo normal en el 4K de YouTube), se hace una copia H.264 con la gráfica, porque si no el render
   va unas diez veces más lento.
2. **Transcripción** (`pipeline/transcribe.py`): faster-whisper transcribe **palabra a palabra** con tiempos. Si hay
   tramos largos sin signos de puntuación, un modelo barato los restaura (tarea «Restaurar puntuación»).
   Si elegiste *Los marco yo*, el procesado termina aquí.
3. **Señales sin IA** (`pipeline/signals.py`, `pipeline/heatmap.py`): picos de volumen (risas, gritos, golpes),
   cambios de plano (filtro de escenas de FFmpeg), ritmo del habla y, si es de YouTube, el «lo más reproducido»
   (las partes que la gente vuelve a ver).
4. **Idea del vídeo**: la IA lee la transcripción entera y escribe de qué va el vídeo y qué sería un buen momento.
   Se guarda y puedes corregirla (sección 5).
5. **Búsqueda de momentos** (`pipeline/moments.py`): la IA propone candidatos y los puntúa todos con la misma rúbrica:
   gancho, tensión, emoción, si se entiende solo y si es citable. A esa nota se suman las señales del paso 3. Una
   **segunda pasada** repesca descartados que tenían buenas señales. También tiene en cuenta lo que aprobaste y
   descartaste en vídeos anteriores, para parecerse a tu criterio.
6. **Encuadre** (`pipeline/reframe.py`, `pipeline/diarize.py`, `pipeline/camera.py`): detecta caras con YuNet; en
   «Dos personas» averigua quién habla en cada momento (diarización local con sherpa-onnx) para saber qué panel es
   cuál; detecta los cortes de cámara del original para reencuadrar cada plano por separado.
7. **Composición** (`pipeline/compose.py`, `fxauto.py`, `opening.py`): monta cada clip: tramos de vídeo, subtítulos
   animados con la plantilla elegida, gancho en pantalla, gancho adelantado y efectos automáticos.
8. **Filtros de calidad** (`quality.py`): avisa de silencios largos, subtítulos fuera de la zona segura de cada
   plataforma, volumen demasiado alto o bajo, inicio flojo, música tapando la voz…
9. **Render de revisión** (`pipeline/remotion.py`): Remotion dibuja cada clip en un Chrome sin ventana y FFmpeg lo
   codifica. Ese MP4 es el que ves al revisar.

## 5. Revisar los clips (ficha del vídeo)

En **Vídeos** haz clic en un vídeo. La ficha tiene cuatro pestañas:

- **Clips**: cada clip con su vídeo, su nota (*potencial viral* estimado), el **porqué** y de dónde sale (propuesto
  por la IA, entrado por sus señales, rescatado por la segunda pasada, o marcado por ti). Con más de tres clips hay un
  filtro «Ver». Acciones de cada clip:
  - **Aprobar**: pasa a la lista de Exportar.
  - **Descartar**: se aparta (y cuenta para que la IA aprenda tu criterio).
  - **Editar**: lo abre en el editor.
  - **SRT**: descarga sus subtítulos como archivo aparte.

  Encima está **«Descartados por la IA»**: todo lo que se quedó fuera de la última búsqueda, con su motivo. Un clic lo
  **rescata** y se convierte en clip.
- **Momentos**: el estado de la búsqueda y cuántos clips propuso.
- **Calidad**: las notas de los filtros de calidad (miran el plan y el MP4). Pulsa una nota para ver el detalle y lo
  que conviene cambiar.
- **Idea del vídeo**: lo que la IA entendió del vídeo. Si se ha equivocado, corrígelo (de qué va, qué es un buen
  momento) y pulsa volver a buscar: la búsqueda de momentos se repite con tu versión.

En **Vídeos** también está el panel **«Acierto de la IA eligiendo momentos»**: cuántas de sus propuestas apruebas y
cuántos momentos marcas tú que ella no vio. Desde un vídeo con clips marcados a mano puedes lanzar **«Probar a la IA
con tus clips»**: busca momentos como si no los conociera y compara con los tuyos (gasta IA).

## 6. Marcar clips a mano

Desde la ficha del vídeo, **Marcar clips**. Verás la forma de onda (con lo más reproducido en naranja, si hay) y la
transcripción.

- **Arrastra sobre la transcripción** para seleccionar frases, o **arrastra sobre la onda**, o usa **I** (entrada) y
  **O** (salida) mientras lo escuchas.
- **Espacio** reproduce; **← / →** mueven 1 s (**Mayús** 5 s). Clic en una palabra salta ahí.
- «No cortar palabras a medias» ajusta los bordes a las palabras. Se recomiendan clips de 15-60 s.
- Cada tramo puede llevar título; si lo dejas vacío lo propone la IA.
- Al terminar, la IA puntúa tus clips y se renderizan como los demás.

## 7. El editor

Se abre desde **Editar** en un clip o desde el menú **Editor**. Se guarda con **Ctrl+S**; **Ctrl+Z / Ctrl+Mayús+Z**
deshacen y rehacen.

### Zonas de la pantalla

- **Izquierda, Biblioteca y Capas**: en *Biblioteca* añades cosas (textos, imágenes, vídeos, audio, sonidos,
  plantillas animadas, bloques HyperFrames, efectos y transiciones; los archivos tuyos se suben aquí). En *Capas* ves
  la lista de todo lo que hay en el clip. El botón del panel la oculta para ver el visor más grande.
- **Centro, visor**: la vista previa exacta del render. Algunos elementos se arrastran directamente sobre ella
  (destino de un zoom, máscaras, posición de textos).
- **Abajo, línea de tiempo**: tramos del vídeo original, pistas de capas, efectos, audio y marcadores. Herramientas:
  mover (**V**), cuchilla (**C**), rodillo (**R**), *slip* (**Y**), *slide* (**U**); **S** divide en el cursor,
  **Z** pone un zoom, **M** un marcador, **N** activa el imán, **Supr** borra y junta.
- **Derecha, inspector**: las propiedades de lo que tengas seleccionado, en seis pestañas:
  | Pestaña | Qué tiene |
  |---|---|
  | **Plano** | Velocidad, congelar imagen, rampas de velocidad y marcha atrás, cortes J/L |
  | **Cámara** | Encuadre del tramo por fotogramas clave (paneos de A a B, zoom), seguir la cara o a quien habla, seguir un punto, multicámara (ángulos; **A** cambia de ángulo) |
  | **Texto** | Gancho en pantalla, subtítulos (plantilla, posición, estilo por palabra) y la transcripción para **cortar por palabras** |
  | **Audio** | Volumen del tramo, voz limpia (RNNoise), la pista elegida y la **mezcla** con curvas de volumen y *ducking* (bajar la música cuando hay voz) |
  | **Color** | Looks, LUT `.cube`, capas de ajuste de color y scopes |
  | **Efectos** | La capa o el efecto elegido: textos, imágenes, zooms, transiciones (barrido, zoom, destello, glitch, desenfoque…) |

### Barra de comandos con IA (Ctrl+K)

Escribe lo que quieres en lenguaje normal: *«quita los silencios»*, *«pon un zoom en la frase clave»*, *«haz un
punch-in en el segundo 3 y quita la música»*. La IA lee la composición y la transcripción, propone cambios concretos y
los aplica; se deshacen con Ctrl+Z como cualquier otro cambio.

### IA visual (solo con el entorno opcional `ml/`)

- **Recortar sujeto**: separa a la persona del fondo (SAM 2.1) para poner texto o un fondo detrás.
- **Seguir un punto**: marcas un objeto y el encuadre o una capa lo siguen.
- **Buscar objetos**: localiza un objeto descrito con palabras (Grounding DINO).

### Atajos

El botón **Atajos…** muestra todos y deja cambiarlos (se guardan en tu navegador).

## 8. Exportar

Menú **Exportar**. Aparecen los clips aprobados (de este vídeo o de todos).

1. Elige los clips.
2. Elige la plataforma: YouTube Shorts, TikTok, Instagram Reels, YouTube 16:9, Cuadrado 1:1 o Feed 4:5.
3. Ajusta si quieres resolución, fps, códec (H.264 compatible con todo, o H.265 que ocupa menos), calidad, volumen
   objetivo (‑14 LUFS por defecto) y el nombre de archivo (`{id}` y `{title}` se cambian por los de cada clip).
4. Se renderiza cada clip a esa medida y se empaqueta en un **.zip** con un **`metadata.csv`**: archivo, título,
   gancho, motivo, hashtags, puntuación, segundo de inicio y de fin en el vídeo original.
5. **Descargar .zip** o **Abrir carpeta** (`data/exports/`). Los subtítulos se bajan aparte en SRT desde la ficha del
   vídeo.

## 9. Plantillas de subtítulos

Menú **Plantillas**. Subtítulos palabra a palabra con la palabra activa resaltada. Puedes crear, duplicar, editar y
borrar plantillas: fuente (Google Fonts incluidas o las de Windows), tamaño, mayúsculas, colores, contorno, sombra,
palabras por bloque, animación, cómo se resalta la palabra activa (color, subrayado o caja de color) y el estilo del
gancho que aparece arriba al empezar. Cada plantilla se ve en una muestra animada. En Ajustes eliges la de por defecto y en el editor la cambias por clip.

## 10. Sonidos

Menú **Sonidos**. La librería que usan el editor y los efectos automáticos (whoosh en transiciones, pops…).

- **Sintetizados**: la primera vez la herramienta genera una serie básica (whoosh, pop, ding, boom, riser, clics…).
  Son 100 % propios.
- **Tu galería**: una carpeta tuya con subcarpetas por categoría. Se importa a `data/sfx/pack/` y, mientras exista, la
  IA usa solo esa galería. Al volver a importar se mantienen tus cambios de nombre, carpeta e intención.
- **Paquetes**: un .zip o una carpeta, por ejemplo los packs CC0 de [Kenney](https://kenney.nl/assets/category:Audio).
- **Tuyos**: sube un archivo e indica su licencia.
- **Buscar con palabras**: *«cristal rompiéndose»*, *«whoosh largo y grave»*. Busca en tu librería y, si es algo
  simple, lo sintetiza.

Cada sonido guarda su licencia. Revísala antes de usarlo en vídeos monetizados.

## 11. Actividad (cola de trabajos)

Menú **Actividad**. Lo que está en marcha, lo que espera y lo terminado hace poco. Puedes **parar** el trabajo en
marcha, **pausar** la cola, **cambiar el orden** (subir, bajar, poner el primero) o **quitar** uno que espera. Cada
trabajo muestra sus pasos: qué proceso o modelo corrió, cuánto tardó y cuántos tokens gastó. Abajo a la izquierda del
panel hay un resumen siempre visible.

## 12. Cómo está hecho por dentro

| Parte | Tecnología | Dónde |
|---|---|---|
| Servidor y API | Python 3.12, FastAPI, SQLModel (SQLite) | `backend/clipping/api.py`, `db.py` |
| Cola de trabajos | hilo propio, uno a la vez | `backend/clipping/worker.py`, `jobctl.py` |
| Proveedores de IA | `claude -p` (Claude Code sin interfaz) y la API local de Ollama | `backend/clipping/llm/` |
| Pipeline | yt-dlp, faster-whisper, OpenCV + YuNet, sherpa-onnx, FFmpeg | `backend/clipping/pipeline/` |
| Panel | React 19 + Vite + TypeScript | `frontend/src/pages/`, `frontend/src/editor/` |
| Composición y render | Remotion 4 (`@remotion/player` en el editor, `@remotion/renderer` al renderizar) | `frontend/src/remotion/`, `frontend/render.mjs` |
| IA visual opcional | PyTorch, SAM 2.1, Grounding DINO, como procesos aparte | `ml/` |

Cómo llama a Claude Code: cada petición lanza `claude -p --output-format json` en una carpeta temporal vacía, sin
herramientas (solo lectura de imágenes cuando hace falta), sin MCP y sin guardar la sesión. No toca tus proyectos ni
tu configuración de Claude.

Dónde se guardan los datos (todo en `data/`, que **no** se sube a git):

```
data/
  app.db              base de datos: vídeos, clips, plantillas, trabajos
  settings.json       tus ajustes
  sources/<id>/       vídeo descargado, transcripción, señales, idea del vídeo
  clips/<id>/         render de revisión y archivos de cada clip
  uploads/  assets/   lo que subes (vídeos, imágenes, audio)
  sfx/                librería de sonidos
  exports/            los .zip exportados
  models/             modelos descargados (Whisper, YuNet, diarización, RNNoise)
  hyperframes/        catálogo de bloques animados
  llm_cache/          respuestas de la IA guardadas
  llm_usage.jsonl     contador de llamadas a la IA
  logs/app.log        registro de la app
```

Para empezar de cero, cierra la herramienta y borra la carpeta `data/` (perderás todos tus vídeos y clips).
