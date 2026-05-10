# Feature: resume-upload-analysis, Property 1: Profile schema round-trip
"""
Property-based test for ResumeProfile schema round-trip serialization.

Property 1: For any valid ResumeProfile (with arbitrary name, email, phone,
location, URLs, education entries, experience entries, project entries, and
technologies dict), serializing it to JSON and deserializing it back SHALL
produce an identical ResumeProfile object.

**Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
"""

from hypothesis import given, settings
from hypothesis import strategies as st

from backend.schemas.resume import (
    EducationItem,
    ExperienceItem,
    ProjectItem,
    ResumeProfile,
)

# --- Hypothesis Strategies ---

# Strategy for generating safe text strings (printable, no surrogates)
safe_text = st.text(
    alphabet=st.characters(
        whitelist_categories=("L", "N", "P", "Z", "S"),
        blacklist_categories=("Cs",),  # exclude surrogates
    ),
    min_size=0,
    max_size=50,
)

# Strategy for generating list of strings (e.g., skills, bullets, achievements)
string_list = st.lists(safe_text, min_size=0, max_size=5)

# Strategy for EducationItem
education_strategy = st.builds(
    EducationItem,
    school=safe_text,
    degree=safe_text,
    start_date=safe_text,
    end_date=safe_text,
    gpa=safe_text,
    achievements=string_list,
    coursework=string_list,
)

# Strategy for ExperienceItem
experience_strategy = st.builds(
    ExperienceItem,
    company=safe_text,
    title=safe_text,
    location=safe_text,
    start_date=safe_text,
    end_date=safe_text,
    bullets=string_list,
)

# Strategy for ProjectItem
project_strategy = st.builds(
    ProjectItem,
    name=safe_text,
    link=safe_text,
    organization=safe_text,
    location=safe_text,
    start_date=safe_text,
    end_date=safe_text,
    bullets=string_list,
)

# Strategy for technologies dict (category name -> list of skills)
technologies_strategy = st.dictionaries(
    keys=safe_text,
    values=string_list,
    min_size=0,
    max_size=5,
)

# Strategy for full ResumeProfile
resume_profile_strategy = st.builds(
    ResumeProfile,
    name=safe_text,
    email=safe_text,
    phone=safe_text,
    location=safe_text,
    linkedin_url=safe_text,
    github_url=safe_text,
    other_link=safe_text,
    skills=string_list,
    experience=st.lists(experience_strategy, min_size=0, max_size=3),
    education=st.lists(education_strategy, min_size=0, max_size=3),
    projects=st.lists(project_strategy, min_size=0, max_size=3),
    technologies=technologies_strategy,
)


@settings(max_examples=100)
@given(profile=resume_profile_strategy)
def test_profile_schema_round_trip(profile: ResumeProfile):
    """
    Property 1: Profile schema round-trip

    For any valid ResumeProfile, serializing to JSON via model_dump_json()
    and deserializing back via ResumeProfile.model_validate_json() SHALL
    produce an identical ResumeProfile object.

    **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
    """
    # Serialize to JSON
    json_str = profile.model_dump_json()

    # Deserialize back
    restored = ResumeProfile.model_validate_json(json_str)

    # Assert equality
    assert restored == profile


# Feature: resume-upload-analysis, Property 6: Primary resume invariant
"""
Property 6: Primary resume invariant

For any set of resumes in the database, after calling PUT /resumes/{id}/primary
on any valid resume id, exactly one resume SHALL have is_primary=1 (the targeted
one), and all others SHALL have is_primary=0.

**Validates: Requirements 6.2, 8.5**
"""

import pytest
from hypothesis import HealthCheck
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from backend.db.database import Base, get_db
from backend.db.models import ResumeProfileDB, UserSettings
from backend.main import app

# In-memory SQLite for property 6 tests
PROP6_DATABASE_URL = "sqlite:///./test_resume_prop6.db"
prop6_engine = create_engine(PROP6_DATABASE_URL, connect_args={"check_same_thread": False})
Prop6SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=prop6_engine)


@pytest.fixture
def prop6_setup_db():
    """Create all tables before each test, drop after."""
    Base.metadata.create_all(bind=prop6_engine)
    yield
    Base.metadata.drop_all(bind=prop6_engine)


@pytest.fixture
def prop6_db_session(prop6_setup_db):
    """Yield a test DB session for property 6."""
    session = Prop6SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def prop6_client(prop6_db_session):
    """FastAPI test client with overridden DB dependency for property 6."""
    def _override_get_db():
        try:
            yield prop6_db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# Strategy for generating resume names (simple alphanumeric)
