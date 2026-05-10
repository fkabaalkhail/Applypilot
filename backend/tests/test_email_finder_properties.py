"""
Property-based tests for EmailFinder service.

Uses Hypothesis to verify correctness properties across many random inputs.
"""

# Feature: job-dashboard-apply, Property 5: LinkedIn URL Validation

from hypothesis import given, settings, strategies as st

from backend.services.email_finder import validate_linkedin_url


# --- Strategies ---

# Valid LinkedIn slug characters: alphanumeric, hyphens, underscores
linkedin_slug = st.text(
    alphabet=st.sampled_from(
        "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
    ),
    min_size=1,
    max_size=40,
)

# Optional query parameters
query_params = st.one_of(
    st.just(""),
    st.builds(
        lambda key, val: f"?{key}={val}",
        key=st.text(
            alphabet=st.characters(whitelist_categories=("L", "N")),
            min_size=1,
            max_size=10,
        ),
        val=st.text(
            alphabet=st.characters(whitelist_categories=("L", "N")),
            min_size=1,
            max_size=10,
        ),
    ),
)


# --- Property Tests ---


@given(slug=linkedin_slug, trailing_slash=st.booleans(), query=query_params)
@settings(max_examples=100)
def test_valid_linkedin_urls_accepted(slug, trailing_slash, query):
    """
    Property 5: LinkedIn URL Validation (valid URLs)

    For any valid LinkedIn profile slug (alphanumeric, hyphens, underscores),
    constructing https://www.linkedin.com/in/{slug} with optional trailing
    slash and query params shall return True.

    **Validates: Requirements 5.5**
    """
    url = f"https://www.linkedin.com/in/{slug}"
    if trailing_slash:
        url += "/"
    url += query
    assert validate_linkedin_url(url) is True, (
        f"Expected valid LinkedIn URL to be accepted: {url!r}"
    )


@given(
    url=st.one_of(
        # Other LinkedIn paths (not /in/)
        st.builds(
            lambda slug: f"https://www.linkedin.com/company/{slug}",
            slug=linkedin_slug,
        ),
        st.builds(
            lambda slug: f"https://www.linkedin.com/jobs/{slug}",
            slug=linkedin_slug,
        ),
        st.builds(
            lambda slug: f"https://www.linkedin.com/pub/{slug}",
            slug=linkedin_slug,
        ),
        # Other domains with /in/ path
        st.builds(
            lambda domain, slug: f"https://www.{domain}.com/in/{slug}",
            domain=st.sampled_from(["facebook", "twitter", "github", "example"]),
            slug=linkedin_slug,
        ),
        # HTTP-only (not HTTPS)
        st.builds(
            lambda slug: f"http://www.linkedin.com/in/{slug}",
            slug=linkedin_slug,
        ),
        # Missing www subdomain
        st.builds(
            lambda slug: f"https://linkedin.com/in/{slug}",
            slug=linkedin_slug,
        ),
        # Empty slug (just /in/ with nothing after)
        st.just("https://www.linkedin.com/in/"),
        st.just("https://www.linkedin.com/in"),
        # Random strings
        st.text(min_size=0, max_size=50).filter(
            lambda s: not s.startswith("https://www.linkedin.com/in/")
            or len(s) == len("https://www.linkedin.com/in/")
        ),
    )
)
@settings(max_examples=100)
def test_invalid_linkedin_urls_rejected(url):
    """
    Property 5: LinkedIn URL Validation (invalid URLs)

    For any string that is NOT a valid LinkedIn profile URL (other LinkedIn
    paths like /company/, other domains, HTTP-only, missing www, random
    strings), the validator shall return False.

    **Validates: Requirements 5.5**
    """
    assert validate_linkedin_url(url) is False, (
        f"Expected invalid URL to be rejected: {url!r}"
    )
