#!/usr/bin/env bash
# Averigua el chat id preguntandole al propio bot y lo deja en .env.
#
# Se corre una sola vez, cuando se configura el aviso del refresco. Lee el
# token del .env en vez de recibirlo por argumento para que no quede en el
# historial del shell.
set -uo pipefail
cd "$(dirname "$0")/.."

TOKEN="$(sed -n 's/^TELEGRAM_BOT_TOKEN=//p' .env 2>/dev/null | tail -1 | tr -d "\"'")"
if [ -z "$TOKEN" ]; then
  echo "Falta TELEGRAM_BOT_TOKEN en .env. Agregalo primero (te lo da @BotFather)."
  exit 1
fi

RTA="$(curl -sS -m 20 "https://api.telegram.org/bot$TOKEN/getUpdates")" || exit 1

# Tolerante a los espacios: la respuesta es JSON, no una cadena fija.
if ! grep -qE '"ok"[[:space:]]*:[[:space:]]*true' <<<"$RTA"; then
  echo "Telegram rechazo el token. Revisa que este completo, con los dos puntos."
  exit 1
fi

# Formato: id<TAB>quien, sin repetidos. Sirve igual para un chat personal que
# para un grupo (ahi el id es negativo).
CHATS="$(python3 - "$RTA" <<'PY'
import json, sys
vistos = {}
for u in json.loads(sys.argv[1]).get('result', []):
    m = u.get('message') or u.get('channel_post') or {}
    c = m.get('chat') or {}
    if 'id' in c:
        quien = c.get('title') or ' '.join(filter(None, [c.get('first_name'), c.get('last_name')])) or c.get('username') or '?'
        vistos[c['id']] = f"{quien} ({c.get('type')})"
for i, q in vistos.items():
    print(f"{i}\t{q}")
PY
)"

if [ -z "$CHATS" ]; then
  echo "El bot no tiene mensajes todavia."
  echo "Abri Telegram, buscalo por su @usuario, toca Iniciar/Start y escribile"
  echo "cualquier cosa. Despues volve a correr esto."
  exit 1
fi

echo "Chats que le escribieron al bot:"
echo "$CHATS" | sed 's/^/  /'
echo

ID="$(head -1 <<<"$CHATS" | cut -f1)"
if grep -q '^TELEGRAM_CHAT_ID=' .env; then
  sed -i "s/^TELEGRAM_CHAT_ID=.*/TELEGRAM_CHAT_ID=$ID/" .env
else
  # Si el archivo no termina en salto de linea, el append pegaria la variable
  # nueva al final de la ultima, rompiendo las dos.
  [ -s .env ] && [ -n "$(tail -c1 .env)" ] && printf '\n' >> .env
  printf 'TELEGRAM_CHAT_ID=%s\n' "$ID" >> .env
fi
echo "Guardado TELEGRAM_CHAT_ID=$ID en .env"

curl -sS -m 20 -o /dev/null -d "chat_id=$ID" \
  --data-urlencode "text=✅ precios_varios: avisos configurados. Vas a recibir un mensaje por dia cuando se actualicen los precios." \
  "https://api.telegram.org/bot$TOKEN/sendMessage" \
  && echo "Te mandamos un mensaje de prueba, fijate si llego."
