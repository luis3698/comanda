#!/usr/bin/env bash
#
# Arranca SIGR entero: servidor, puente al móvil, app.
#
# POR QUÉ EXISTE
# La secuencia manual son siete comandos, y basta con que uno falle en silencio
# para acabar con la app en «No disponible ahora mismo» sin ninguna pista de por
# qué. El caso real que motivó esto: con el móvil conectado a la vez por cable y
# por depuración inalámbrica, `adb reverse` falla con «more than one device», el
# error se pierde entre la salida de Docker y la de Gradle, y la app se queda sin
# puente.
#
# Aquí cada paso se COMPRUEBA y, si falla, el guion se para y dice qué hacer.
#
# Uso:   cd movil && ./arrancar.sh
#        ./arrancar.sh --sin-compilar     (solo servidor y puente; no toca el APK)
#
set -euo pipefail

SIN_COMPILAR=0
[[ "${1:-}" == "--sin-compilar" ]] && SIN_COMPILAR=1

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MOVIL="$RAIZ/movil"

# Colores solo si la salida es una terminal: redirigido a un archivo, los códigos
# de escape solo estorban.
if [[ -t 1 ]]; then
    ROJO=$'\033[31m'; VERDE=$'\033[32m'; AMARILLO=$'\033[33m'; NEGRITA=$'\033[1m'; FIN=$'\033[0m'
else
    ROJO=''; VERDE=''; AMARILLO=''; NEGRITA=''; FIN=''
fi

paso()  { echo ""; echo "${NEGRITA}▶ $1${FIN}"; }
bien()  { echo "  ${VERDE}✓${FIN} $1"; }
aviso() { echo "  ${AMARILLO}!${FIN} $1"; }

# Todo error sale por aquí: mensaje de qué pasó y, debajo, qué hacer.
morir() {
    echo ""
    echo "${ROJO}${NEGRITA}✗ $1${FIN}"
    shift
    for linea in "$@"; do echo "  $linea"; done
    echo ""
    exit 1
}

# =====================================================================
# 1 · Herramientas
# =====================================================================
paso "Comprobando herramientas"

# adb no suele estar en el PATH en Windows; se busca donde lo pone el SDK.
if ! command -v adb >/dev/null 2>&1; then
    for candidato in \
        "${ANDROID_HOME:-}/platform-tools" \
        "${ANDROID_SDK_ROOT:-}/platform-tools" \
        "$HOME/AppData/Local/Android/Sdk/platform-tools" \
        "$HOME/Library/Android/sdk/platform-tools" \
        "$HOME/Android/Sdk/platform-tools"
    do
        if [[ -n "$candidato" && -x "$candidato/adb" || -x "$candidato/adb.exe" ]]; then
            export PATH="$PATH:$candidato"
            break
        fi
    done
fi

command -v adb >/dev/null 2>&1 || morir \
    "No encuentro 'adb'." \
    "Está en la carpeta platform-tools de su SDK de Android. Añádala al PATH:" \
    "" \
    "    export PATH=\"\$PATH:\$HOME/AppData/Local/Android/Sdk/platform-tools\""
bien "adb"

command -v docker >/dev/null 2>&1 || morir \
    "No encuentro 'docker'." \
    "Instale Docker Desktop y ábralo."
bien "docker"

if [[ $SIN_COMPILAR -eq 0 ]]; then
    if [[ -z "${JAVA_HOME:-}" ]]; then
        # El JDK que trae Android Studio es el que usa el proyecto.
        for candidato in \
            "/c/Program Files/Android/Android Studio/jbr" \
            "/Applications/Android Studio.app/Contents/jbr/Contents/Home" \
            "$HOME/.jdks/jbr"
        do
            [[ -x "$candidato/bin/java" || -x "$candidato/bin/java.exe" ]] && { export JAVA_HOME="$candidato"; break; }
        done
    fi

    [[ -n "${JAVA_HOME:-}" ]] || morir \
        "No encuentro un JDK (JAVA_HOME no está definido)." \
        "Use el que trae Android Studio:" \
        "" \
        "    export JAVA_HOME=\"/c/Program Files/Android/Android Studio/jbr\"" \
        "" \
        "O ejecute este guion con --sin-compilar si solo quiere el servidor y el puente."
    bien "JDK en $JAVA_HOME"
fi

# =====================================================================
# 2 · Servidor
# =====================================================================
paso "Levantando el servidor"

cd "$RAIZ"

if curl -sf -m 3 http://localhost:3000/api/v1/salud >/dev/null 2>&1; then
    bien "ya estaba arriba"
