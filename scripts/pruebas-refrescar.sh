#!/usr/bin/env bash
# Pruebas del refresco automatico.
#
#   ./scripts/pruebas-refrescar.sh
#
# Corre el script de verdad —no una copia a mano— pero con las rutas apuntadas
# a un proyecto descartable, un `npm` y un `docker` de mentira, y un servidor
# local haciendose pasar por Telegram. No toca la base, ni los scrapers, ni el
# catalogo publicado, ni manda ningun mensaje afuera.
#
# Hace falta porque el refresco corre de madrugada sin nadie mirando: sus
# caminos interesantes (el candado trabado, el scraper colgado, una cadena
# caida) son justo los que no se ejercitan cuando todo anda bien.
set -uo pipefail

REAL="$(cd "$(dirname "$0")" && pwd)/refrescar.sh"
[ -f "$REAL" ] || { echo "No encuentro $REAL"; exit 1; }

TMP="$(mktemp -d)"
trap 'kill ${SRV:-0} 2>/dev/null; rm -rf "$TMP"' EXIT
mkdir -p "$TMP/proj/logs" "$TMP/bin" "$TMP/otro"
L="$TMP/proj/logs"

PASARON=0
FALLARON=0
ok() {
  if [ "$1" = "$2" ]; then
    PASARON=$((PASARON + 1)); echo "  ✔ $3"
  else
    FALLARON=$((FALLARON + 1)); echo "  ✘ $3 (fue '$1', esperaba '$2')"
  fi
}

# Un pid que seguro no existe, para hacer de dueño muerto del candado.
MUERTO=$(( $(cat /proc/sys/kernel/pid_max 2>/dev/null || echo 32768) - 4 ))
while kill -0 "$MUERTO" 2>/dev/null; do MUERTO=$((MUERTO - 1)); done

# --------------------------------------------------------------- utileria ----
npmFalso() { cat > "$TMP/bin/npm"; chmod +x "$TMP/bin/npm"; }
limpiar() { rm -f "$L"/.candado "$L"/.candado.pid "$L"/.ultimo-exito "$L"/refresco-*.log; }
# Un proceso cuyo cmdline contiene refrescar.sh, para probar que el script
# reconoce a un dueño legitimo. Sin `exec`: reemplazaria a bash y con el se
# perderia el nombre, que es justo lo que se esta verificando.
printf '#!/bin/bash\nsleep 120\n' > "$TMP/otro/refrescar.sh"
chmod +x "$TMP/otro/refrescar.sh"
printf '#!/bin/bash\nexit 0\n' > "$TMP/bin/docker"; chmod +x "$TMP/bin/docker"

npmFalso <<'EOF'
#!/bin/bash
echo "[18:00:03] Arranca el refresco"
echo "[18:16:54] coope: 6076 productos (0 nuevos)"
echo "[18:32:47] hogar: 4702 productos (0 nuevos)"
echo "[21:43:06] disco: 10337 productos (165 nuevos)"
echo "[22:14:14] carrefour: 12613 productos (104 nuevos)"
echo "[22:14:30] Listo en 254 minutos."
sleep "${FAKE_DUR:-0}"
exit "${FAKE_SALIDA:-0}"
EOF

# ----------------------------------------------------- Telegram de mentira ----
# Puerto 0: lo elige el sistema, asi dos corridas no se pisan.
cat > "$TMP/telegram.py" <<'EOF'
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs
salida = open(sys.argv[1], 'a')
class H(BaseHTTPRequestHandler):
    def do_POST(self):
        d = parse_qs(self.rfile.read(int(self.headers['Content-Length'])).decode())
        # El mensaje entero en una linea: el resumen de cadenas va despues del
        # encabezado, y guardando solo la primera no se podia verificar.
        salida.write(' | '.join(d.get('text', [''])[0].splitlines()) + '\n'); salida.flush()
        self.send_response(200); self.end_headers(); self.wfile.write(b'{"ok":true}')
    def log_message(self, *a): pass
