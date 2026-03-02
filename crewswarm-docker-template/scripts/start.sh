#!/bin/bash
set -e

echo "[crewswarm] Starting CrewSwarm services..."

# Bootstrap ~/.crewswarm if it doesn't exist
if [ ! -f "/root/.crewswarm/crewswarm.json" ]; then
    echo "[crewswarm] Bootstrapping config directory..."
    node scripts/bootstrap.mjs
fi

# Wait for database
echo "[crewswarm] Waiting for database..."
until pg_isready -h ${DB_HOST:-crewswarm-db} -p ${DB_PORT:-5432} -U ${DB_USER:-crewswarm}; do
    echo "[crewswarm] Database not ready, waiting..."
    sleep 2
done

echo "[crewswarm] Database ready, starting application..."

# Start the main application
exec node app/main.mjs
