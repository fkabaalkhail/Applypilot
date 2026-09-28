"""
Tests for cron-ats registry sharding.

One cron-ats invocation must fit a single Vercel request (300 s cap in the
workflow). Sharding slices the registry deterministically by board slug so
each run scrapes ~CRON_ATS_SHARD_TARGET companies. The "hourly" schedule
really fires ~6x a day at uneven gaps, so the run crawls the shard that has
waited longest (pick_shard) rather than hour % shard_count, which let one
shard go 38 h without a crawl.
"""

import datetime

import pytest

from backend.data.company_registry import (
    CRON_ATS_SHARD_TARGET,
    pick_shard,
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
        exactly once, no board lost, none double-scraped."""
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


def _stamps(subset, when):
    return {f"{platform}:{slug}": when for platform, slug, _ in subset}


class TestPickShard:
    NOW = datetime.datetime(2026, 9, 28, 1, 0, 0)

    def _shards(self, companies):
        _, count, _ = shard_for_hour(companies, hour=0)
        return [shard_for_hour(companies, hour=i)[2] for i in range(count)]

    def test_picks_the_shard_crawled_least_recently(self):
        companies = _fake_companies(400)
        shards = self._shards(companies)
        assert len(shards) == 3
        last = {}
        last.update(_stamps(shards[0], self.NOW - datetime.timedelta(hours=1)))
        last.update(_stamps(shards[1], self.NOW - datetime.timedelta(hours=30)))
        last.update(_stamps(shards[2], self.NOW - datetime.timedelta(hours=5)))

        index, count, subset = pick_shard(companies, last)
        assert (index, count) == (1, 3)
        assert subset == shards[1]

    def test_irregular_firing_cannot_starve_a_shard(self):
        """Whatever hours the cron happens to fire at, consecutive runs
        rotate through every shard."""
        companies = _fake_companies(400)
        last: dict = {}
        crawled = []
        now = self.NOW
        for _run in range(6):
            index, _count, subset = pick_shard(companies, last)
            crawled.append(index)
            last.update(_stamps(subset, now))
            now += datetime.timedelta(hours=4, minutes=7)
        assert crawled == [0, 1, 2, 0, 1, 2]

    def test_never_crawled_shard_goes_first(self):
        companies = _fake_companies(400)
        shards = self._shards(companies)
        last = {}
        last.update(_stamps(shards[0], self.NOW))
        last.update(_stamps(shards[2], self.NOW - datetime.timedelta(days=3)))
        assert pick_shard(companies, last)[0] == 1

    def test_a_failing_board_does_not_pin_its_shard(self):
        """A board that 404s forever keeps an ancient last_success_at; its
        shard's last run is the newest stamp among its boards."""
        companies = _fake_companies(400)
        shards = self._shards(companies)
        last = {}
        for i, shard in enumerate(shards):
            last.update(_stamps(shard, self.NOW - datetime.timedelta(hours=i + 1)))
        platform, slug, _ = shards[0][0]
        last[f"{platform}:{slug}"] = self.NOW - datetime.timedelta(days=60)

        assert pick_shard(companies, last)[0] == 2

    def test_timezone_aware_stamps_compare(self):
        companies = _fake_companies(400)
        shards = self._shards(companies)
        last = {}
        last.update(_stamps(shards[0], datetime.datetime(2026, 9, 28, 1, tzinfo=datetime.timezone.utc)))
        last.update(_stamps(shards[1], self.NOW - datetime.timedelta(hours=2)))
        last.update(_stamps(shards[2], self.NOW))
        assert pick_shard(companies, last)[0] == 1

    def test_single_shard_registry(self):
        companies = _fake_companies(10)
        assert pick_shard(companies, {}) == (0, 1, companies)

    def test_shards_still_partition_the_registry(self):
        companies = _fake_companies(400)
        last: dict = {}
        seen = []
        for _run in range(3):
            _index, _count, subset = pick_shard(companies, last)
            seen.extend(subset)
            last.update(_stamps(subset, self.NOW + datetime.timedelta(hours=_run)))
        assert sorted(seen) == sorted(companies)


class TestCronAtsUsesShard:
    def test_cron_ats_scrapes_only_one_shard(self, client, monkeypatch):
        """The endpoint must crawl one shard of boards, not the whole
        registry."""
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

    def test_cron_ats_crawls_the_least_recently_crawled_shard(self, client, db_session, monkeypatch):
        """source_health says shard 0 ran an hour ago and shard 1 a day ago:
        the run takes shard 1, whatever the hour."""
        import backend.auth.dependencies as auth_deps
        from backend.db.models import SourceHealth
        from backend.services.ats_scraper import ATSScraper, BoardSnapshot
        from backend.data import company_registry

        monkeypatch.setattr(auth_deps, "CRON_SECRET", "test-cron-secret")
        companies = _fake_companies(200)  # 2 shards
        monkeypatch.setattr(company_registry, "load_companies", lambda **kw: companies)
        _, _, shard0 = shard_for_hour(companies, hour=0)
        _, _, shard1 = shard_for_hour(companies, hour=1)

        now = datetime.datetime.utcnow()
        for subset, age_hours in ((shard0, 1), (shard1, 24)):
            for platform, slug, _ in subset:
                db_session.add(SourceHealth(
                    board_key=f"{platform}:{slug}", platform=platform, slug=slug,
                    last_success_at=now - datetime.timedelta(hours=age_hours),
                ))
        db_session.commit()

        scraped: list[tuple[str, str, str]] = []

        async def fake_scrape_board(self, client, platform, slug, company_name):
            scraped.append((platform, slug, company_name))
            return BoardSnapshot(platform=platform, slug=slug, company=company_name)

        monkeypatch.setattr(ATSScraper, "scrape_board", fake_scrape_board)

        resp = client.post(
            "/github-sources/cron-ats",
            headers={"x-cron-secret": "test-cron-secret"},
        )
        assert resp.status_code == 200
        assert resp.json()["shard"]["index"] == 1
        assert sorted(scraped) == sorted(shard1)