s = HTTPServer(('127.0.0.1', 0), H)
print(s.server_port, flush=True)
s.serve_forever()
EOF
AVISOS="$TMP/avisos.txt"; : > "$AVISOS"
python3 -u "$TMP/telegram.py" "$AVISOS" > "$TMP/puerto.txt" 2>&1 &
SRV=$!
for _ in $(seq 1 50); do [ -s "$TMP/puerto.txt" ] && break; sleep 0.1; done
PUERTO="$(head -1 "$TMP/puerto.txt")"
[ -n "$PUERTO" ] || { echo "No arranco el Telegram de mentira"; exit 1; }

printf 'TELEGRAM_BOT_TOKEN=123:PRUEBA\nTELEGRAM_CHAT_ID=999\n' > "$TMP/proj/.env"

# El script REAL, solo con las rutas y el destino de los avisos cambiados.
copia() {
  sed -e "s#^RAIZ=.*#RAIZ=\"$TMP/proj\"#" \
      -e "s#^NODE_BIN=.*#NODE_BIN=\"$TMP/bin\"#" \
      -e "s#https://api.telegram.org#http://127.0.0.1:$PUERTO#" \
      "$REAL" > "$TMP/$1"
  chmod +x "$TMP/$1"
}
copia refrescar.sh

echo "Probando $REAL"
echo

# ------------------------------------------------------------ lo de siempre ----
echo "  -- corrida normal --"
limpiar; "$TMP/refrescar.sh" 2>"$TMP/err.txt"
ok "$?" "0" "sale con 0 cuando anda todo"
ok "$([ -s "$TMP/err.txt" ] && echo x || echo -)" "-" "no ensucia stderr"
ok "$(cat "$L/.ultimo-exito")" "$(date +%F)" "marca el dia como exitoso"
ok "$(grep -c 'arranco el refresco' "$AVISOS")" "1" "avisa cuando arranca, no solo al terminar"
"$TMP/refrescar.sh" 2>/dev/null
ok "$(grep -c '=====' "$L"/refresco-*.log)" "1" "no repite si ya salio bien hoy"
ok "$([ -f "$L/.candado.pid" ] && echo x || echo -)" "x" "deja el pid como evidencia"

echo "  -- fallas --"
limpiar; FAKE_SALIDA=1 "$TMP/refrescar.sh" 2>/dev/null
ok "$?" "1" "propaga el codigo de salida"
ok "$([ -f "$L/.ultimo-exito" ] && echo x || echo -)" "-" "si fallo no marca exito (reintenta)"

limpiar
npmFalso <<'EOF'
#!/bin/bash
echo "[18:16:54] coope: 6076 productos (0 nuevos)"
echo "[19:00:00] disco: FALLO tras 930 productos — choque de EAN"
echo "[22:14:14] carrefour: 12613 productos (104 nuevos)"
echo "[22:14:30] Listo en 254 minutos. Fallaron: Disco."
exit 0
EOF
"$TMP/refrescar.sh" >/dev/null 2>&1
ok "$?" "0" "una cadena caida no tumba el refresco"
ok "$(grep -c 'pero alguna cadena fallo' "$AVISOS")" "1" "avisa que fue parcial, no ✅ a secas"

# Una cadena que el filtro no conozca por nombre tiene que aparecer igual: con
# la lista escrita a mano, Chango Mas corria y no salia en el aviso.
limpiar
npmFalso <<'EOF'
#!/bin/bash
echo "[18:16:54] cadenanueva: 1234 productos (5 nuevos)"
echo "[22:14:30] Listo en 99 minutos."
exit 0
EOF
"$TMP/refrescar.sh" >/dev/null 2>&1
ok "$(grep -c 'cadenanueva: 1234' "$AVISOS")" "1" "el aviso no depende del nombre de la cadena"

npmFalso <<'EOF'
#!/bin/bash
echo "[18:16:54] coope: 6076 productos (0 nuevos)"
echo "[22:14:30] Listo en 254 minutos."
sleep "${FAKE_DUR:-0}"
exit "${FAKE_SALIDA:-0}"
EOF

