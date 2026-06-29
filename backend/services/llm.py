"""LLM service — uses OpenAIService (OpenAI Chat Completions)."""

from backend.services.openai_service import OpenAIService


def get_llm_service():
    """Return the configured LLM service instance."""
    return OpenAIService()
