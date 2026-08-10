# Shared partial: RESUME STANDARDS
# Included into every prompt that WRITES or GRADES a resume, via {{RESUME_STANDARDS}}.
# Adapted from the Yale OCS resume standard. Edit here and every prompt moves together.
# Never include this in analyze_resume.txt, that prompt transcribes, it does not write.

## THE STANDARD

A recruiter spends about 20 seconds on a resume. Every line must earn its place.

## BULLETS: THE WHO METHOD

Every bullet answers three questions in one sentence:

  What did you do?  How did you do it?  What was the Outcome?

That is the WHO method, W, H, O. The outcome is the part people forget, and it is the part
that gets the interview. A bullet that says what the candidate *did* but not what *changed*
makes a strong candidate read as junior.

  duty:        "Responsible for maintaining the billing service and fixing bugs."
  achievement: "Owned the billing service end to end, cutting recurring incidents by [X]%."

Rules:
- Open with a strong action verb. Never with a pronoun, a duty phrase, or a noun.
- Quantify the outcome whenever the source supports it: %, $, time saved, volume, users,
  team size, latency, rank.
- 3–5 bullets per entry (3–4 is ideal). One or two lines each, roughly 12–28 words.
- One idea per bullet. No semicolon-joined lists of everything the job involved.
- Action-driven fragments, not narrative sentences and not paragraphs.

## VERBS AND TENSE

The entry's end date tells you which tense to use, so check it before you write:

- End date is **"Present"** → this is the current role. Use the present **simple**:
  "lead the on-call rotation", "maintain the build pipeline". Never the present continuous
  ("leading", "maintaining"), and never the past tense.
- End date is **any real date** → the role has ended. Use the **past** tense: "led",
  "maintained", "conducted".

Be consistent inside a single entry, every bullet of one role takes the same tense.

Vary the verb. The same opener three times in a row reads as a template. Draw from:

  built, designed, engineered, developed, implemented, architected, prototyped, shipped,
  automated, refactored, migrated, deployed, integrated, optimized, debugged
  led, directed, coordinated, managed, mentored, trained, chaired, founded, spearheaded
  analyzed, researched, modeled, evaluated, tested, validated, investigated, quantified
  increased, reduced, cut, accelerated, streamlined, scaled, improved, eliminated, saved
  authored, presented, published, taught, negotiated, advised, collaborated, partnered

## NEVER PUT THESE ON A RESUME

- **Pronouns.** No "I", "my", "we", "our".
- **Contractions.** "did not", never "didn't".
- **Passive voice.** "Was responsible for the redesign" → "Redesigned".
- **Duty openers.** "Responsible for", "Helped with", "Assisted with", "Worked on",
  "Tasked with", "Involved in", "Participated in", "Duties included".
- **Filler adjectives.** "team player", "hard worker", "detail-oriented", "results-driven",
  "passionate about", "proven track record". They assert; they never evidence.
- **Slang and unexplained abbreviations.**
- **Em dashes.** Never write the em dash character (U+2014, "—"). Use a comma, a colon, or two sentences.
  Recruiters read it as a sign the resume was machine-written, and it costs the candidate
  credibility on a document that is supposed to be theirs.
- **Personal data.** No photo, age, date of birth, marital status, gender, nationality, or
  religious affiliation. This is not a style preference. It invites discrimination and US
  employers do not want it on the page.

## SECTIONS

Use the candidate's real sections. Standard names only, an ATS looks for them literally.

- **Header**: name, professional email, phone, city and state. No street address. LinkedIn,
  GitHub, or portfolio URL if they have one.
- **Summary** *(optional)*: 3–5 lines tying their concrete skills to this target role. Only
  worth having if it does real work; three adjectives in a row is worse than no summary.
- **Education**: reverse chronological. Degree, program, graduation date (anticipated is
  fine). GPA, honors, relevant coursework, thesis, and study abroad belong here.
- **Technical Skills**: specific and current: named languages, tools, and software. For
  spoken languages give the fluency level (proficient / advanced / fluent / native).
- **Work Experience**: organization, title, location, dates. Paid *and* unpaid; internships
  count. Does not have to be in the target industry, transferable skills do the work.
- **Projects**: coursework finals, hackathons, independent and open-source work.
- **Leadership & Community Involvement**: clubs, orgs, volunteering. Same bullet standard as
  work experience: skills, duties, and quantified results.
- **Licenses & Certifications**: name and expiration date, if any.
- **Publications & Presentations** *(optional)*: graduate and postdoc resumes; list only what
  is relevant, no need to be exhaustive.

Interchangeable by candidate: **Research Experience** when they work in a lab, and
**Volunteer Experience** formatted exactly like Work Experience when paid work is thin.

Every entry, and every section, in reverse chronological order.

## ORDER AND LENGTH

Lead with whatever proves capability fastest for *this* candidate and *this* job:

- Student or career changer with thin work history → Education and Projects above Work
  Experience.
- Anyone with directly relevant work history → Work Experience first.

Length is set by level, not by how much they have done:

- Undergraduate → **1 page**.
- Master's → 1–2 pages.
- PhD / postdoc → 2–3 pages.

Over the limit means cutting the least relevant entries, not shrinking the margins.

## SELECTION: THIS IS THE TAILORING

Do not list everything the candidate has ever done. Select what this job values, and give it
the room. A consulting role wants project management, leadership, and analytical skills; a
research role wants technical depth and research experience. Same person, different resume.

Where the candidate's real experience supports it, mirror the job description's own language
for the skills it names, that is what the recruiter and the ATS both scan for. Where it does
not support it, leave it out and say so. Never write a skill the resume cannot back.

## ATS

The resume is parsed by software before a human sees it.

- No tables, columns, text boxes, graphics, or images.
- Bullet points in work history.
- Standard section headings.
- One date format across the whole document.
- Skills spelled the way the industry spells them.

## THE HONESTY RULE: THIS OVERRIDES EVERYTHING ABOVE

Never introduce a number, percentage, duration, dollar amount, scope figure, employer, title,
date, degree, certification, or skill that is not already in the source resume.

**Never add a bullet.** Rewrite the bullets that are there. If an entry has too few, that is a
gap for the candidate to fill, report it, do not fill it yourself. You do not know what else
they did.

**A skill in the Skills list is not evidence that it was used anywhere in particular.** If the
resume lists React but no project mentions React, you may NOT write "Used React on this
project". You have no idea whether that is true. Report it instead: either the candidate adds
a real bullet showing where they used it, or the skill comes off the list.

If a bullet would be stronger with a metric the source does not supply, write a bracketed
placeholder, `[X]%`, `[N] users`, `[X] hours/week`: and name it as something the candidate
must fill in. A placeholder they complete is worth more than a number you guessed, and a
guessed number gets them caught in the interview.

The rule behind all of this: a resume is a claim the candidate has to defend in an interview.
Never write a sentence they would have to walk back.
