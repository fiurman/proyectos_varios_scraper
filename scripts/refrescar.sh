#!/usr/bin/env bash
# Refresco automatico del catalogo: scrapea, empareja, publica.
#
# Pensado para cron, que arranca con un entorno casi vacio: no hereda el PATH
# de tu terminal ni sabe nada de fnm. Por eso la ruta de node va explicita.
set -uo pipefail

# La raiz sale de donde vive este script, no escrita a mano: asi el mismo
# archivo corre en esta maquina y en el servidor sin editar nada.
RAIZ="${REFRESCAR_RAIZ:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"

# Se corre desde una copia, no desde el original.
#
# Bash no lee el script entero: va leyendo del disco a medida que avanza. Si
# alguien lo edita mientras corre, las posiciones se corren y desde ahi ejecuta
# cualquier cosa. Paso el 2026-09-24: una edicion a mitad de corrida se comio
# el aviso final y dejo el refresco relanzandose 24 horas con el candado
# tomado, asi que los dos dias siguientes no corrio nada.
if [ -z "${REFRESCAR_COPIA:-}" ]; then
  COPIA="$(mktemp -t refrescar-XXXXXX.sh)"
  cat "${BASH_SOURCE[0]}" > "$COPIA"
  export REFRESCAR_COPIA=1 REFRESCAR_RAIZ="$RAIZ"
  bash "$COPIA" "$@"
  CODIGO=$?
  rm -f "$COPIA"
  exit "$CODIGO"
fi

LOGS="$RAIZ/logs"

# Cron arranca con un PATH casi vacio y no sabe nada de fnm ni de nvm. Se
# buscan los lugares donde suele estar node y se usa el primero que aparezca;
# NODE_BIN en el entorno gana sobre todo, para poder forzarlo.
for candidato in \
  "${NODE_BIN:-}" \
  "$HOME/.local/share/fnm/node-versions"/*/installation/bin \
  "$HOME/.nvm/versions/node"/*/bin \
  /usr/local/bin /usr/bin
do
  [ -x "$candidato/node" ] && { NODE_BIN="$candidato"; break; }
done

export PATH="${NODE_BIN:-/usr/bin}:/usr/local/bin:/usr/bin:/bin"

if ! command -v node >/dev/null 2>&1; then
  echo "No encontre node. Pone NODE_BIN=/ruta/al/bin y volve a correr." >&2
  exit 1
fi

mkdir -p "$LOGS"
LOG="$LOGS/refresco-$(date +%Y-%m-%d).log"
MARCA="$LOGS/.ultimo-exito"
CANDADO="$LOGS/.candado"
DUENO="$LOGS/.candado.pid"
HOY="$(date +%Y-%m-%d)"

# ---------------------------------------------------------------- avisos ----
# Telegram, opcional: sin credenciales el refresco funciona igual, nada mas que
# en silencio. Se leen del .env sin interpretarlo como script, que ahi adentro
# tambien viven las claves de R2 y de la base.
clave() { sed -n "s/^$1=//p" "$RAIZ/.env" 2>/dev/null | tail -1 | tr -d "\"'" ; }
TG_TOKEN="$(clave TELEGRAM_BOT_TOKEN)"
TG_CHAT="$(clave TELEGRAM_CHAT_ID)"

avisar() {
  [ -n "$TG_TOKEN" ] && [ -n "$TG_CHAT" ] || return 0
  curl -sS -m 20 -o /dev/null \
    -d "chat_id=$TG_CHAT" \
    --data-urlencode "text=$1" \
    "https://api.telegram.org/bot$TG_TOKEN/sendMessage" \
    || echo "$(date '+%H:%M:%S') (no se pudo avisar por Telegram)" >> "$LOG"
}

# ¿El candado lo tiene un refresco de verdad?
#
# No alcanza con que el pid exista: los numeros de proceso se reciclan, y si el
# sistema le dio ese mismo numero a otra cosa, nos saltearíamos por las razones
# equivocadas. Se confirma leyendo con que linea de comandos arranco.
duenoVivo() {
  local pid="${1:-}"
  [ -n "$pid" ] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  [ -r "/proc/$pid/cmdline" ] || return 1
  tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'refrescar\.sh'
}

# Corre cada hora entre las 17 y las 22 porque la maquina no siempre esta
# prendida: seis intentos dan mucha mas chance de agarrarla que uno solo. Pero
# alcanza con que salga bien una vez, asi que si ya hubo exito hoy, se va.
if [ -f "$MARCA" ] && [ "$(cat "$MARCA")" = "$HOY" ]; then
  exit 0