resume_name_strategy = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N")),
    min_size=1,
    max_size=30,
).filter(lambda s: s.strip() != "")


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture], deadline=None)
@given(
    num_resumes=st.integers(min_value=1, max_value=5),
    target_index=st.integers(min_value=0, max_value=100),
)
def test_primary_resume_invariant(num_resumes, target_index, prop6_db_session, prop6_client):
    """
    Property 6: Primary resume invariant

    For any set of resumes in the database, after calling
    PUT /resumes/{id}/primary on any valid resume id, exactly one resume
    SHALL have is_primary=True (the targeted one), and all others SHALL
    have is_primary=False.

    **Validates: Requirements 6.2, 8.5**
    """
    # Create N resume records in the database
    created_ids = []
    for i in range(num_resumes):
        record = ResumeProfileDB(
            name=f"Resume {i}",
            profile_name=f"Person {i}",
            email=f"person{i}@example.com",
            status="analyzed",
            is_primary=0,
        )
        prop6_db_session.add(record)
    prop6_db_session.commit()

    # Retrieve all created resume IDs
    all_records = prop6_db_session.query(ResumeProfileDB).all()
    created_ids = [r.id for r in all_records]

    # Pick a random target using modulo to stay within bounds
    target_id = created_ids[target_index % num_resumes]

    # Call PUT /resumes/{id}/primary
    response = prop6_client.put(f"/resumes/{target_id}/primary")
    assert response.status_code == 200

    # Verify via GET /resumes that exactly one is primary and it's the target
    list_response = prop6_client.get("/resumes")
    assert list_response.status_code == 200
    resumes = list_response.json()

    primary_resumes = [r for r in resumes if r["is_primary"] is True]
    non_primary_resumes = [r for r in resumes if r["is_primary"] is False]

    # Exactly one resume has is_primary=True
    assert len(primary_resumes) == 1, (
        f"Expected exactly 1 primary resume, got {len(primary_resumes)}"
    )

    # The primary resume is the one we targeted
    assert primary_resumes[0]["id"] == target_id, (
        f"Expected primary resume id={target_id}, got id={primary_resumes[0]['id']}"
    )

    # All others are not primary
    assert len(non_primary_resumes) == num_resumes - 1

    # Cleanup for next hypothesis iteration
    prop6_db_session.query(ResumeProfileDB).delete()
    prop6_db_session.commit()


# Feature: resume-upload-analysis, Property 8: API CRUD round-trip
"""
Property 8: API CRUD round-trip

For any valid ResumeProfile and metadata (name, target_job_title), storing it
via POST /resumes/upload (or updating via PUT /resumes/{id}), then retrieving
it via GET /resumes/{id} SHALL return a profile with all fields matching the
stored/updated values.

**Validates: Requirements 7.2, 8.2, 8.3**
"""

# In-memory SQLite for property 8 tests
PROP8_DATABASE_URL = "sqlite:///./test_resume_prop8.db"
prop8_engine = create_engine(PROP8_DATABASE_URL, connect_args={"check_same_thread": False})
Prop8SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=prop8_engine)


@pytest.fixture
def prop8_setup_db():
    """Create all tables before each test, drop after."""
    Base.metadata.create_all(bind=prop8_engine)
    yield
    Base.metadata.drop_all(bind=prop8_engine)


@pytest.fixture
def prop8_db_session(prop8_setup_db):
    """Yield a test DB session for property 8."""
    session = Prop8SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def prop8_client(prop8_db_session):
    """FastAPI test client with overridden DB dependency for property 8."""
    def _override_get_db():
        try:
            yield prop8_db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# Strategy for generating non-empty resume names
prop8_name_strategy = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N", "P", "Z"),
                           blacklist_categories=("Cs",)),
    min_size=1,
    max_size=50,
).filter(lambda s: s.strip() != "")

