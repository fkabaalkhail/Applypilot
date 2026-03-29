import base64
import json
from functools import lru_cache

from pydantic import computed_field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Config(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    # Pod identity
    INSTANCE_ID: str = ""
    HOSTNAME: str = "bot-worker-unknown"

    # Session limits (each session is a subprocess — ~150MB each)
    MAX_SESSIONS: int = 3
    CPU_THRESHOLD: int = 80
    MEM_THRESHOLD: int = 80
    MAX_SESSION_TIME: int = 300  # seconds

    # Redis
    REDIS_URL: str = "redis://redis:6379/2"

    # Main app
    APP_URL: str = "http://hams-app:80"
    WORKER_API_KEY: str

    # LiveKit
    LIVEKIT_URL: str = ""

    # Internal auth — bot_runner must send this to reach /start-session
    BOT_WORKER_API_KEY: str

    # Server
    HOST: str = "0.0.0.0"
    PORT: int = 8080

    # Sentry
    SENTRY_DSN: str = ""
    ENV_STATE: str = "development"
    APP_VERSION: str = "0.0.0"

    @property
    def is_live(self) -> bool:
        return self.ENV_STATE in ("staging", "production")

    # Fallback API keys (used when agent config doesn't supply its own)
    OPENAI_API_KEY: str = ""
    OPENAI_BASE_URL: str = "https://api.openai.com/v1"
    ELEVENLABS_API_KEY: str = ""
    AWS_ACCESS_KEY_ID: str = ""
    AWS_SECRET_ACCESS_KEY: str = ""
    AWS_REGION: str = "eu-central-1"
    KOALA_ACCESS_KEY: str = "" 

    # GCS — call recordings
    GCP_CREDENTIALS_JSON: str = ""     # Base64-encoded service account JSON
    # GCS bucket for stereo recordings
    CALL_RECORDS_BUCKET_NAME: str

    @computed_field  # type: ignore
    @property
    def gcp_credentials_decoded(self) -> dict | None:
        if not self.GCP_CREDENTIALS_JSON:
            return None
        return json.loads(base64.b64decode(self.GCP_CREDENTIALS_JSON).decode("utf-8"))

    @property
    def pod_name(self) -> str:
        return self.INSTANCE_ID or self.HOSTNAME


@lru_cache(maxsize=1)
def get_config() -> Config:
    return Config()  # type: ignore


config = get_config()
