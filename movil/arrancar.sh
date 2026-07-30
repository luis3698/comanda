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
# Sirve para las tres formas de tener un Android delante: por cable, por wifi y
# emulador. Si no hay ninguna, arranca un emulador él mismo.
#
# Uso:   cd movil && ./arrancar.sh
#        ./arrancar.sh --sin-compilar     (solo servidor y puente; no toca el APK)
#        ./arrancar.sh --sin-emulador     (no arranca un emulador si no hay nada)
#
set -euo pipefail

SIN_COMPILAR=0
SIN_EMULADOR=0
for arg in "$@"; do
    case "$arg" in
        --sin-compilar) SIN_COMPILAR=1 ;;
        --sin-emulador) SIN_EMULADOR=1 ;;
        *) echo "Opción desconocida: $arg" >&2; exit 1 ;;
    esac
done

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

# Cuenta líneas de una lista que puede venir vacía.
contar() { [[ -z "$1" ]] && echo 0 || echo "$1" | grep -c .; }

# Clasifica lo conectado por TRANSPORTE, que es lo que decide cómo tratarlo:
#
#   · cable        serie a secas             ej. U8AEV8PFPBDEDIPN
#   · inalámbrico  ip:puerto, o mDNS         ej. 192.168.1.7:5555
#                                                adb-U8AEV…._adb-tls-connect._tcp
#   · emulador     emulator-NNNN             ej. emulator-5554
#
# La distinción importa porque `adb disconnect` SOLO afecta a los inalámbricos.
clasificar() {
    local todos
    todos="$(adb devices | awk 'NR>1 && $2=="device" {print $1}')"
    EMULADOR="$(echo "$todos"    | grep -E '^emulator-' || true)"
    INALAMBRICO="$(echo "$todos" | grep -E ':[0-9]+$|_adb-tls-connect\._tcp' || true)"
    CABLE="$(echo "$todos"       | grep -vE '^emulator-|:[0-9]+$|_adb-tls-connect\._tcp' || true)"
    TODOS="$todos"
    N_TOTAL="$(contar "$todos")"
}

clasificar

# EL DESEMPATE, QUE ANTES ERA UN `adb disconnect` A SECAS
#
# El caso que motivó este guion: el MISMO teléfono conectado a la vez por cable
# y por wifi aparece dos veces, y con dos entradas `adb reverse` falla con «more
# than one device». La solución era `adb disconnect` antes de contar.
#
# Pero `adb disconnect` sin argumentos desconecta TODOS los dispositivos TCP/IP
# —lo dice su propia ayuda—, así que a quien tuviera el móvil SOLO por wifi se
# lo tiraba, y el guion moría acto seguido con «no hay ningún dispositivo
# conectado» mandándole a buscar un cable que no necesitaba.
#
# Ahora la conexión inalámbrica solo se cierra cuando de verdad estorba: cuando
# hay también una por cable. Si el wifi es el único transporte, se usa tal cual;
# `adb reverse` funciona igual por wifi que por USB.
if [[ "$(contar "$CABLE")" -ge 1 && "$(contar "$INALAMBRICO")" -ge 1 ]]; then
    aviso "el móvil está por cable Y por wifi a la vez: se cierra la conexión inalámbrica"
    adb disconnect >/dev/null 2>&1 || true
    clasificar
fi

# ---------------------------------------------------------------------
# Sin nada conectado: se arranca un emulador en lugar de rendirse.
#
# Antes esto era un `morir` que decía «o arranque un emulador desde Android
# Studio», es decir: deje esto, abra otro programa, espere, y vuelva. Si hay un
# AVD definido no hace falta —el binario `emulator` lo arranca igual de bien—,
# y así el guion cumple lo que promete: levantarlo TODO.
# ---------------------------------------------------------------------
arrancar_emulador() {
    command -v emulator >/dev/null 2>&1 || {
        for candidato in \
            "${ANDROID_HOME:-}/emulator" \
            "${ANDROID_SDK_ROOT:-}/emulator" \
            "$HOME/AppData/Local/Android/Sdk/emulator" \
            "$HOME/Library/Android/sdk/emulator" \
            "$HOME/Android/Sdk/emulator"
        do
            if [[ -n "$candidato" && ( -x "$candidato/emulator" || -x "$candidato/emulator.exe" ) ]]; then
                export PATH="$PATH:$candidato"
                break
            fi
        done
    }
    command -v emulator >/dev/null 2>&1 || return 1

    local avd
    avd="$(emulator -list-avds 2>/dev/null | head -1)"
    [[ -n "$avd" ]] || return 1

    aviso "no hay ningún dispositivo; arrancando el emulador «$avd»"

    # Desatendido y en segundo plano. -no-snapshot-save evita que al cerrarlo
    # escriba una instantánea de varios GB que nadie pidió.
    emulator -avd "$avd" -no-snapshot-save >/dev/null 2>&1 &

    # Se espera a sys.boot_completed y NO a que adb lo liste: aparece en la
    # lista mucho antes de haber terminado de arrancar, y un `install` en ese
    # hueco falla con un error que no menciona el arranque.
    printf "  esperando a que termine de arrancar"
    for _ in $(seq 1 120); do
        if [[ "$(adb shell getprop sys.boot_completed 2>/dev/null | tr -d '\r')" == "1" ]]; then
            echo ""
            return 0
        fi
        printf "."
        sleep 2
    done
    echo ""
    return 1
}

