from migrations.version_002_create_price_history import up as migration_002_up
from migrations.version_003_create_strategies import up as migration_003_up


def run_migrations():
    migration_002_up()
    migration_003_up()
