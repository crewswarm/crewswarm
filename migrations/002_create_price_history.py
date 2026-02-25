from alembic import op
import sqlalchemy as sa


def up():
    op.create_table(
        "price_history",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("market_id", sa.Text, nullable=False),
        sa.Column("timestamp", sa.DateTime, nullable=False),
        sa.Column("price", sa.Float, nullable=False),
    )


def down():
    op.drop_table("price_history")
