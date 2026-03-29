"""
Standalone single-session entry point.

Spawned as a subprocess by the bot worker FastAPI process (main.py).
Runs one Pipecat session, then exits. Process isolation guarantees:
  - No shared event loop contention with other sessions
  - Crash in this process does not affect other sessions
  - Clean resource cleanup on process exit

Usage (called by main.py, not manually):
    python3 -m bot.session_runner \
        --session-id <id> \
        --room-name <name> \
        --token <jwt> \
        --livekit-url <url> \
        < agent.json
"""

import argparse
import asyncio
import logging
import signal
import sys

import sentry_sdk
from loguru import logger
from pipecat.audio.filters.koala_filter import KoalaFilter
from pipecat.transports.livekit.transport import LiveKitParams, LiveKitTransport
from sentry_sdk.integrations.logging import LoggingIntegration

from bot.config import config
from bot.schemas import AIAgentOut
from bot.strategies import get_orchestration_class


def setup_sentry() -> None:
    if not config.is_live or not config.SENTRY_DSN:
        return

    sentry_sdk.init(
        dsn=config.SENTRY_DSN,
        environment=config.ENV_STATE,
        release=config.APP_VERSION,
        traces_sample_rate=0.2,
        profiles_sample_rate=0.1,
        send_default_pii=False,
        integrations=[
            LoggingIntegration(
                level=logging.WARNING,
                event_level=logging.ERROR,
            ),
        ],
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Run a single Pipecat bot session")
    parser.add_argument("--session-id", required=True)
    parser.add_argument("--room-name", required=True)
    parser.add_argument("--token", required=True)
    parser.add_argument("--livekit-url", required=True)
    return parser.parse_args()


async def run_session(args: argparse.Namespace, agent: AIAgentOut) -> None:
    logger.info(
        "[{}] subprocess started | room={} orchestration={}",
        args.session_id, args.room_name, agent.orchestration_type,
    )

    audio_filter = None
    try:
        audio_filter = KoalaFilter(access_key="sONW+pJ9CZFbcOkZQpaJO1RQzfFNgunIzTN4cq8faQjTLdwaWvStkw==")
        logger.info("[{}] Koala noise cancellation enabled", args.session_id)
    except Exception as e:
        logger.warning("[{}] Failed to initialize Koala filter: {}", args.session_id, e)

    transport = LiveKitTransport(
        url=args.livekit_url,
        token=args.token,
        room_name=args.room_name,
        params=LiveKitParams(
            audio_in_enabled=True,
            audio_out_enabled=True,
            audio_in_filter=audio_filter,
        ),
    )

    orchestration_cls = get_orchestration_class(agent.orchestration_type)
    orchestration = orchestration_cls(agent=agent, transport=transport)

    logger.info(
        "[{}] orchestration starting | cls={}",
        args.session_id, orchestration_cls.__name__,
    )

    await orchestration.run()

    logger.info("[{}] orchestration completed normally", args.session_id)


def main() -> None:
    setup_sentry()
    args = parse_args()

    # Read agent JSON from stdin (piped by parent process)
    agent_json = sys.stdin.read()
    if not agent_json:
        logger.error("[{}] no agent data received on stdin", args.session_id)
        sys.exit(1)

    agent = AIAgentOut.model_validate_json(agent_json)

    # Set up graceful shutdown: SIGTERM triggers cancellation of the running session
    loop = asyncio.new_event_loop()
    session_task = None

    def handle_signal(sig, _frame):
        logger.info("[{}] received signal {} — cancelling session", args.session_id, sig)
        if session_task and not session_task.done():
            session_task.cancel()

    signal.signal(signal.SIGTERM, handle_signal)
    signal.signal(signal.SIGINT, handle_signal)

    async def _run():
        nonlocal session_task
        session_task = asyncio.current_task()
        try:
            await run_session(args, agent)
        except asyncio.CancelledError:
            logger.info("[{}] session cancelled (graceful shutdown)", args.session_id)
        except Exception:
            logger.exception("[{}] session crashed", args.session_id)
            sys.exit(1)

    try:
        loop.run_until_complete(_run())
    except KeyboardInterrupt:
        logger.info("[{}] interrupted", args.session_id)
    finally:
        loop.close()


if __name__ == "__main__":
    main()
