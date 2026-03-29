"""
Simple encryption for storing credentials at rest.

Uses Fernet symmetric encryption. The key is derived from a secret
in the environment (or auto-generated and stored in data/secret.key).
"""

import os
import base64
import hashlib
from pathlib import Path
from cryptography.fernet import Fernet


def _get_key() -> bytes:
    """
    Get or create the encryption key.

    If ENCRYPTION_SECRET is set in env, derive a key from it.
    Otherwise, generate one and persist it to data/secret.key.
    """
    secret = os.getenv("ENCRYPTION_SECRET")
    if secret:
        # Derive a 32-byte key from the secret
        key = hashlib.sha256(secret.encode()).digest()
        return base64.urlsafe_b64encode(key)

    key_path = Path("data/secret.key")
    if key_path.exists():
        return key_path.read_bytes()

    key_path.parent.mkdir(parents=True, exist_ok=True)
    key = Fernet.generate_key()
    key_path.write_bytes(key)
    return key


_fernet = Fernet(_get_key())


def encrypt(plaintext: str) -> str:
    """Encrypt a string and return base64-encoded ciphertext."""
    if not plaintext:
        return ""
    return _fernet.encrypt(plaintext.encode()).decode()


def decrypt(ciphertext: str) -> str:
    """Decrypt a base64-encoded ciphertext back to plaintext."""
    if not ciphertext:
        return ""
    return _fernet.decrypt(ciphertext.encode()).decode()