else
    aviso "no responde; arrancando los contenedores (puede tardar)"
    docker compose up -d || morir \
        "Docker no pudo levantar los contenedores." \
        "¿Está Docker Desktop abierto? Mire el detalle con:" \
        "" \
        "    docker compose logs --tail 40"

    # MySQL tarda en aceptar conexiones aunque el contenedor ya esté «up».
    printf "  esperando a la base de datos"
    for _ in $(seq 1 60); do
        if curl -sf -m 3 http://localhost:3000/api/v1/salud >/dev/null 2>&1; then
            echo ""; break
        fi
        printf "."
        sleep 2
    done
    echo ""

    curl -sf -m 3 http://localhost:3000/api/v1/salud >/dev/null 2>&1 || morir \
        "El servidor no respondió tras dos minutos." \
        "Mire qué dice:" \
        "" \
        "    docker compose logs --tail 40 api"
    bien "arriba"
fi

SALUD="$(curl -s -m 5 http://localhost:3000/api/v1/salud)"
echo "  $SALUD"
[[ "$SALUD" == *'"bd":"conectada"'* ]] || morir \
    "El servidor responde pero NO llega a la base de datos." \
    "    docker compose logs --tail 40 db"

# El interruptor del panel de Administración. Si está apagado, la app muestra la
# misma pantalla de mantenimiento que si no hubiera red: conviene decirlo aquí y
# no dejar que se confunda con un problema de conexión.
ESTADO="$(curl -s -m 5 http://localhost:3000/api/v1/app/estado)"
if [[ "$ESTADO" == *'"activa":false'* ]]; then
    aviso "el canal digital está APAGADO desde Admin → Canal digital → App móvil."
    aviso "La app mostrará «No disponible ahora mismo» aunque todo lo demás vaya bien."
else
    bien "canal digital activo"
fi

# =====================================================================
# 3 · Dispositivo y puente
# =====================================================================
paso "Preparando el móvil"

# Las conexiones inalámbricas se quitan ANTES de contar: un móvil que está a la
# vez por cable y por wifi aparece dos veces, y con dos entradas `adb reverse`
# falla. Es exactamente el fallo que motivó este guion.
adb disconnect >/dev/null 2>&1 || true

DISPOSITIVOS="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
CUANTOS="$(echo "$DISPOSITIVOS" | grep -c . || true)"

if [[ "$CUANTOS" -eq 0 ]]; then
    NO_AUTORIZADOS="$(adb devices | awk 'NR>1 && $2=="unauthorized" {print $1}')"
    if [[ -n "$NO_AUTORIZADOS" ]]; then
        morir "El móvil está conectado pero SIN AUTORIZAR." \
              "Mire la pantalla del teléfono y acepte «¿Permitir depuración USB?»." \
              "Marque «Permitir siempre» para no repetirlo."
    fi
    morir "No hay ningún dispositivo conectado." \
          "· Conecte el móvil por cable (uno de datos, no solo de carga)." \
          "· Active Opciones de desarrollador → Depuración por USB." \
          "· En Xiaomi/POCO active además «Instalar vía USB»." \
          "· O arranque un emulador desde Android Studio."
fi

if [[ "$CUANTOS" -gt 1 ]]; then
    morir "Hay $CUANTOS dispositivos conectados y no sé a cuál apuntar." \
          "$(adb devices | tail -n +2)" \
          "" \
          "Deje solo uno: desenchufe los demás o cierre el emulador."
fi

SERIE="$DISPOSITIVOS"
MODELO="$(adb -s "$SERIE" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
bien "${MODELO:-dispositivo} ($SERIE)"

adb -s "$SERIE" reverse tcp:3000 tcp:3000 >/dev/null || morir \
    "No pude abrir el puente al servidor." \
    "Pruebe a reiniciar adb:" \
    "" \
    "    adb kill-server && adb start-server"

# Se comprueba de verdad en lugar de fiarse del código de salida: este puente es
# lo único que la app no puede resolver sola.
adb -s "$SERIE" reverse --list | grep -q "tcp:3000 tcp:3000" || morir \
    "El puente no quedó abierto." \
    "adb dijo que sí, pero 'adb reverse --list' no lo confirma."
bien "puente abierto: el localhost:3000 del móvil apunta a este PC"

# =====================================================================
# 4 · La aplicación
# =====================================================================
if [[ $SIN_COMPILAR -eq 1 ]]; then
    paso "Saltando la compilación (--sin-compilar)"
else
    paso "Compilando e instalando la app"
    cd "$MOVIL"
    ./gradlew installDebug --console=plain -q || morir \
        "Falló la compilación." \
        "Vuelva a lanzarlo sin '-q' para ver el detalle:" \
        "" \
        "    cd movil && ./gradlew installDebug"
    bien "instalada"
fi

paso "Abriendo la app"
adb -s "$SERIE" shell am start -n co.sigr.cliente/.MainActivity >/dev/null
bien "SIGR arrancando en el móvil"

echo ""
echo "${VERDE}${NEGRITA}Todo listo.${FIN}"
echo "  Web:  http://localhost:3000"
echo "  App:  abierta en ${MODELO:-el dispositivo}"
echo ""
echo "  ${AMARILLO}El puente se cae al desconectar el cable.${FIN} Si eso pasa, vuelva a"
echo "  ejecutar este guion: ./arrancar.sh --sin-compilar"
echo ""
