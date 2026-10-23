#!/usr/bin/env bash
# Deploy a new version uploaded to ~/smt-new.tgz. Run OUTSIDE market hours (after 15:30 IST).
# It stops the backend first, so the engine is never mid-order during the swap.
set -euo pipefail
cd /home/ubuntu
sudo systemctl stop smt-fe smt-be
tar -xzf smt-new.tgz          # overwrites code, keeps .env files and BE/.cache (they are not in the archive)
cd smt/BE && npm ci && npm run build
cd ../FE/ismta && npm ci && npm run build
sudo systemctl start smt-be smt-fe
sleep 5 && sudo systemctl --no-pager status smt-be smt-fe | head -20