# Strategy for target_job_title (string or None)
prop8_target_job_strategy = st.one_of(
    st.none(),
    st.text(
        alphabet=st.characters(whitelist_categories=("L", "N", "P", "Z"),
                               blacklist_categories=("Cs",)),
        min_size=1,
        max_size=50,
    ).filter(lambda s: s.strip() != ""),
)


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture], deadline=None)
@given(
    profile=resume_profile_strategy,
    resume_name=prop8_name_strategy,
    target_job_title=prop8_target_job_strategy,
)
def test_api_crud_round_trip(profile, resume_name, target_job_title, prop8_db_session, prop8_client):
    """
    Property 8: API CRUD round-trip

    Generate random ResumeProfile + metadata, create a resume in DB,
    update it via PUT /resumes/{id} with the random profile + name + target_job_title,
    retrieve via GET /resumes/{id}, and assert all fields match.

    **Validates: Requirements 7.2, 8.2, 8.3**
    """
    # Step 1: Create a resume directly in DB (avoids needing Ollama for upload)
    record = ResumeProfileDB(
        name="Initial Resume",
        profile_name="Initial Person",
        email="initial@example.com",
        status="analyzed",
        is_primary=0,
    )
    prop8_db_session.add(record)
    prop8_db_session.commit()
    prop8_db_session.refresh(record)
    resume_id = record.id

    # Step 2: Update via PUT /resumes/{id} with random profile + metadata
    update_body = {
        "name": resume_name,
        "profile": profile.model_dump(),
    }
    if target_job_title is not None:
        update_body["target_job_title"] = target_job_title

    put_response = prop8_client.put(f"/resumes/{resume_id}", json=update_body)
    assert put_response.status_code == 200, (
        f"PUT /resumes/{resume_id} failed: {put_response.status_code} {put_response.text}"
    )

    # Step 3: Retrieve via GET /resumes/{id}
    get_response = prop8_client.get(f"/resumes/{resume_id}")
    assert get_response.status_code == 200, (
        f"GET /resumes/{resume_id} failed: {get_response.status_code} {get_response.text}"
    )
    data = get_response.json()

    # Step 4: Assert metadata fields match
    assert data["name"] == resume_name, (
        f"Expected name={resume_name!r}, got {data['name']!r}"
    )
    if target_job_title is not None:
        assert data["target_job_title"] == target_job_title, (
            f"Expected target_job_title={target_job_title!r}, got {data['target_job_title']!r}"
        )

    # Step 5: Assert profile fields match
    returned_profile = data["profile"]
    expected_profile = profile.model_dump()

    assert returned_profile["name"] == expected_profile["name"], (
        f"Profile name mismatch: {returned_profile['name']!r} != {expected_profile['name']!r}"
    )
    assert returned_profile["email"] == expected_profile["email"], (
        f"Profile email mismatch: {returned_profile['email']!r} != {expected_profile['email']!r}"
    )
    assert returned_profile["phone"] == expected_profile["phone"], (
        f"Profile phone mismatch: {returned_profile['phone']!r} != {expected_profile['phone']!r}"
    )
    assert returned_profile["location"] == expected_profile["location"], (
        f"Profile location mismatch"
    )
    assert returned_profile["linkedin_url"] == expected_profile["linkedin_url"], (
        f"Profile linkedin_url mismatch"
    )
    assert returned_profile["github_url"] == expected_profile["github_url"], (
        f"Profile github_url mismatch"
    )
    assert returned_profile["other_link"] == expected_profile["other_link"], (
        f"Profile other_link mismatch"
    )
    assert returned_profile["skills"] == expected_profile["skills"], (
        f"Profile skills mismatch"
    )
    assert returned_profile["experience"] == expected_profile["experience"], (
        f"Profile experience mismatch"
    )
    assert returned_profile["education"] == expected_profile["education"], (
        f"Profile education mismatch"
    )
    assert returned_profile["projects"] == expected_profile["projects"], (
        f"Profile projects mismatch"
    )
    assert returned_profile["technologies"] == expected_profile["technologies"], (
        f"Profile technologies mismatch"
    )

    # Cleanup for next hypothesis iteration
    prop8_db_session.query(ResumeProfileDB).delete()
    prop8_db_session.commit()


# Feature: resume-upload-analysis, Property 9: Delete removes resume
"""
Property 9: Delete removes resume

For any existing resume id, calling DELETE /resumes/{id} then GET /resumes/{id}
SHALL return a 404 status. Additionally, for any non-existent resume id, calling
GET, PUT, DELETE, or POST analyze SHALL return a 404 status.

**Validates: Requirements 8.4, 8.7**
"""

# In-memory SQLite for property 9 tests
PROP9_DATABASE_URL = "sqlite:///./test_resume_prop9.db"
prop9_engine = create_engine(PROP9_DATABASE_URL, connect_args={"check_same_thread": False})
Prop9SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=prop9_engine)


@pytest.fixture
def prop9_setup_db():
    """Create all tables before each test, drop after."""
    Base.metadata.create_all(bind=prop9_engine)
    yield
    Base.metadata.drop_all(bind=prop9_engine)


@pytest.fixture
def prop9_db_session(prop9_setup_db):
    """Yield a test DB session for property 9."""
    session = Prop9SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def prop9_client(prop9_db_session):
    """FastAPI test client with overridden DB dependency for property 9."""
    def _override_get_db():
        try:
            yield prop9_db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture], deadline=None)
