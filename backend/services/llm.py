"""LLM service — uses AnthropicService (Claude)."""

from backend.services.anthropic_service import AnthropicService


def get_llm_service():
    """Return the configured LLM service instance."""
    return AnthropicService()
