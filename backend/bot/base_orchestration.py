import asyncio
from abc import ABC, abstractmethod

from loguru import logger
from pipecat.processors.audio.audio_buffer_processor import AudioBufferProcessor
from pipecat.transports.base_transport import BaseTransport

from bot.config import config
from bot.schemas import AIAgentOut
from bot.utils.gcs_upload import upload_recording_to_gcs


class BaseOrchestration(ABC):
    def __init__(self, agent: AIAgentOut, transport: BaseTransport):
        self.agent = agent
        self.transport = transport

    @abstractmethod
    async def run(self) -> None:
        """Run the voice bot with the given configuration"""
        pass

    @property
    def recording_enabled(self) -> bool:
        return bool(
            config.CALL_RECORDS_BUCKET_NAME
            and config.GCP_CREDENTIALS_JSON
            and self.agent.security_settings.data_storage != 'basic_attributes_only'
        )

    def build_audiobuffer(self) -> AudioBufferProcessor | None:
        if not self.recording_enabled:
            return None

        return AudioBufferProcessor(
            num_channels=2,
        )

    def setup_recording_handler(
        self,
        audiobuffer: AudioBufferProcessor,
        recording_result: dict,
    ) -> None:
        """Register on_audio_data to upload directly when audio is ready.

        ``recording_result`` will be populated with:
          - "url": the GCS blob path (or None on failure)
          - "_done": an asyncio.Event set after the upload finishes
        """
        recording_result["_done"] = asyncio.Event()
        recording_result["url"] = None

        @audiobuffer.event_handler("on_audio_data")
        async def on_audio_data(buffer, audio: bytes, sample_rate: int, num_channels: int):
            logger.info(
                "on_audio_data: {} bytes, {}Hz, {} ch",
                len(audio), sample_rate, num_channels,
            )
            try:
                blob = await asyncio.to_thread(
                    upload_recording_to_gcs,
                    audio,
                    sample_rate,
                    num_channels,
                    self.agent.entity_id,
                    self.agent.id,
                    recording_result.get("call_id", "unknown"),
                )
                recording_result["url"] = blob
            except Exception:
                logger.exception("Recording upload failed")
            finally:
                recording_result["_done"].set()

    async def wait_for_recording(self, recording_result: dict, timeout: float = 10.0) -> str | None:
        """Wait for the on_audio_data upload to finish and return the GCS URL."""
        done: asyncio.Event | None = recording_result.get("_done")
        if not done:
            return None
        try:
            await asyncio.wait_for(done.wait(), timeout=timeout)
        except asyncio.TimeoutError:
            logger.warning("Timed out waiting for recording upload")
        return recording_result.get("url")