fi

cd "$RAIZ" || exit 1

# --------------------------------------------------------------- candado ----
# Una sola corrida a la vez: el cron intenta cada hora y un refresco completo
# puede tardar mas, asi que sin esto dos corridas se pisan y duplican la carga
# sobre los servidores de las cadenas.
#
# En modo append a proposito: `>` truncaria el archivo antes de pedir el
# candado, o sea que el que llega tarde le borraria los datos al que esta
# trabajando.
exec 9>>"$CANDADO"

if ! flock -n 9; then
  PID="$(cat "$DUENO" 2>/dev/null)"

  # Si a primera vista parece muerto, todavia no se da por muerto: puede ser
  # que el dueño real acabe de tomar el candado y no haya alcanzado a anotar su
  # pid, en cuyo caso aca se lee el de la corrida anterior. Romper el candado
  # por esa carrera dejaria dos refrescos encima, que es justo lo que el
  # candado viene a evitar. Se espera y se relee: si el numero cambio, es que
  # hay alguien vivo del otro lado.
  if ! duenoVivo "$PID"; then
    sleep 3
    RELEIDO="$(cat "$DUENO" 2>/dev/null)"
    [ "$RELEIDO" != "$PID" ] && PID="$RELEIDO"
  fi

  if duenoVivo "$PID"; then
    # Caso normal y esperado: hay un refresco de verdad en curso.
    echo "$(date '+%H:%M:%S') ya hay un refresco corriendo (pid $PID), se saltea" >> "$LOG"
    exit 0
  fi

  # El candado esta tomado pero su dueño ya no existe. Pasa cuando el script
  # muere y algun hijo suyo hereda el descriptor y lo sigue reteniendo: el
  # refresco no vuelve a correr nunca mas y nadie se entera. Se rompe creando
  # un archivo nuevo — el huerfano se queda con el viejo, ya sin nombre.
  echo "$(date '+%H:%M:%S') candado trabado por pid ${PID:-desconocido} (ya no existe): se rompe" >> "$LOG"
  rm -f "$CANDADO"
  exec 9>>"$CANDADO"

  if ! flock -n 9; then
    echo "$(date '+%H:%M:%S') no se pudo destrabar el candado, se saltea" >> "$LOG"
    avisar "⚠️ precios_varios: el candado quedo trabado y no se pudo destrabar. El refresco no esta corriendo."
    exit 0
  fi
  avisar "⚠️ precios_varios: habia un candado trabado de una corrida muerta. Se destrabo y sigue el refresco."
fi

# El archivo NO se borra al salir, a proposito: si el script muere y un hijo
# suyo se queda reteniendo el candado, este numero es la unica evidencia de que
# el dueño original ya no esta. Borrandolo, el trabon quedaria indistinguible
# de un refresco que recien arranca.
echo $$ > "$DUENO"

# Desde donde empieza lo de esta corrida, para poder resumirla despues.
ANTES=$([ -f "$LOG" ] && wc -l < "$LOG" || echo 0)

# Se avisa tambien al arrancar: es la unica señal de que el cron disparo. Sin
# esto, una corrida que se cuelga y muere sin llegar al aviso final es
# indistinguible de un cron que nunca se ejecuto.
avisar "🛒 precios_varios: arranco el refresco ($(date '+%H:%M')). Suele tardar unas 4 horas."