echo "  -- candado --"
limpiar
FAKE_DUR=6 "$TMP/refrescar.sh" >/dev/null 2>&1 &
LARGO=$!
sleep 2
# Se compara contra el conteo justo antes, no contra un total fijo: el numero
# de avisos depende de cuantas pruebas corrieron antes y se desincroniza sola.
AVISOS_ANTES=$(grep -c 'arranco el refresco' "$AVISOS")
"$TMP/refrescar.sh" >/dev/null 2>&1
ok "$(grep -c 'ya hay un refresco corriendo (pid' "$L"/refresco-*.log)" "1" "se saltea si hay otro vivo"
# El que se saltea no tiene que mandar "arranco": seria un aviso por hora.
ok "$(grep -c 'arranco el refresco' "$AVISOS")" "$AVISOS_ANTES" "saltearse no manda aviso de arranque"
wait $LARGO

limpiar
( exec 9>>"$L/.candado"; flock -n 9; echo $MUERTO > "$L/.candado.pid"; sleep 25 ) &
H=$!; sleep 1
"$TMP/refrescar.sh" >/dev/null 2>&1
ok "$(grep -c 'se rompe' "$L"/refresco-*.log)" "1" "destraba el candado de un dueño muerto"
kill $H 2>/dev/null; wait $H 2>/dev/null

# Pid vivo pero que no es este script: el numero se reciclo.
limpiar
( exec 9>>"$L/.candado"; flock -n 9; sleep 25 ) &
H=$!
sleep 40 & AJENO=$!
sleep 1
echo $AJENO > "$L/.candado.pid"
"$TMP/refrescar.sh" >/dev/null 2>&1
ok "$(grep -c 'se rompe' "$L"/refresco-*.log)" "1" "un pid reciclado no lo confunde"
kill $H $AJENO 2>/dev/null; wait $H 2>/dev/null

# La carrera: el archivo tiene un pid viejo y muerto, pero el dueño real esta
# vivo y anota el suyo un instante despues. No tiene que romper nada.
limpiar
( exec 9>>"$L/.candado"; flock -n 9; sleep 25 ) &
H=$!
"$TMP/otro/refrescar.sh" & VIVO=$!
sleep 0.5
echo $MUERTO > "$L/.candado.pid"
( sleep 1.5; echo $VIVO > "$L/.candado.pid" ) &
"$TMP/refrescar.sh" >/dev/null 2>&1
ok "$(grep -c 'se rompe' "$L"/refresco-*.log)" "0" "carrera: no rompe un candado legitimo"
ok "$(grep -c 'ya hay un refresco corriendo' "$L"/refresco-*.log)" "1" "carrera: relee y se saltea"
kill $H $VIVO 2>/dev/null; wait $H 2>/dev/null

echo "  -- scraper colgado --"
limpiar
sed 's#timeout --kill-after=1m 5h#timeout --kill-after=2s 2s#' "$TMP/refrescar.sh" > "$TMP/lento.sh"
chmod +x "$TMP/lento.sh"
FAKE_DUR=30 "$TMP/lento.sh" >/dev/null 2>&1
ok "$?" "124" "lo corta el limite de tiempo"
ok "$([ -f "$L/.ultimo-exito" ] && echo x || echo -)" "-" "colgado no cuenta como exito"
ok "$(grep -c '⏱' "$AVISOS")" "1" "avisa que se colgo, distinto de una falla"

echo "  -- avisos --"
limpiar; : > "$TMP/proj/.env"
"$TMP/refrescar.sh" >/dev/null 2>&1
ok "$?" "0" "sin credenciales corre igual (Telegram es opcional)"

echo
echo "  mensajes que hubiera mandado:"
sed 's/^/    /' "$AVISOS"
echo
echo "  $PASARON pasaron, $FALLARON fallaron"
[ "$FALLARON" -eq 0 ]
