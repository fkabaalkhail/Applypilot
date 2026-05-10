"""Minimal encrypt/decrypt using base64 (placeholder for real encryption)."""

import base64


def encrypt(value: str) -> str:
    if not value:
        return ""
    return base64.b64encode(value.encode()).decode()


def decrypt(value: str) -> str:
    if not value:
        return ""
    return base64.b64decode(value.encode()).decode()
