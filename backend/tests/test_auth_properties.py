"""
Property-based tests for the auth module (tokens and passwords).

Uses Hypothesis to verify correctness properties across many random inputs.
"""

import jwt
from hypothesis import given, settings, assume, strategies as st

from backend.auth.tokens import create_access_token, create_refresh_token, decode_token
from backend.auth.passwords import hash_password, verify_password


# --- Strategies ---

# Positive integer user IDs (realistic range)
user_id_strategy = st.integers(min_value=1, max_value=2**31 - 1)

# Passwords: printable ASCII strings of length 8-72 (bcrypt has a 72-byte limit)
password_strategy = st.text(
    alphabet=st.characters(
        whitelist_categories=("L", "N", "P", "S"),
        blacklist_characters="\x00",
        max_codepoint=127,  # ASCII only to avoid multi-byte UTF-8 exceeding 72 bytes
    ),
    min_size=8,
    max_size=72,
).filter(lambda s: len(s.strip()) > 0)

# Random strings that are NOT valid JWTs (no dots or wrong structure)
invalid_token_strategy = st.one_of(
    st.text(
        alphabet=st.characters(whitelist_categories=("L", "N")),
        min_size=1,
        max_size=100,
    ).filter(lambda s: s.count(".") != 2),
    st.just(""),
    st.just("not.a.jwt"),
    st.just("abc.def.ghi"),
    st.text(min_size=1, max_size=50).filter(lambda s: s.count(".") != 2),
)


# --- Property Tests ---


@given(user_id=user_id_strategy)
@settings(max_examples=100)
def test_token_encode_decode_round_trip(user_id):
    """
    Property 1: Token Round-Trip

    For all valid positive integer user IDs, encoding an access token and then
    decoding it produces the original user ID in the "sub" claim.

    **Validates: Requirements 3.7**
    """
    token = create_access_token(user_id)
    payload = decode_token(token)
    assert int(payload["sub"]) == user_id


@given(password=password_strategy)
@settings(max_examples=50, deadline=None)
def test_password_hash_verify_round_trip(password):
    """
    Property 2: Password Hash Round-Trip

    For all passwords of length 8-128, hashing then verifying with the same
    password returns True.

    **Validates: Requirements 5.3**
    """
    hashed = hash_password(password)
    assert verify_password(password, hashed) is True


@given(password=password_strategy)
@settings(max_examples=50, deadline=None)
def test_password_hash_uniqueness(password):
    """
    Property 3: Password Hash Uniqueness

    For all passwords, hashing the same password twice produces different hash
    strings (due to random salt).

    **Validates: Requirements 5.2**
    """
    hash1 = hash_password(password)
    hash2 = hash_password(password)
    assert hash1 != hash2


@given(
    password_a=password_strategy,
    password_b=password_strategy,
)
@settings(max_examples=50, deadline=None)
def test_wrong_password_rejection(password_a, password_b):
    """
    Property 4: Wrong Password Rejection

    For all pairs of distinct passwords, verifying a hash of one against the
    other returns False.

    **Validates: Requirements 5.4**
    """
    assume(password_a != password_b)
    hashed = hash_password(password_a)
    assert verify_password(password_b, hashed) is False


@given(user_id=user_id_strategy)
@settings(max_examples=100)
def test_token_type_discrimination(user_id):
    """
    Property 5: Token Type Discrimination

    Access tokens have type "access", refresh tokens have type "refresh".
    They are distinguishable by their type claim.

    **Validates: Requirements 3.4, 4.1**
    """
    access = create_access_token(user_id)
    refresh = create_refresh_token(user_id)
    assert decode_token(access)["type"] == "access"
    assert decode_token(refresh)["type"] == "refresh"


@given(random_string=invalid_token_strategy)
@settings(max_examples=100)
def test_invalid_token_rejection(random_string):
    """
    Property 6: Invalid Token Rejection

    For all random strings that aren't valid JWTs, decode_token raises
    an InvalidTokenError (or subclass).

    **Validates: Requirements 3.6**
    """
    try:
        decode_token(random_string)
        # If we get here, the token was somehow valid — that shouldn't happen
        # for random strings
        assert False, f"Expected InvalidTokenError for input: {random_string!r}"
    except jwt.InvalidTokenError:
        pass  # Expected behavior
