from typing import Type

from bot.base_orchestration import BaseOrchestration
from bot.conversation_flow_v2.orchestration import ConversationFlowOrchestration
from bot.single_prompt.orchestration import SinglePromptOrchestration
from bot.squad.orchestration import SquadOrchestration

# Registry mapping orchestration type to orchestration class
ORCHESTRATION_REGISTRY: dict[str, Type[BaseOrchestration]] = {
    "SinglePrompt": SinglePromptOrchestration,
    "Squad": SquadOrchestration,
    "ConversationFlow": ConversationFlowOrchestration
}


def get_orchestration_class(orchestration_type: str) -> Type[BaseOrchestration]:
    if orchestration_type not in ORCHESTRATION_REGISTRY:
        raise ValueError(
            f"Unknown orchestration type: {orchestration_type}. "
            f"Available types: {list(ORCHESTRATION_REGISTRY.keys())}"
        )

    return ORCHESTRATION_REGISTRY[orchestration_type]
