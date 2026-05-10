"""
LLM service factory — returns GeminiService or OllamaService based on LLM_PROVIDER env var.

Usage:
    from backend.services.llm import get_llm_service
    llm = get_llm_service()
"""

import os


def get_llm_service():
    """Return the configured LLM service instance."""
    provider = os.getenv("LLM_PROVIDER", "gemini").lower()
    if provider == "gemini":
        from backend.services.gemini_service import GeminiService
        return GeminiService()
    else:
        from backend.services.ollama_service import OllamaService
        return OllamaService()
