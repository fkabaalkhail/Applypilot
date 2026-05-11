"""LLM service — uses GeminiService."""

from backend.services.gemini_service import GeminiService


def get_llm_service():
    """Return the configured LLM service instance."""
    return GeminiService()
