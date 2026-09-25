#!/usr/bin/env bash
# Deja una maquina limpia lista para correr el refresco.
#
# Pensado para que levantar el servidor de cero sea un comando y no una tarde
# de acordarse de pasos. Importa mas de lo que parece: el plan gratuito de
# Oracle puede apagarte la instancia por inactividad, asi que la maquina tiene
# que ser descartable —si la perdes, corres esto en otra y seguis—.
#
# Se puede correr varias veces sin romper nada.
#
#   ./scripts/aprovisionar.sh
#
# Lo unico que NO hace es traer el .env, que tiene las claves: ese se copia a
# mano desde la maquina vieja.

set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$RAIZ"

paso() { printf '\n\033[1m==> %s\033[0m\n' "$1"; }

paso "Zona horaria"
# Sin esto el cron corre a la hora de Londres y el refresco de las 17:00 te
# agarra a las 13:00. Los servidores vienen en UTC.
if [ "$(cat /etc/timezone 2>/dev/null)" != "America/Argentina/Buenos_Aires" ]; then
  sudo timedatectl set-timezone America/Argentina/Buenos_Aires
fi
echo "  $(date '+%Y-%m-%d %H:%M %Z')"

paso "Paquetes del sistema"
sudo apt-get update -qq
sudo apt-get install -y -qq git curl ca-certificates postgresql-client

if ! command -v docker >/dev/null 2>&1; then
  sudo apt-get install -y -qq docker.io docker-compose-v2
  sudo usermod -aG docker "$USER"
  echo "  Docker instalado. Cerra sesion y volve a entrar para usarlo sin sudo."
fi
echo "  docker $(docker --version 2>/dev/null | awk '{print $3}' | tr -d ,)"

paso "Node"
# El repo pide 22 o mas. En ARM tambien hay binarios oficiales, asi que la
# misma linea sirve para una maquina Ampere de Oracle y para una x86.
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -c2- | cut -d. -f1)" -lt 22 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y -qq nodejs
fi
echo "  node $(node -v) sobre $(uname -m)"

paso "Dependencias del proyecto"
npm install --silent

paso "Base de datos"
if [ ! -f .env ]; then
  echo "  ! Falta .env. Copialo de la maquina vieja:"
  echo "      scp .env $USER@$(hostname -I 2>/dev/null | awk '{print $1}'):$RAIZ/.env"
  echo "    y volve a correr esto."
  exit 1
fi
docker compose up -d
# El contenedor tarda unos segundos en aceptar conexiones.
for _ in $(seq 1 24); do
  docker compose exec -T db pg_isready -U precios >/dev/null 2>&1 && break
  sleep 5
done
docker compose exec -T db pg_isready -U precios >/dev/null 2>&1 \
  || { echo "  ! La base no respondio en dos minutos."; exit 1; }
npm run migrate -w @precios/db
echo "  base lista"

paso "Tarea programada"
LINEA="0 17-22 * * * $RAIZ/scripts/refrescar.sh"
if crontab -l 2>/dev/null | grep -Fq "refrescar.sh"; then
  echo "  ya estaba puesta"
else
  (crontab -l 2>/dev/null; echo "$LINEA") | crontab -
  echo "  agregada: $LINEA"
fi

paso "Listo"
cat <<FIN
  Falta traer los datos. Si venis de otra maquina:

    # alla
    pg_dump "\$DATABASE_URL" --exclude-table-data=raw_scrape_items -Fc -f precios.dump
    scp precios.dump $USER@ESTA_MAQUINA:~/

    # aca
    pg_restore -d "\$DATABASE_URL" --data-only --disable-triggers ~/precios.dump

  Y despues, la prueba que decide si la mudanza sirvio:

    npm run scrape -- coope 20

  Si esos 20 precios coinciden con los de la maquina vieja, quedo.
FIN
