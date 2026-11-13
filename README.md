# Clipping Studio

Herramienta local (Windows) para sacar **clips verticales de vídeos largos** (podcasts, directos, entrevistas, vídeos de
YouTube) y retocarlos en un **editor de vídeo** completo. Todo corre en tu PC y se maneja desde un panel web en
http://127.0.0.1:8765. Nada se publica solo: tú revisas, apruebas y exportas.

## Qué hace

1. **Nuevo vídeo**: pegas una URL (YouTube, TikTok… lo que admita [yt-dlp](https://github.com/yt-dlp/yt-dlp)), la ruta
   de un archivo de tu PC o lo subes. Eliges el tipo de clips, el encuadre y los subtítulos.
2. **Procesado automático**:
   - descarga con yt-dlp y prepara una copia fácil de editar;
   - transcribe palabra a palabra con [faster-whisper](https://github.com/SYSTRAN/faster-whisper) (en la GPU) y
     restaura la puntuación con la IA;
   - busca los mejores momentos: la IA lee la transcripción entera, escribe la «idea del vídeo» y puntúa cada
     candidato con una rúbrica (gancho, tensión, emoción, si se entiende solo, si es citable). A la nota se suman
     señales sin IA: picos de volumen, cambios de plano, ritmo del habla y lo más visto del vídeo (el «heatmap» de
     YouTube). Una segunda pasada repesca lo que se descartó con buenas señales;
   - encuadra en vertical: sigue la cara de quien habla (detector YuNet), pantalla partida para dos personas
     (con diarización local de quién habla), cámara + juego para gaming, o vídeo entero con fondo difuminado;
   - monta cada clip como una composición de [Remotion](https://www.remotion.dev) con subtítulos animados, gancho
     en pantalla, gancho adelantado y efectos automáticos (zooms, punch-in, cifras, transiciones con whoosh);
   - pasa unos filtros de calidad (silencios, subtítulos fuera de la zona segura, volumen…).
3. **Marcar clips a mano**: sobre la forma de onda y la transcripción, si prefieres elegir tú los momentos (la IA los
   puntúa igualmente).
4. **Revisar**: cada clip con su nota, el porqué y su vídeo. Apruebas, descartas, rescatas descartados o lo abres en el
   editor.
5. **Editor**: línea de tiempo con varios tramos y pistas, encuadre por fotogramas clave (paneos, rampas, seguir un
   punto), multicámara, subtítulos con estilos por palabra, capas de texto, imágenes y vídeo, plantillas animadas,
   efectos y transiciones, color (looks, LUT .cube, scopes), máscaras, mezcla de audio con curvas de volumen y
   ducking, voz limpia (RNNoise), recorte del sujeto, atajos de teclado configurables, deshacer/rehacer y una barra
   de comandos con IA (**Ctrl+K**: «quita los silencios», «pon un zoom en la frase clave»…).
6. **Exportar**: los clips aprobados, a la medida de cada plataforma (Shorts, TikTok, Reels, 16:9, 1:1, 4:5), en un
   .zip con un `metadata.csv`.

La IA es intercambiable: **Claude Code** (mejor calidad, usa tu suscripción de Claude) u **Ollama** (local y gratis,
más flojo). En Ajustes eliges el modelo de cada tarea.

> 📖 **Guía de uso detallada**, pantalla por pantalla y con lo que pasa por dentro en cada paso:
> [docs/GUIA.md](docs/GUIA.md).

## 1. Qué necesitas

- **Windows 10 u 11.**
- **Tarjeta gráfica NVIDIA** (recomendado 8 GB de VRAM o más) con el driver al día. Sin GPU funciona, pero la
  transcripción va en la CPU y es mucho más lenta (en Ajustes → Vídeo y render, dispositivo «CPU»).
- **Unos 15 GB libres** (más lo que ocupen tus vídeos). El entorno opcional de IA visual añade unos 5 GB.
- **Para la IA**, una de estas dos:
  - una suscripción de Claude (Pro o Max) para **Claude Code**, o
  - **Ollama** con un modelo local (gratis).

## 2. Instalar los programas (una sola vez)

### Driver de la gráfica

Si tienes una NVIDIA, instala o actualiza el driver desde https://www.nvidia.com/drivers (o con la app NVIDIA).
No hace falta instalar CUDA aparte: las librerías de CUDA y cuDNN que usa la transcripción vienen como paquetes de
Python (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`) y se instalan solas en el paso 4.

### Programas base

Abre **PowerShell** (botón Inicio → escribe «PowerShell») y ejecuta estas líneas una a una. Si alguna ya la tienes,
`winget` te lo dirá y no pasa nada.

```powershell
winget install --id Git.Git -e
winget install --id astral-sh.uv -e
winget install --id OpenJS.NodeJS.LTS -e
winget install --id Gyan.FFmpeg -e
```

- **Git**: para descargar el proyecto.
- **uv**: instala Python 3.12 y las librerías del backend dentro del proyecto (no toca el Python de tu sistema).
- **Node.js**: para el panel y para renderizar con Remotion.
- **FFmpeg**: para cortar, convertir y medir audio y vídeo.

**Cierra PowerShell y abre uno nuevo** para que Windows encuentre los programas recién instalados. Comprueba que
están todos (cada línea debe responder con un número de versión):

```powershell
git --version
uv --version
node --version
ffmpeg -version
```

### IA: Claude Code (recomendado)

```powershell
irm https://claude.ai/install.ps1 | iex
```

**Cierra PowerShell y abre uno nuevo**, y después inicia sesión una vez con tu cuenta de Claude:

```powershell
claude
```

Sigue los pasos en el navegador y, cuando veas el chat en la terminal, ciérralo con `/exit`.

### IA: Ollama (opcional, local y gratis)

```powershell
winget install --id Ollama.Ollama -e
ollama pull qwen3.5:9b
```

`qwen3.5:9b` es el modelo que la herramienta espera por defecto; puedes usar otro. Luego, en la app, ve a
**Ajustes → IA**, elige Ollama y escribe el nombre exacto del modelo que descargaste.

## 3. Descargar el proyecto

```powershell
git clone https://github.com/ClaushDev/clipping-dashboard.git C:\ClippingStudio
cd C:\ClippingStudio
```

Mejor una ruta corta y sin espacios. Sin Git también vale: en GitHub, **Code → Download ZIP** y descomprímelo.

## 4. Arrancar

Doble clic en **`Iniciar.bat`**. La primera vez tarda unos minutos porque:

- instala Python 3.12 dentro del proyecto (carpeta `.python/`) y las librerías del backend con `uv sync`, en las
  versiones exactas de `backend/uv.lock` (FastAPI, faster-whisper, yt-dlp, OpenCV, sherpa-onnx, CUDA/cuDNN…);
- instala las dependencias del panel y lo compila (`npm install` y `npm run build` en `frontend/`): React, Vite y
  Remotion, en las versiones de `frontend/package-lock.json`.

Si prefieres hacerlo a mano (o el `.bat` falla y quieres ver el error):

```powershell
cd C:\ClippingStudio\backend
uv python install 3.12
uv sync
cd ..\frontend
npm install
npm run build
cd ..
.\Iniciar.bat
```

Después se abre el navegador en http://127.0.0.1:8765. **No cierres la ventana negra** mientras trabajas: es la que
mantiene la herramienta en marcha.

Opciones: `start.ps1 -NoBrowser` (no abre el navegador) y `start.ps1 -Port 8766` (otro puerto).

### Lo que se descarga solo la primera vez que hace falta

| Qué | Para qué | Dónde queda |
|---|---|---|
| Modelo de Whisper (`large-v3-turbo` por defecto, ~1,6 GB) | Transcribir | `data/models/whisper/` |
| YuNet (detector de caras de OpenCV Zoo, MIT) | Seguir la cara | `data/models/` |
| pyannote segmentation 3.0 + WeSpeaker ResNet34 (ONNX de sherpa-onnx) | Saber quién habla (pantalla partida) | `data/models/diarization/` |
| RNNoise «somnolent-hogwash» (arnndn-models) | Voz limpia en el editor | `data/models/rnnoise/` |
| Navegador Chrome headless de Remotion | Renderizar | carpeta de Remotion |
| Catálogo de bloques HyperFrames | Bloques animados del editor (opcional) | `data/hyperframes/` |

## 5. IA visual (opcional)

Activa en el editor **«Recortar sujeto»** (texto o fondo detrás de la persona), **«Seguir un punto»** y
**«Buscar objetos»**. Usa SAM 2.1 (`facebook/sam2.1-hiera-small`) y Grounding DINO
(`IDEA-Research/grounding-dino-tiny`) con PyTorch en la GPU. Unos 3-4 GB de descarga:

```powershell
powershell -ExecutionPolicy Bypass -File ml\setup.ps1
```

Instala sus versiones exactas desde `ml/uv.lock` en `ml/.venv`. Sin él, todo lo demás funciona igual. El estado sale
abajo a la izquierda del panel («IA visual»).

### Resumen de dependencias

| Pieza | Cómo se instala | Obligatoria |
|---|---|---|
| Git, uv, Node.js LTS, FFmpeg | `winget` (paso 2) | Sí |
| Driver NVIDIA | web o app de NVIDIA | Recomendada |
| Python 3.12 + librerías del backend | `Iniciar.bat` (o `uv sync` en `backend/`) | Sí |
| Librerías del panel y Remotion | `Iniciar.bat` (o `npm install` en `frontend/`) | Sí |
| Claude Code **o** Ollama + modelo | paso 2 | Una de las dos |
| Modelos de Whisper, caras, diarización, RNNoise, Chrome de Remotion | se descargan solos al usarlos | Sí (automático) |
| IA visual (PyTorch, SAM 2.1, Grounding DINO) | `ml\setup.ps1` | No |

## Problemas frecuentes

- **«No se encuentra uv / Node.js / ffmpeg»**: cierra todas las ventanas de PowerShell y abre una nueva; si sigue,
  reinstala con el `winget` del paso 2.
- **La transcripción falla con un error de CUDA o cuDNN**: actualiza el driver de NVIDIA. Si no tienes NVIDIA, en
  **Ajustes → Vídeo y render** pon el dispositivo de Whisper en «CPU».
- **«Claude Code no ha iniciado sesión»**: abre PowerShell, ejecuta `claude`, inicia sesión y sal con `/exit`.
- **Ollama no responde**: ábrelo desde el menú Inicio, o en **Ajustes → IA** usa Claude Code.
- **El puerto 8765 está ocupado**: arranca con `powershell -ExecutionPolicy Bypass -File start.ps1 -Port 8766`.
- **Algo ha fallado y no sabes qué**: mira `data\logs\app.log` y la pantalla **Actividad**.

## 6. Uso rápido

1. **Nuevo vídeo** (o tecla **N**): pega la URL, elige el tipo de clips y el encuadre, escribe de dónde viene el
   permiso para usar el vídeo y pulsa **Procesar**.
2. En **Vídeos** ves el progreso; al terminar, abre el vídeo para revisar los clips.
3. **Aprobar / Descartar / Editar** cada clip. En «Idea del vídeo» puedes corregir de qué va y qué es un buen momento,
   y volver a buscar.
4. **Exportar** los aprobados para cada plataforma y descargar el .zip.

Atajos del editor: el botón **Atajos…** muestra la lista y deja cambiarlos; **Ctrl+K** abre la barra de comandos con
IA; **Ctrl+S** guarda.

## 7. Dónde se guardan las cosas

Todo va en la carpeta **`data/`** del proyecto (no se sube a git): base de datos (`app.db`), vídeos descargados,
clips, exportaciones, sonidos, modelos y registros (`data/logs/app.log`). Para usar otra carpeta, define la variable de
entorno `CLIPPING_DATA` antes de arrancar.

Los efectos de sonido (whoosh, pops…) se gestionan en **Sonidos**: puedes importar tu propia galería o un paquete
(.zip o carpeta). Revisa los derechos de cada sonido antes de publicarlo.

## 8. Para desarrollar

```powershell
# backend (FastAPI) con recarga
cd backend
uv sync
uv run uvicorn clipping.api:app --port 8765 --reload

# frontend (Vite) con recarga; reenvía /api y /media al backend
cd frontend
npm install
npm run dev

# tests y tipos
cd backend; uv run pytest -q
cd frontend; npx tsc -b
```

Estructura:

```
backend/clipping/        API (api.py), cola de trabajos (worker.py), base de datos (db.py), ajustes (config.py)
backend/clipping/pipeline/  descarga, transcripción, momentos, encuadre, composición y render
backend/clipping/llm/    proveedores de IA (Claude Code y Ollama) y el reparto de modelos por tarea
frontend/src/pages/      pantallas del panel
frontend/src/editor/     el editor
frontend/src/remotion/   la composición (schema.ts) y cómo se dibuja (Main.tsx); la usan el editor y el render
ml/                      entorno opcional de IA visual (SAM 2, Grounding DINO)
```

Cada clip es una composición JSON (`frontend/src/remotion/schema.ts`); si cambias el esquema, actualiza también
`backend/clipping/pipeline/compose.py`.

## 9. Privacidad: qué sale de tu PC

No hay telemetría ni cuentas propias de la herramienta: todo se guarda en `data/`. Lo único que sale a internet es:

- **Con Claude Code como IA**: la transcripción de cada vídeo y tus instrucciones se envían a Anthropic con tu
  cuenta de Claude (como cualquier uso de Claude Code). Con **Ollama** todo se queda en tu PC.
- **Descargas**: el vídeo (yt-dlp), los modelos de la primera vez (tabla del paso 4), las fuentes de Google Fonts de
  los subtítulos, el catálogo de bloques HyperFrames y las librerías que piden esos bloques (desde jsDelivr y
  similares, una vez, y quedan guardadas).

## 10. Uso responsable

La herramienta pide, para cada vídeo, **de dónde viene el permiso** para usarlo. Úsala con vídeos propios, con
autorización del creador o con licencias que lo permitan. Descargar contenido de plataformas puede ir contra sus
condiciones de uso.

## 11. Licencias

El código de este repositorio es **MIT** (ver [LICENSE](LICENSE)). Las piezas de terceros tienen la suya:


- **Remotion** tiene su propia licencia: gratis para personas y empresas pequeñas; las empresas a partir de cierto
  tamaño necesitan una licencia de empresa. Consulta https://www.remotion.dev/license antes de usarla con fines
  comerciales.
- **yt-dlp** (Unlicense), **faster-whisper** (MIT), **FFmpeg** (LGPL/GPL según la compilación), **OpenCV** y **YuNet**
  (Apache 2.0 / MIT), **sherpa-onnx** (Apache 2.0) y los modelos pyannote/WeSpeaker que publica, **arnndn-models**
  (RNNoise).
- `backend/clipping/ytkit/`: herramientas portadas de
  [youtube-agent-skill](https://github.com/Jakeschincariol/youtube-agent-skill) (MIT, ver
  `LICENSE-youtube-agent-skill`).
- Bloques animados de [HyperFrames](https://github.com/heygen-com/hyperframes): se descargan desde su repositorio;
  revisa su licencia.
- Modelos opcionales de `ml/`: SAM 2.1 (Apache 2.0) y Grounding DINO (Apache 2.0).
