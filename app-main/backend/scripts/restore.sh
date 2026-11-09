#!/usr/bin/env bash
# Restaure une sauvegarde : scripts/restore.sh <fichier> [base_cible]
# Par défaut restaure dans "<DB_NAME>_restore_test" (vérification sans toucher la production).
# Passer DB_NAME explicitement en 2e argument pour une vraie restauration (écrase la base, --drop).
set -euo pipefail
cd "$(dirname "$0")/.."
env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
MONGO_URL="$(env_get MONGO_URL)"; DB_NAME="$(env_get DB_NAME)"
FILE="$1"; TARGET="${2:-${DB_NAME}_restore_test}"
mongorestore --uri="$MONGO_URL" --archive="$FILE" --gzip --drop --quiet \
  --nsFrom="${DB_NAME}.*" --nsTo="${TARGET}.*"
echo "Restauré dans $TARGET"