@given(
    profile_name=safe_text,
    email=safe_text,
)
def test_delete_removes_resume(profile_name, email, prop9_db_session, prop9_client):
    """
    Property 9: Delete removes resume

    Create a resume, delete it, verify GET returns 404.

    **Validates: Requirements 8.4, 8.7**
    """
    # Ensure clean state for this iteration
    prop9_db_session.rollback()
    Base.metadata.create_all(bind=prop9_engine)

    # Step 1: Create a resume in the database
    record = ResumeProfileDB(
        name="Resume to Delete",
        profile_name=profile_name,
        email=email,
        status="analyzed",
        is_primary=0,
    )
    prop9_db_session.add(record)
    prop9_db_session.commit()
    prop9_db_session.refresh(record)
    resume_id = record.id

    # Step 2: Verify the resume exists via GET
    get_response = prop9_client.get(f"/resumes/{resume_id}")
    assert get_response.status_code == 200, (
        f"Expected 200 for existing resume, got {get_response.status_code}"
    )

    # Step 3: Delete the resume
    delete_response = prop9_client.delete(f"/resumes/{resume_id}")
    assert delete_response.status_code == 204, (
        f"Expected 204 on delete, got {delete_response.status_code}"
    )

    # Step 4: Verify GET returns 404 after deletion
    get_after_delete = prop9_client.get(f"/resumes/{resume_id}")
    assert get_after_delete.status_code == 404, (
        f"Expected 404 after delete, got {get_after_delete.status_code}"
    )

    # Cleanup for next hypothesis iteration
    prop9_db_session.query(ResumeProfileDB).delete()
    prop9_db_session.commit()


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture], deadline=None)
@given(
    non_existent_id=st.integers(min_value=900000, max_value=9999999),
)
def test_non_existent_resume_returns_404(non_existent_id, prop9_db_session, prop9_client):
    """
    Property 9: Non-existent resume IDs return 404

    For any non-existent resume id, GET, PUT, DELETE SHALL return 404.

    **Validates: Requirements 8.4, 8.7**
    """
    # Ensure clean state for this iteration
    prop9_db_session.rollback()
    Base.metadata.create_all(bind=prop9_engine)

    # GET /resumes/{non_existent_id} → 404
    get_response = prop9_client.get(f"/resumes/{non_existent_id}")
    assert get_response.status_code == 404, (
        f"Expected 404 for GET non-existent id={non_existent_id}, got {get_response.status_code}"
    )

    # PUT /resumes/{non_existent_id} → 404
    put_response = prop9_client.put(
        f"/resumes/{non_existent_id}",
        json={"name": "Test"},
    )
    assert put_response.status_code == 404, (
        f"Expected 404 for PUT non-existent id={non_existent_id}, got {put_response.status_code}"
    )

    # DELETE /resumes/{non_existent_id} → 404
    delete_response = prop9_client.delete(f"/resumes/{non_existent_id}")
    assert delete_response.status_code == 404, (
        f"Expected 404 for DELETE non-existent id={non_existent_id}, got {delete_response.status_code}"
    )


# Feature: resume-upload-analysis, Property 11: Analysis report persistence
"""
Property 11: Analysis report persistence

For any resume with raw_text, after calling POST /resumes/{id}/analyze, the
returned report SHALL contain all required fields (overall_grade, fix counts,
summary, highlights), and subsequent GET /resumes/{id} calls SHALL return the
same analysis_report without re-running analysis.

**Validates: Requirements 9.2, 9.5**
"""

from unittest.mock import patch, AsyncMock

# In-memory SQLite for property 11 tests
PROP11_DATABASE_URL = "sqlite:///./test_resume_prop11.db"
prop11_engine = create_engine(PROP11_DATABASE_URL, connect_args={"check_same_thread": False})
Prop11SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=prop11_engine)


@pytest.fixture
def prop11_setup_db():
    """Create all tables before each test, drop after."""
    Base.metadata.create_all(bind=prop11_engine)
    yield
    Base.metadata.drop_all(bind=prop11_engine)


@pytest.fixture
def prop11_db_session(prop11_setup_db):
    """Yield a test DB session for property 11."""
    session = Prop11SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def prop11_client(prop11_db_session):
    """FastAPI test client with overridden DB dependency for property 11."""
    def _override_get_db():
        try:
            yield prop11_db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# Strategy for generating AnalysisReport data
grade_strategy = st.sampled_from(["EXCELLENT", "GOOD", "FAIR"])

non_negative_int_strategy = st.integers(min_value=0, max_value=100)