if [[ "$N_TOTAL" -eq 0 ]]; then
    NO_AUTORIZADOS="$(adb devices | awk 'NR>1 && $2=="unauthorized" {print $1}')"
    if [[ -n "$NO_AUTORIZADOS" ]]; then
        morir "El móvil está conectado pero SIN AUTORIZAR." \
              "Mire la pantalla del teléfono y acepte «¿Permitir depuración USB?»." \
              "Marque «Permitir siempre» para no repetirlo."
    fi

    if [[ $SIN_EMULADOR -eq 0 ]] && arrancar_emulador; then
        clasificar
        bien "emulador arrancado"
    fi
fi

if [[ "$N_TOTAL" -eq 0 ]]; then
    morir "No hay ningún dispositivo conectado ni pude arrancar un emulador." \
          "Cualquiera de estas tres vale:" \
          "" \
          "· Cable: uno de datos (no solo de carga), con Opciones de" \
          "  desarrollador → Depuración por USB. En Xiaomi/POCO active" \
          "  además «Instalar vía USB»." \
          "· Wifi:  Depuración inalámbrica en el móvil y, en el PC," \
          "         adb pair IP:PUERTO   y luego   adb connect IP:PUERTO" \
          "· Emulador: cree un AVD en Android Studio (Device Manager)."
fi

if [[ "$N_TOTAL" -gt 1 ]]; then
    morir "Hay $N_TOTAL dispositivos conectados y no sé a cuál apuntar." \
          "$(adb devices | tail -n +2)" \
          "" \
          "Deje solo uno: desenchufe los demás o cierre el emulador."
fi

SERIE="$TODOS"

# Cómo está enganchado, porque cambia qué hacer si algo va mal luego.
case "$SERIE" in
    emulator-*)                       VIA="emulador" ;;
    *:[0-9]*|*_adb-tls-connect._tcp)  VIA="wifi" ;;
    *)                                VIA="cable" ;;
esac

MODELO="$(adb -s "$SERIE" shell getprop ro.product.model 2>/dev/null | tr -d '\r')"
bien "${MODELO:-dispositivo} por $VIA ($SERIE)"

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

# Se comprueba que el paquete ESTÉ antes de intentar abrirlo. Es el desenlace
# natural de --sin-compilar sobre un móvil donde la app nunca se instaló: sin
# esto, `am start` responde «Error type 3 · Activity class does not exist», que
# suena a que la app está rota cuando lo único que pasa es que no está puesta.
if ! adb -s "$SERIE" shell pm list packages 2>/dev/null | tr -d '\r' | grep -q '^package:co.sigr.cliente$'; then
    morir "La app no está instalada en ${MODELO:-el dispositivo}." \
          "El puente ya quedó abierto; solo falta instalarla. Ejecute esto mismo" \
          "sin '--sin-compilar':" \
          "" \
          "    ./arrancar.sh"
fi

adb -s "$SERIE" shell am start -n co.sigr.cliente/.MainActivity >/dev/null 2>&1 || morir \
    "La app está instalada pero no arrancó." \
    "Ábrala a mano en el móvil. Si tampoco así, reinstálela:" \
    "" \
    "    ./arrancar.sh"
bien "SIGR arrancando en el móvil"

echo ""
echo "${VERDE}${NEGRITA}Todo listo.${FIN}"
echo "  Web:  http://localhost:3000"
echo "  App:  abierta en ${MODELO:-el dispositivo} (por $VIA)"
echo ""
# El aviso se ajusta al transporte: cada uno se cae por un motivo distinto y
# decir "desconectar el cable" a quien va por wifi solo despista.
case "$VIA" in
    cable) echo "  ${AMARILLO}El puente se cae al desconectar el cable.${FIN}" ;;
    wifi)  echo "  ${AMARILLO}El puente se cae si el móvil sale de la wifi o se duerme.${FIN}" ;;
    emulador) echo "  ${AMARILLO}El puente se cae al cerrar el emulador.${FIN}" ;;
esac
echo "  Si eso pasa, vuelva a ejecutar: ./arrancar.sh --sin-compilar"
echo ""
