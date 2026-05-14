"""Auth module - re-exports main dependencies."""
from backend.auth.dependencies import get_current_user, get_current_user_id, get_optional_user_id

__all__ = ["get_current_user", "get_current_user_id", "get_optional_user_id"]