non_empty_text_strategy = st.text(
    alphabet=st.characters(
        whitelist_categories=("L", "N", "P", "Z", "S"),
        blacklist_categories=("Cs",),
    ),
    min_size=1,
    max_size=100,
).filter(lambda s: s.strip() != "")

highlights_strategy = st.lists(
    non_empty_text_strategy,
    min_size=1,
    max_size=5,
)

analysis_report_strategy = st.builds(
    lambda grade, urgent, critical, optional, summary, highlights: {
        "overall_grade": grade,
        "urgent_fix_count": urgent,
        "critical_fix_count": critical,
        "optional_fix_count": optional,
        "summary": summary,
        "highlights": highlights,
    },
    grade=grade_strategy,
    urgent=non_negative_int_strategy,
    critical=non_negative_int_strategy,
    optional=non_negative_int_strategy,
    summary=non_empty_text_strategy,
    highlights=highlights_strategy,
)


from backend.schemas.resume import AnalysisReport as AnalysisReportSchema


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture], deadline=None)
@given(
    report_data=analysis_report_strategy,
)
def test_analysis_report_persistence(report_data, prop11_db_session, prop11_client):
    """
    Property 11: Analysis report persistence

    Mock Ollama to return a generated AnalysisReport, call POST /resumes/{id}/analyze,
    verify the returned report has all required fields, then call GET /resumes/{id}
    and verify the analysis_report is persisted without re-running analysis.

    **Validates: Requirements 9.2, 9.5**
    """
    # Step 1: Create a resume in DB with raw_text
    record = ResumeProfileDB(
        name="Resume for Analysis",
        profile_name="Test Person",
        email="test@example.com",
        status="analyzed",
        is_primary=0,
        raw_text="This is a sample resume text for analysis testing.",
    )
    prop11_db_session.add(record)
    prop11_db_session.commit()
    prop11_db_session.refresh(record)
    resume_id = record.id

    # Step 2: Create the expected AnalysisReport from generated data
    expected_report = AnalysisReportSchema(**report_data)

    # Step 3: Mock OllamaService.analyze_resume_quality to return the generated report
    with patch(
        "backend.routers.resumes.OllamaService.analyze_resume_quality",
        new_callable=AsyncMock,
        return_value=expected_report,
    ) as mock_analyze:
        # Step 4: Call POST /resumes/{id}/analyze
        analyze_response = prop11_client.post(f"/resumes/{resume_id}/analyze")
        assert analyze_response.status_code == 200, (
            f"POST /resumes/{resume_id}/analyze failed: "
            f"{analyze_response.status_code} {analyze_response.text}"
        )

        # Verify the mock was called exactly once
        mock_analyze.assert_called_once()

        # Step 5: Verify returned report has all required fields
        returned_report = analyze_response.json()
        assert returned_report["overall_grade"] == report_data["overall_grade"], (
            f"Grade mismatch: {returned_report['overall_grade']} != {report_data['overall_grade']}"
        )
        assert returned_report["urgent_fix_count"] == report_data["urgent_fix_count"], (
            f"urgent_fix_count mismatch"
        )
        assert returned_report["critical_fix_count"] == report_data["critical_fix_count"], (
            f"critical_fix_count mismatch"
        )
        assert returned_report["optional_fix_count"] == report_data["optional_fix_count"], (
            f"optional_fix_count mismatch"
        )
        assert returned_report["summary"] == report_data["summary"], (
            f"summary mismatch"
        )
        assert returned_report["highlights"] == report_data["highlights"], (
            f"highlights mismatch"
        )

    # Step 6: Call GET /resumes/{id} (outside the mock context to prove no re-run)
    get_response = prop11_client.get(f"/resumes/{resume_id}")
    assert get_response.status_code == 200, (
        f"GET /resumes/{resume_id} failed: {get_response.status_code} {get_response.text}"
    )
    data = get_response.json()

    # Step 7: Verify the analysis_report in the response matches (persisted)
    persisted_report = data["analysis_report"]
    assert persisted_report is not None, "analysis_report should be persisted after analyze"
    assert persisted_report["overall_grade"] == report_data["overall_grade"], (
        f"Persisted grade mismatch"
    )
    assert persisted_report["urgent_fix_count"] == report_data["urgent_fix_count"], (
        f"Persisted urgent_fix_count mismatch"
    )
    assert persisted_report["critical_fix_count"] == report_data["critical_fix_count"], (
        f"Persisted critical_fix_count mismatch"
    )
    assert persisted_report["optional_fix_count"] == report_data["optional_fix_count"], (
        f"Persisted optional_fix_count mismatch"
    )
    assert persisted_report["summary"] == report_data["summary"], (
        f"Persisted summary mismatch"
    )
    assert persisted_report["highlights"] == report_data["highlights"], (
        f"Persisted highlights mismatch"
    )

    # Cleanup for next hypothesis iteration
    prop11_db_session.query(ResumeProfileDB).delete()
    prop11_db_session.commit()


