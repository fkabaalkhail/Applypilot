"""Symmetric encryption using Fernet (AES-128-CBC + HMAC-SHA256)."""

import os
import logging

from cryptography.fernet import Fernet

logger = logging.getLogger(__name__)

_ENCRYPTION_KEY = os.getenv("ENCRYPTION_KEY", "")


def _get_cipher() -> Fernet:
    """Get the Fernet cipher instance. Raises if key is not configured."""
    if not _ENCRYPTION_KEY:
        raise RuntimeError(
            "ENCRYPTION_KEY environment variable is required. "
            "Generate one with: python -c \"from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())\""
        )
    return Fernet(_ENCRYPTION_KEY.encode())


def encrypt(value: str) -> str:
    """Encrypt a string value. Returns base64-encoded ciphertext."""
    if not value:
        return ""
    cipher = _get_cipher()
    return cipher.encrypt(value.encode()).decode()


def decrypt(value: str) -> str:
    """Decrypt a previously encrypted value."""
    if not value:
        return ""
    cipher = _get_cipher()
    return cipher.decrypt(value.encode()).decode()
