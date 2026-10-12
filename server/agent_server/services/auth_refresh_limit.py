"""Bound refresh traffic without storing raw credentials in coordination keys."""

from __future__ import annotations

import time
from collections import OrderedDict

from agent_server.services.auth_sessions import digest, setting


class RefreshRateLimited(Exception):
    pass


class AuthRefreshLimit:
    def __init__(self, coordinator):
        self.coordinator = coordinator
        self.local = OrderedDict()

    async def check(self, remote_address, credential):
        buckets = (
            (
                "ip",
                remote_address,
                setting("AGENT_SERVER_REFRESH_IP_PER_MINUTE", 120),
            ),
            (
                "credential",
                credential or "missing",
                setting("AGENT_SERVER_REFRESH_CREDENTIAL_PER_MINUTE", 60),
            ),
        )
        for kind, identity, limit in buckets:
            key = self.coordinator.key("auth-refresh", kind, digest(identity))
            if self.coordinator.distributed:
                # Transactional INCR and first-use expiry: no immortal counter
                # after a worker crash; all workers share the same budget.
                async with self.coordinator.client.pipeline(
                    transaction=True
                ) as pipeline:
                    pipeline.incr(key)
                    pipeline.expire(key, 60, nx=True)
                    count, _ = await pipeline.execute()
            else:
                now = time.monotonic()
                count, until = self.local.pop(key, (0, now + 60))
                if now >= until:
                    count, until = 0, now + 60
                count += 1
                self.local[key] = (count, until)
                while len(self.local) > 4096:
                    self.local.popitem(last=False)
            if count > limit:
                raise RefreshRateLimited()