# Feature: resume-upload-analysis, Property 7: Autofill returns primary resume data
"""
Property 7: Autofill returns primary resume data

For any set of resumes where one is marked as primary, the
GET /apply/{session}/profile endpoint SHALL return profile data (skills,
experience, education, projects) matching the primary resume's stored profile,
and after updating that resume via PUT, subsequent autofill requests SHALL
reflect the updated data.

**Validates: Requirements 6.5, 11.1, 11.3**
"""

from backend.routers import apply as apply_module

# In-memory SQLite for property 7 tests
PROP7_DATABASE_URL = "sqlite:///./test_resume_prop7.db"
prop7_engine = create_engine(PROP7_DATABASE_URL, connect_args={"check_same_thread": False})
Prop7SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=prop7_engine)


@pytest.fixture
def prop7_setup_db():
    """Create all tables before each test, drop after."""
    Base.metadata.create_all(bind=prop7_engine)
    yield
    Base.metadata.drop_all(bind=prop7_engine)
    apply_module._sessions.clear()


@pytest.fixture
def prop7_db_session(prop7_setup_db):
    """Yield a fresh test DB session for property 7."""
    session = Prop7SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def prop7_client(prop7_db_session):
    """FastAPI test client with overridden DB dependency for property 7."""
    def _override_get_db():
        try:
            yield prop7_db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# Strategy for generating experience items (list of dicts)
prop7_experience_strategy = st.lists(
    st.fixed_dictionaries({
        "company": safe_text,
        "title": safe_text,
        "location": safe_text,
        "start_date": safe_text,
        "end_date": safe_text,
        "bullets": string_list,
    }),
    min_size=0,
    max_size=3,
)

# Strategy for generating education items (list of dicts)
prop7_education_strategy = st.lists(
    st.fixed_dictionaries({
        "school": safe_text,
        "degree": safe_text,
        "start_date": safe_text,
        "end_date": safe_text,
        "gpa": safe_text,
        "achievements": string_list,
        "coursework": string_list,
    }),
    min_size=0,
    max_size=3,
)

# Strategy for generating project items (list of dicts)
prop7_projects_strategy = st.lists(
    st.fixed_dictionaries({
        "name": safe_text,
        "link": safe_text,
        "organization": safe_text,
        "location": safe_text,
        "start_date": safe_text,
        "end_date": safe_text,
        "bullets": string_list,
    }),
    min_size=0,
    max_size=3,
)

