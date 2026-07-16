"""
Tests for cron-ats registry sharding.

One cron-ats invocation must fit a single Vercel request (300 s cap in the
workflow). Sharding slices the registry deterministically by board slug so
each hourly run scrapes ~CRON_ATS_SHARD_TARGET companies and every board is
still refreshed every shard_count hours.
"""

import pytest

from backend.data.company_registry import (
    CRON_ATS_SHARD_TARGET,
    shard_for_hour,
)


def _fake_companies(n):
    return [("greenhouse", f"board-{i}", f"Company {i}") for i in range(n)]


class TestShardForHour:
    def test_small_registry_is_a_single_shard(self):
        companies = _fake_companies(CRON_ATS_SHARD_TARGET)
        index, count, subset = shard_for_hour(companies, hour=7)
        assert count == 1
        assert index == 0
        assert subset == companies

    def test_default_shard_count_sizes_slices_near_target(self):
        companies = _fake_companies(CRON_ATS_SHARD_TARGET * 2 + 1)  # 301 -> 3 shards
        _, count, _ = shard_for_hour(companies, hour=0)
        assert count == 3

    def test_shards_partition_the_registry(self):
        """Across shard_count consecutive hours, every company is scraped
        exactly once — no board lost, none double-scraped."""
        companies = _fake_companies(400)
        _, count, _ = shard_for_hour(companies, hour=0)
        assert count > 1

        seen = []
        for hour in range(count):
            _, _, subset = shard_for_hour(companies, hour=hour)
            seen.extend(subset)

        assert sorted(seen) == sorted(companies)

    def test_deterministic_across_calls(self):
        companies = _fake_companies(400)
        a = shard_for_hour(companies, hour=5)
        b = shard_for_hour(companies, hour=5)
        assert a == b

    def test_hour_wraps_past_shard_count(self):
        companies = _fake_companies(400)
        _, count, subset_h0 = shard_for_hour(companies, hour=0)
        _, _, subset_wrapped = shard_for_hour(companies, hour=count)
        assert subset_h0 == subset_wrapped

    def test_env_override(self, monkeypatch):
        monkeypatch.setenv("CRON_ATS_SHARDS", "4")
        companies = _fake_companies(40)
        index, count, subset = shard_for_hour(companies, hour=9)
        assert count == 4
        assert index == 9 % 4
        assert len(subset) < 40

    def test_invalid_env_override_falls_back(self, monkeypatch):
        monkeypatch.setenv("CRON_ATS_SHARDS", "banana")
        companies = _fake_companies(10)
        _, count, subset = shard_for_hour(companies, hour=0)
        assert count == 1
        assert subset == companies

    def test_empty_registry(self):
        index, count, subset = shard_for_hour([], hour=3)
        assert count == 1
        assert subset == []


class TestCronAtsUsesShard:
    def test_cron_ats_scrapes_only_this_hours_shard(self, client, monkeypatch):
        """The endpoint must crawl the hour's shard of boards, not the
        whole registry."""
        import backend.auth.dependencies as auth_deps
        from backend.services.ats_scraper import ATSScraper, BoardSnapshot
        from backend.data import company_registry

        monkeypatch.setattr(auth_deps, "CRON_SECRET", "test-cron-secret")

        companies = _fake_companies(400)
        monkeypatch.setattr(
            company_registry, "load_companies", lambda **kw: companies
        )

        scraped: list[tuple[str, str]] = []

        async def fake_scrape_board(self, client, platform, slug, company_name):
            scraped.append((platform, slug))
            return BoardSnapshot(platform=platform, slug=slug, company=company_name)

        monkeypatch.setattr(ATSScraper, "scrape_board", fake_scrape_board)

        resp = client.post(
            "/github-sources/cron-ats",
            headers={"x-cron-secret": "test-cron-secret"},
        )
        assert resp.status_code == 200
        data = resp.json()

        assert 0 < len(scraped) < 400
        assert data["shard"]["count"] > 1
        assert data["shard"]["companies"] == len(scraped)
