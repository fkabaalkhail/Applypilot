# Cross-Source Job Dedup — LinkedIn/Indeed Twins of Direct ATS Postings

**Date:** 2026-07-16
**Status:** Approved (pre-authorized follow-up from 2026-07-15-job-catalogue-quality-design.md)
**Goal:** The same real-world posting frequently exists twice: a LinkedIn/Indeed
row (login-walled, no description, aggregator URL) and an ATS/GitHub row (full
description, direct apply link). Collapse the pair so users see one job — the
direct one.

## Problem (measured)

LinkedIn rows are 96% description-less and unrecoverable by fetching (login
wall). Many are exact twins of `ats`/`github` rows scraped from the employer's
own board. Users see the job twice; the LinkedIn copy is the broken one.

## Design decisions

- **Soft-hide, never delete.** `UserSavedJob.job_id` / `ApplicationRecord.job_id`
  reference jobs; deleting would orphan user data. New nullable column
  `scraped_jobs.duplicate_of → id` marks losers; browse/stats/cities/backfill
  exclude `duplicate_of IS NOT NULL`. `GET /jobs/{id}` still serves them, and
  the **Liked tab keeps showing saved duplicates** (a bookmark must not vanish).
- **Matching is conservative — exact normalized equality, no fuzz.**
  - Employer: `company_domain` when both rows have one (95% coverage; already
    canonicalizes "AWS"/"Amazon Web Services" → amazon.com), else folded
    company name.
  - Title: new stored `title_norm` = folded title with parentheticals,
    season words (summer/fall/winter/spring), and 4-digit years stripped;
    punctuation collapsed. "Software Engineer Intern (Summer 2026)" ==
    "Software Engineer Intern". Role-level words (intern/new grad/senior) are
    NOT stripped — different levels are different jobs.
  - Location: loser's `city` token must appear in the winner's
    `location_search` (multi-city ATS rows absorb single-city twins), or both
    cities empty. Different cities never merge.
- **Winner tiers:** `ats`/`github` (direct URL) beat `linkedin` beat `indeed`;
  ties break by longer description, then lower id. Winner is enriched from
  losers: `applicant_count`, `salary_range`, and `description` when the winner
  lacks one.
- **Prevention at ingest (both arrival orders):**
  - `ingest-batch` (LinkedIn/Indeed sources): skip inserting a job whose
    direct twin already exists (counted in `duplicates`).
  - `cron-ats` + GitHub aggregator (direct sources): after inserting, mark
    pre-existing LinkedIn/Indeed twins `duplicate_of = new id` and pull their
    enrichment fields.
- **One-time sweep** `backend/scripts/dedup_jobs.py` (column-only reads, no
  description egress): phase 1 backfills `title_norm` for all rows; phase 2
  groups by employer key + `title_norm`, applies tiers/location rules, marks
  losers and enriches winners. `--dry-run` prints the groups it would collapse.
- **Out of scope:** match_notifier (cost-sensitive, untouched); fuzzy title
  matching; deleting rows; ats↔ats re-dedup (URL uniqueness already covers).

## Schema

`title_norm VARCHAR DEFAULT ''` (+ index) and `duplicate_of INTEGER NULL`,
added to the existing idempotent `add_job_catalogue_fields` migration.

## Success criteria

- Ingesting a LinkedIn twin of an existing ATS row inserts nothing.
- Inserting an ATS row hides its pre-existing LinkedIn twin and inherits its
  `applicant_count`/`salary_range`.
- Browse/stats/cities exclude hidden rows; Liked keeps saved ones; direct
  `GET /jobs/{id}` still works.
- Prod sweep runs clean; duplicate share of the browseable feed measurably
  drops; no user-visible bookmark loss.