# Strategy for primary resume index selection
prop7_primary_index_strategy = st.integers(min_value=0, max_value=2)


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture], deadline=None)
@given(
    skills=string_list,
    experience=prop7_experience_strategy,
    education=prop7_education_strategy,
    projects=prop7_projects_strategy,
    primary_index=prop7_primary_index_strategy,
    updated_skills=string_list,
)
def test_autofill_returns_primary_resume_data(
    skills,
    experience,
    education,
    projects,
    primary_index,
    updated_skills,
    prop7_db_session,
    prop7_client,
):
    """
    Property 7: Autofill returns primary resume data

    Generate resumes with one marked primary, verify autofill returns that
    resume's data. Update the primary resume, verify subsequent autofill
    reflects changes.

    **Validates: Requirements 6.5, 11.1, 11.3**
    """
    # Ensure clean state for this iteration
    prop7_db_session.rollback()
    apply_module._sessions.clear()

    # Clean up any leftover data from previous iterations
    prop7_db_session.query(ResumeProfileDB).delete()
    prop7_db_session.query(UserSettings).delete()
    prop7_db_session.commit()

    # Step 1: Create UserSettings in DB (required by the profile endpoint)
    settings_obj = UserSettings(
        first_name="Test",
        last_name="User",
        email="test@example.com",
        phone="555-0100",
        city="Ottawa",
        linkedin_url="https://linkedin.com/in/testuser",
        website="https://testuser.dev",
    )
    prop7_db_session.add(settings_obj)
    prop7_db_session.flush()

    # Step 2: Create 3 resumes with different data
    target_idx = primary_index % 3
    created_ids = []
    for i in range(3):
        record = ResumeProfileDB(
            name=f"Resume {i}",
            profile_name=f"Person {i}",
            email=f"person{i}@example.com",
            status="analyzed",
            is_primary=0,
            skills=skills if i == target_idx else ["other_skill"],
            experience=experience if i == target_idx else [],
            education=education if i == target_idx else [],
            projects=projects if i == target_idx else [],
            technologies={},
            raw_text=f"Resume text {i}",
        )
        prop7_db_session.add(record)
    prop7_db_session.commit()

    # Retrieve all resume IDs
    all_records = prop7_db_session.query(ResumeProfileDB).order_by(ResumeProfileDB.id).all()
    created_ids = [r.id for r in all_records]
    primary_id = created_ids[target_idx]

    # Step 3: Mark one as primary via PUT /resumes/{id}/primary
    primary_response = prop7_client.put(f"/resumes/{primary_id}/primary")
    assert primary_response.status_code == 200, (
        f"PUT /resumes/{primary_id}/primary failed: {primary_response.status_code}"
    )

    # Step 4: Patch _sessions with a test session (simpler than creating a job)
    test_session_id = "test-session-prop7"
    apply_module._sessions[test_session_id] = {
        "job_id": 99999,
        "resume_version": "original",
        "status": "initiated",
    }

    # Step 5: Call GET /apply/{session}/profile
    profile_response = prop7_client.get(f"/apply/{test_session_id}/profile")
    assert profile_response.status_code == 200, (
        f"GET /apply/{test_session_id}/profile failed: {profile_response.status_code} "
        f"{profile_response.text}"
    )
    fill_profile = profile_response.json()

    # Step 6: Verify the returned data matches the primary resume's data
    assert fill_profile["experience"] == experience, (
        f"Experience mismatch: expected primary resume's experience"
    )
    assert fill_profile["education"] == education, (
        f"Education mismatch: expected primary resume's education"
    )
    assert fill_profile["projects"] == projects, (
        f"Projects mismatch: expected primary resume's projects"
    )
    # Skills should contain at least the primary resume's skills
    for skill in skills:
        assert skill in fill_profile["skills"], (
            f"Skill '{skill}' from primary resume not found in autofill skills"
        )

    # Step 7: Update the primary resume via PUT /resumes/{id} with new data
    updated_profile = {
        "name": "Updated Person",
        "email": "updated@example.com",
        "phone": "",
        "location": "",
        "linkedin_url": "",
        "github_url": "",
        "other_link": "",
        "skills": updated_skills,
        "experience": [],
        "education": [],
        "projects": [],
        "technologies": {},
    }
    update_response = prop7_client.put(
        f"/resumes/{primary_id}",
        json={"profile": updated_profile},
    )
    assert update_response.status_code == 200, (
        f"PUT /resumes/{primary_id} failed: {update_response.status_code} "
        f"{update_response.text}"
    )

    # Step 8: Call GET /apply/{session}/profile again
    profile_response2 = prop7_client.get(f"/apply/{test_session_id}/profile")
    assert profile_response2.status_code == 200, (
        f"Second GET /apply/{test_session_id}/profile failed: "
        f"{profile_response2.status_code} {profile_response2.text}"
    )
    fill_profile2 = profile_response2.json()

    # Step 9: Verify the response reflects the updated data
    assert fill_profile2["experience"] == [], (
        f"After update, experience should be empty but got: {fill_profile2['experience']}"
    )
    assert fill_profile2["education"] == [], (
        f"After update, education should be empty but got: {fill_profile2['education']}"
    )
    assert fill_profile2["projects"] == [], (
        f"After update, projects should be empty but got: {fill_profile2['projects']}"
    )
    # Updated skills should be reflected
    for skill in updated_skills:
        assert skill in fill_profile2["skills"], (
            f"Updated skill '{skill}' not found in autofill skills after update"
        )

    # Cleanup for next hypothesis iteration
    apply_module._sessions.clear()
    prop7_db_session.query(UserSettings).delete()
    prop7_db_session.query(ResumeProfileDB).delete()
    prop7_db_session.commit()


# Feature: resume-upload-analysis, Property 12: Skills list merges all technology categories
"""
Property 12: Skills list merges all technology categories

For any ResumeProfile with a technologies dict mapping N categories to lists
of skills, the serialized flat skills list returned by the autofill endpoint
SHALL contain every skill string from every category in the technologies dict.

**Validates: Requirements 11.4**
"""

# In-memory SQLite for property 12 tests
PROP12_DATABASE_URL = "sqlite:///./test_resume_prop12.db"
prop12_engine = create_engine(PROP12_DATABASE_URL, connect_args={"check_same_thread": False})
Prop12SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=prop12_engine)


