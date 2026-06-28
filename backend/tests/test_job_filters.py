"""Tests for dashboard job filter helpers."""

import datetime

from backend.services.job_filters import (
    date_posted_cutoff,
    expand_experience_filter_values,
)


def test_expand_experience_intern_new_grad():
    values = expand_experience_filter_values(["intern_new_grad"])
    assert "internship" in values
    assert "new_grad" in values


def test_expand_experience_passthrough():
    values = expand_experience_filter_values(["new_grad"])
    assert values == ["new_grad"]


def test_date_posted_cutoff_24h():
    cutoff = date_posted_cutoff("24h")
    assert cutoff is not None
    delta = datetime.datetime.utcnow() - cutoff
    assert datetime.timedelta(hours=23, minutes=30) < delta < datetime.timedelta(hours=24, minutes=30)


def test_date_posted_cutoff_week():
    cutoff = date_posted_cutoff("week")
    assert cutoff is not None
    delta = datetime.datetime.utcnow() - cutoff
    assert datetime.timedelta(days=6, hours=23) < delta < datetime.timedelta(days=7, hours=1)
