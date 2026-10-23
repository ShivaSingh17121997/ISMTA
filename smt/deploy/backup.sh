#!/usr/bin/env bash
# Nightly MongoDB backup, keeps the last 14. Install with:
#   chmod +x ~/smt/deploy/backup.sh
#   crontab -e   →   30 21 * * * /home/ubuntu/smt/deploy/backup.sh   (21:30 UTC = 03:00 IST)
set -euo pipefail
source /home/ubuntu/.smt-backup.env   # defines MONGO_URI (with the smt user's password)
mkdir -p /home/ubuntu/backups
mongodump --uri="$MONGO_URI" --archive="/home/ubuntu/backups/smt-$(date +%F).gz" --gzip
ls -1t /home/ubuntu/backups/smt-*.gz | tail -n +15 | xargs -r rm --
