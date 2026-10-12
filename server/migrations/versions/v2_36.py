"""Persistent renewable user login sessions. Revision v2_36, revises v2_35."""

import time
from datetime import UTC, datetime

import sqlalchemy as sa
from alembic import op

revision = "v2_36"
down_revision = "v2_35"
branch_labels = None
depends_on = None


def upgrade():
    for table in ("users", "oauth_authorization_codes", "mobile_login_tokens"):
        op.add_column(
            table,
            sa.Column("auth_version", sa.Integer(), nullable=False, server_default="0"),
        )
    op.add_column(
        "users",
        sa.Column(
            "legacy_auth_revoked", sa.Integer(), nullable=False, server_default="0"
        ),
    )
    op.create_table(
        "auth_sessions",
        sa.Column("id", sa.Text(), primary_key=True),
        sa.Column(
            "user_id",
            sa.Text(),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("client_id", sa.Text(), nullable=False),
        sa.Column("transport", sa.Text(), nullable=False),
        sa.Column("scope", sa.Text(), nullable=False, server_default=""),
        sa.Column("credential_hash", sa.Text(), nullable=False, unique=True),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("created_at", sa.BigInteger(), nullable=False),
        sa.Column("idle_expires_at", sa.BigInteger(), nullable=False),
        sa.Column("absolute_expires_at", sa.BigInteger()),
        sa.Column("revoked_at", sa.BigInteger()),
    )
    op.create_index("idx_auth_sessions_user", "auth_sessions", ["user_id"])
    op.create_table(
        "auth_refresh_history",
        sa.Column("credential_hash", sa.Text(), primary_key=True),
        sa.Column(
            "session_id",
            sa.Text(),
            sa.ForeignKey("auth_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("attempt_hash", sa.Text(), nullable=False),
        sa.Column("generation", sa.Integer(), nullable=False),
        sa.Column("recover_until", sa.BigInteger(), nullable=False),
        sa.Column("response_encrypted", sa.Text(), nullable=False),
    )
    op.create_index(
        "idx_auth_refresh_history_session", "auth_refresh_history", ["session_id"]
    )
    op.create_table(
        "auth_session_upgrades",
        sa.Column("key", sa.Text(), primary_key=True),
        sa.Column("legacy_hash", sa.Text(), nullable=False),
        sa.Column("source_sid", sa.Text()),
        sa.Column(
            "session_id",
            sa.Text(),
            sa.ForeignKey("auth_sessions.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("recover_until", sa.BigInteger(), nullable=False),
        sa.Column("response_encrypted", sa.Text(), nullable=False),
    )
    op.create_index(
        "idx_auth_session_upgrades_legacy", "auth_session_upgrades", ["legacy_hash"]
    )
    op.get_bind().execute(
        sa.text(
            "INSERT INTO instance_settings (key, value, updated_at) VALUES (:key, :value, :updated)"
        ),
        {
            "key": "auth_legacy_upgrade_until",
            "value": str(int(time.time()) + 30 * 86400),
            "updated": datetime.now(UTC).isoformat(),
        },
    )


def downgrade():
    op.get_bind().execute(
        sa.text("DELETE FROM instance_settings WHERE key = 'auth_legacy_upgrade_until'")
    )
    op.drop_table("auth_session_upgrades")
    op.drop_table("auth_refresh_history")
    op.drop_table("auth_sessions")
    with op.batch_alter_table("users") as batch:
        batch.drop_column("legacy_auth_revoked")
    for table in ("users", "oauth_authorization_codes", "mobile_login_tokens"):
        with op.batch_alter_table(table) as batch:
            batch.drop_column("auth_version")