@pytest.fixture
def prop12_setup_db():
    """Create all tables before each test, drop after."""
    Base.metadata.create_all(bind=prop12_engine)
    yield
    Base.metadata.drop_all(bind=prop12_engine)
    apply_module._sessions.clear()


@pytest.fixture
def prop12_db_session(prop12_setup_db):
    """Yield a fresh test DB session for property 12."""
    session = Prop12SessionLocal()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture
def prop12_client(prop12_db_session):
    """FastAPI test client with overridden DB dependency for property 12."""
    def _override_get_db():
        try:
            yield prop12_db_session
        finally:
            pass

    app.dependency_overrides[get_db] = _override_get_db
    with TestClient(app) as c:
        yield c
    app.dependency_overrides.clear()


# Strategy for generating technologies dicts with 1-5 categories, each with 1-5 skills
# Use non-empty category names and non-empty skill names to ensure meaningful data
prop12_category_name = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N")),
    min_size=1,
    max_size=20,
).filter(lambda s: s.strip() != "")

prop12_skill_name = st.text(
    alphabet=st.characters(whitelist_categories=("L", "N", "P", "Z"),
                           blacklist_categories=("Cs",)),
    min_size=1,
    max_size=30,
).filter(lambda s: s.strip() != "")

prop12_technologies_strategy = st.dictionaries(
    keys=prop12_category_name,
    values=st.lists(prop12_skill_name, min_size=1, max_size=5),
    min_size=1,
    max_size=5,
)


@settings(max_examples=100, suppress_health_check=[HealthCheck.function_scoped_fixture], deadline=None)
@given(
    technologies=prop12_technologies_strategy,
)
def test_skills_list_merges_all_technology_categories(
    technologies,
    prop12_db_session,
    prop12_client,
):
    """
    Property 12: Skills list merges all technology categories

    Generate random technologies dicts (dict[str, list[str]]) with 1-5 categories,
    each with 1-5 skills. Create a resume with the generated technologies dict and
    an empty skills list, set it as primary, create UserSettings, patch _sessions,
    call GET /apply/{session}/profile, and verify the returned skills list contains
    every skill from every category in the technologies dict.

    **Validates: Requirements 11.4**
    """
    # Ensure clean state for this iteration
    prop12_db_session.rollback()
    apply_module._sessions.clear()

    # Clean up any leftover data from previous iterations
    prop12_db_session.query(ResumeProfileDB).delete()
    prop12_db_session.query(UserSettings).delete()
    prop12_db_session.commit()

    # Step 1: Create UserSettings in DB (required by the profile endpoint)
    settings_obj = UserSettings(
        first_name="Test",
        last_name="User",
        email="test@example.com",
        phone="555-0100",
        city="Ottawa",
        linkedin_url="https://linkedin.com/in/testuser",
        website="https://testuser.dev",
    )
    prop12_db_session.add(settings_obj)
    prop12_db_session.flush()

    # Step 2: Create a resume with the generated technologies dict and empty skills list
    record = ResumeProfileDB(
        name="Tech Resume",
        profile_name="Tech Person",
        email="tech@example.com",
        status="analyzed",
        is_primary=1,  # Set as primary directly
        skills=[],  # Empty skills list
        experience=[],
        education=[],
        projects=[],
        technologies=technologies,
        raw_text="Resume with technologies",
    )
    prop12_db_session.add(record)
    prop12_db_session.commit()

    # Step 3: Patch _sessions with a test session
    test_session_id = "test-session-prop12"
    apply_module._sessions[test_session_id] = {
        "job_id": 99999,
        "resume_version": "original",
        "status": "initiated",
    }

    # Step 4: Call GET /apply/{session}/profile
    profile_response = prop12_client.get(f"/apply/{test_session_id}/profile")
    assert profile_response.status_code == 200, (
        f"GET /apply/{test_session_id}/profile failed: {profile_response.status_code} "
        f"{profile_response.text}"
    )
    fill_profile = profile_response.json()

    # Step 5: Verify the returned skills list contains every skill from every category
    returned_skills = fill_profile["skills"]
    for category, category_skills in technologies.items():
        for skill in category_skills:
            assert skill in returned_skills, (
                f"Skill '{skill}' from category '{category}' not found in returned skills list. "
                f"Technologies: {technologies}, Returned skills: {returned_skills}"
            )

    # Cleanup for next hypothesis iteration
    apply_module._sessions.clear()
    prop12_db_session.query(UserSettings).delete()
    prop12_db_session.query(ResumeProfileDB).delete()
    prop12_db_session.commit()
