"""
Pydantic schemas for match score breakdown and fit analysis.
"""

from pydantic import BaseModel


class MatchBreakdown(BaseModel):
    """Detailed match score breakdown by category."""
    overall_score: int  # 0-100
    experience_score: int  # 0-100
    skill_score: int  # 0-100
    industry_score: int  # 0-100
    match_label: str  # "STRONG MATCH", "GOOD MATCH", "FAIR MATCH"
    strengths: list[str] = []
    weaknesses: list[str] = []


class FitAnalysis(BaseModel):
    """Detailed fit analysis with narrative and recommendations."""
    overall_score: int
    breakdown: MatchBreakdown
    narrative: str  # detailed analysis text
    recommendations: list[str] = []
