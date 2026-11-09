#!/usr/bin/env bash
# Sauvegarde MongoDB compressée (à planifier quotidiennement). Usage : scripts/backup.sh [dossier]
# Restauration : scripts/restore.sh <fichier.archive.gz>. Ne contient jamais le fichier .env.
set -euo pipefail
cd "$(dirname "$0")/.."
env_get() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -e 's/^"//' -e 's/"$//'; }
MONGO_URL="$(env_get MONGO_URL)"; DB_NAME="$(env_get DB_NAME)"
DEST="${1:-${BACKUP_DIR:-/app/backups}}"
KEEP="${BACKUP_KEEP:-14}"
mkdir -p "$DEST"
FILE="$DEST/skycommunity-$(date -u +%Y%m%dT%H%M%SZ).archive.gz"
mongodump --uri="$MONGO_URL" --db="$DB_NAME" --archive="$FILE" --gzip --quiet
ls -1t "$DEST"/skycommunity-*.archive.gz | tail -n +$((KEEP + 1)) | xargs -r rm -f
echo "$FILE"
