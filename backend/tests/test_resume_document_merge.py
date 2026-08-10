from backend.schemas.resume_document import ResumeDocument, Section, SectionItem
from backend.services.resume_document import merge_rewrite, describe_changes


def _doc():
    return ResumeDocument(sections=[
        Section(id="exp", type="experience", title="WORK EXPERIENCE",
                items=[SectionItem(id="i1", title="Engineer", subtitle="Acme", bullets=["Did things"])]),
        Section(id="prj", type="projects", title="PROJECTS",
                items=[SectionItem(id="p1", title="Proj", bullets=["Built it"])]),
    ])


def test_reorders_by_section_order_without_dropping():
    out = merge_rewrite(_doc(), _doc(), section_order=["prj", "exp"])
    assert [s.id for s in out.sections] == ["prj", "exp"]


def test_missing_ids_are_appended_not_lost():
    out = merge_rewrite(_doc(), _doc(), section_order=["prj"])  # exp omitted
    assert [s.id for s in out.sections] == ["prj", "exp"]


def test_adds_summary_when_none_exists():
    out = merge_rewrite(_doc(), _doc(), new_summary={"title": "PROFESSIONAL SUMMARY", "text": "Sharp engineer."})
    assert out.sections[0].type == "summary"
    assert out.sections[0].text == "Sharp engineer."


def test_does_not_add_summary_when_one_exists():
    orig = ResumeDocument(sections=[Section(id="sum", type="summary", title="SUMMARY", text="Old")])
    out = merge_rewrite(orig, orig, new_summary={"title": "X", "text": "New"})
    assert len([s for s in out.sections if s.type == "summary"]) == 1


def test_factual_fields_stay_locked():
    edited = ResumeDocument(sections=[
        Section(id="exp", type="experience", title="HACKED",
                items=[SectionItem(id="i1", title="CEO", subtitle="FakeCo", bullets=["Reworded bullet"])]),
        Section(id="prj", type="projects", title="PROJECTS", items=[SectionItem(id="p1", title="Proj")]),
    ])
    out = merge_rewrite(_doc(), edited)
    exp = out.sections[0]
    assert exp.title == "WORK EXPERIENCE"                 # section title locked
    assert exp.items[0].title == "Engineer"              # item title locked
    assert exp.items[0].subtitle == "Acme"               # employer locked
    assert exp.items[0].bullets == ["Reworded bullet"]   # bullets ARE taken from edited


def test_the_model_cannot_add_a_bullet():
    """The fabrication guard.

    A live run caught the rewriter inventing "Utilized React for the frontend" on a project
    that only ever said Python. It was trying to satisfy a "skills not evidenced" finding.
    A bullet the source never had is a claim the candidate never made, so extra bullets are
    dropped here, exactly as an invented employer would be.
    """
    edited = ResumeDocument(sections=[
        Section(id="exp", type="experience", title="WORK EXPERIENCE",
                items=[SectionItem(id="i1", title="Engineer", subtitle="Acme",
                                   bullets=["Rewrote the real one"])]),
        Section(id="prj", type="projects", title="PROJECTS",
                items=[SectionItem(id="p1", title="Proj", bullets=[
                    "Built it in Python",
                    "Utilized React for the frontend",      # invented
                    "Leveraged PostgreSQL for storage",     # invented
                ])]),
    ])
    out = merge_rewrite(_doc(), edited)
    by_id = {s.id: s for s in out.sections}

    # The original project had exactly one bullet; it still has exactly one.
    assert by_id["prj"].items[0].bullets == ["Built it in Python"]
    # The legitimate reword still lands.
    assert by_id["exp"].items[0].bullets == ["Rewrote the real one"]


def test_describe_changes_reports_reorder_and_summary_and_bullets():
    orig = _doc()
    final = merge_rewrite(
        _doc(),
        ResumeDocument(sections=[
            Section(id="exp", type="experience", title="WORK EXPERIENCE",
                    items=[SectionItem(id="i1", title="Engineer", subtitle="Acme",
                                       bullets=["Led migration cutting build time"])]),
            Section(id="prj", type="projects", title="PROJECTS",
                    items=[SectionItem(id="p1", title="Proj", bullets=["Built it"])]),
        ]),
        section_order=["prj", "exp"],
        new_summary={"title": "PROFESSIONAL SUMMARY", "text": "Sharp engineer."},
    )
    changes = describe_changes(orig, final)
    joined = " ".join(changes).lower()
    assert any("reorder" in c.lower() for c in changes)
    assert "summary" in joined
    assert any("bullet" in c.lower() or "entr" in c.lower() for c in changes)