# Subshell a proposito, no `{ }`: adentro hay `exit` para propagar el codigo de
# salida, y un grupo con llaves corre en este mismo shell, asi que ese exit se
# llevaria puesto el script entero — sin aviso y sin limpieza de logs.
(
  echo "===== $(date '+%Y-%m-%d %H:%M:%S') ====="

  # La base corre en Docker. Si la maquina se reinicio hace poco puede no estar
  # lista todavia: esperamos hasta un minuto antes de rendirnos.
  for _ in $(seq 1 12); do
    docker compose exec -T db pg_isready -U precios >/dev/null 2>&1 9>&- && break
    sleep 5
  done

  if ! docker compose exec -T db pg_isready -U precios >/dev/null 2>&1 9>&-; then
    echo "La base no responde. Se cancela el refresco."
    exit 1
  fi

  # Dos cosas acá.
  #
  # `9>&-` le cierra el candado al hijo. Sin esto, cualquier proceso que npm
  # deje huerfano hereda el descriptor y bloquea las corridas siguientes: es
  # exactamente el trabon que el bloque de arriba tiene que venir a arreglar.
  #
  # El `timeout` es una rendicion deliberada: no hay forma de saber si un
  # proceso esta trabajando o colgado, asi que se decide por reloj. Sin esto,
  # un scraper esperando para siempre una respuesta que no llega se queda con
  # el candado y apaga el refresco todos los dias, sin aviso, porque el script
  # nunca termina. Cinco horas es holgado: lo normal es una, y la peor corrida
  # medida fue de cuatro con la maquina peleandose consigo misma.
  timeout --kill-after=1m 5h npm run refrescar 9>&-
  CODIGO=$?
  echo "salida: $CODIGO"

  # Solo si salio bien: si fallo, el proximo intento de la ventana reintenta.
  if [ "$CODIGO" -eq 0 ]; then
    echo "$HOY" > "$MARCA"
  fi

  exit "$CODIGO"
) >> "$LOG" 2>&1
CODIGO=$?

# ---------------------------------------------------------------- resumen ----
# Se avisa tambien cuando sale bien, no solo cuando falla: un aviso que no
# llega nunca no se distingue de uno que se rompio en silencio.
# Las lineas de resultado de cada cadena tienen la forma "[hh:mm:ss] clave: N
# productos" o "... clave: FALLO". Se reconocen por la forma y no por el nombre:
# con la lista escrita a mano, Chango Mas corrio 56 minutos y no aparecio en el
# aviso —parecia que no se habia ejecutado— y Disco seguia figurando meses
# despues de sacarlo.
RESUMEN="$(tail -n "+$((ANTES + 1))" "$LOG" \
  | grep -E '^\[[0-9:]+\] ([a-z_]+: ([0-9]|FALLO)|Listo|Ninguna|Error)' | tail -8)"

if [ "$CODIGO" -eq 0 ] && grep -q 'FALLO' <<<"$RESUMEN"; then
  # Salio bien en general, pero alguna cadena quedo afuera: se publica igual
  # (tres cadenas al dia valen mas que ninguna), asi que el codigo de salida es
  # 0. Un ✅ a secas taparia que los precios de una cadena son de ayer.
  avisar "⚠️ precios_varios: catalogo actualizado, pero alguna cadena fallo.

$RESUMEN"
elif [ "$CODIGO" -eq 0 ]; then
  avisar "✅ precios_varios: catalogo actualizado.

$RESUMEN"
elif [ "$CODIGO" -eq 124 ] || [ "$CODIGO" -eq 137 ]; then
  avisar "⏱ precios_varios: el refresco se colgo y lo corto el limite de 5 horas.

$(tail -n "+$((ANTES + 1))" "$LOG" | tail -8)

Quedan los precios de la corrida anterior. Conviene mirar que cadena quedo trabada."
else
  ULTIMAS="$(tail -n "+$((ANTES + 1))" "$LOG" | tail -12)"
  avisar "❌ precios_varios: el refresco fallo (salida $CODIGO).

$ULTIMAS

Quedan los precios de la corrida anterior. Si hay ventana, se reintenta a la hora."
fi

# Aviso de vida, para enterarse cuando el refresco NO corre.
#
# Telegram avisa cuando algo pasa. El problema es al reves: si la maquina se
# apaga, se queda sin luz o el disco muere, no llega nada — y eso es igual a no
# haber mirado el telefono. Un servicio de afuera espera este ping y avisa el
# dia que no aparece.
#
# Se configura poniendo HEALTHCHECK_URL en el .env (healthchecks.io tiene plan
# gratis). Sin esa variable no hace nada.
SALUD="$(clave HEALTHCHECK_URL)"
if [ -n "$SALUD" ]; then
  # El sufijo /fail marca la corrida como fallida sin esperar a que venza el
  # plazo, asi el aviso llega en el momento y no al otro dia.
  [ "$CODIGO" -eq 0 ] && DESTINO="$SALUD" || DESTINO="${SALUD%/}/fail"
  curl -sS -m 15 -o /dev/null --retry 2 "$DESTINO" \
    || echo "$(date '+%H:%M:%S') (no se pudo avisar al monitor externo)" >> "$LOG"
fi

# Solo los ultimos 14 dias de logs.
find "$LOGS" -name 'refresco-*.log' -mtime +14 -delete 2>/dev/null

exit "$CODIGO"
