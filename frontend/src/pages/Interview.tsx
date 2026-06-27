import { useMemo, useState } from "react";
import api from "../auth/api";
import interviewData from "../data/interview-questions.json";

type Question = {
  title: string;
  topic: string;
  subtopic: string;
  difficulty: string;
  seniority: string;
  type: string;
  url?: string;
};

type Company = {
  name: string;
  domain: string;
  category: string;
  totalQuestions: number;
  questions: Question[];
};

const CATEGORY_ORDER = ["All", "FAANG", "AI", "High-Growth", "Canadian"];

const CATEGORY_LABELS: Record<string, string> = {
  All: "All Companies",
  FAANG: "FAANG",
  AI: "AI Labs",
  "High-Growth": "High-Growth",
  Canadian: "Canadian",
};

function logoUrl(domain: string) {
  return `https://logos-api.apistemic.com/domain:${domain}?fallback=404`;
}

/**
 * Build topic-aware practice links for a question.
 * Every link opens a real, no-login-required resource so a card never
 * leads to a dead LeetCode search.
 */
function practiceLinks(q: Question): { label: string; url: string; icon: string; variant?: string }[] {
  const title = q.title.trim();
  const enc = encodeURIComponent(title);
  const youtube = (query: string) =>
    `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
  const google = (query: string) =>
    `https://www.google.com/search?q=${encodeURIComponent(query)}`;

  if (q.topic === "System Design") {
    return [
      { label: "Watch explanation", url: youtube(`${title} system design interview`), icon: "fa-brands fa-youtube", variant: "yt" },
      { label: "Read guide", url: google(`${title} system design interview guide`), icon: "fa-solid fa-book-open", variant: "alt" },
    ];
  }

  if (q.topic === "Behavioral") {
    return [
      { label: "How to answer (STAR)", url: google(`"${title}" behavioral interview answer STAR method`), icon: "fa-solid fa-comments", variant: "primary" },
      { label: "Watch sample answers", url: youtube(`${title} behavioral interview answer`), icon: "fa-brands fa-youtube", variant: "yt" },
    ];
  }

  // Coding (default)
  const links: { label: string; url: string; icon: string; variant?: string }[] = [];
  if (q.url && q.url.includes("leetcode.com/problems/")) {
    // Direct problem page — viewable without login.
    links.push({ label: "Solve on LeetCode", url: q.url, icon: "fa-solid fa-code", variant: "primary" });
  } else {
    links.push({
      label: "Find on LeetCode",
      url: `https://leetcode.com/problemset/?search=${enc}`,
      icon: "fa-solid fa-code",
      variant: "primary",
    });
  }
  links.push({ label: "Video walkthrough", url: youtube(`${title} leetcode solution explained`), icon: "fa-brands fa-youtube", variant: "yt" });
  links.push({ label: "NeetCode", url: google(`site:neetcode.io ${title}`), icon: "fa-solid fa-graduation-cap", variant: "alt" });
  return links;
}

export default function Interview() {
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [topicFilter, setTopicFilter] = useState("All");
  const [difficultyFilter, setDifficultyFilter] = useState("All");
  const [showRequestModal, setShowRequestModal] = useState(false);

  const companies = interviewData.companies as Company[];

  const filtered = useMemo(() => {
    return companies.filter((c) => {
      if (categoryFilter !== "All" && c.category !== categoryFilter) return false;
      if (searchQuery && !c.name.toLowerCase().includes(searchQuery.toLowerCase())) return false;
      return true;
    });
  }, [companies, categoryFilter, searchQuery]);

  const selected = selectedCompany ? companies.find((c) => c.name === selectedCompany) : null;

  if (selected) {
    return (
      <CompanyDetail
        company={selected}
        topicFilter={topicFilter}
        difficultyFilter={difficultyFilter}
        setTopicFilter={setTopicFilter}
        setDifficultyFilter={setDifficultyFilter}
        onBack={() => {
          setSelectedCompany(null);
          setTopicFilter("All");
          setDifficultyFilter("All");
        }}
      />
    );
  }

  const totalQuestions = companies.reduce((sum, c) => sum + c.totalQuestions, 0);
  const totalCompanies = companies.length;

  return (
    <div className="interview-page">
      {/* Premium hero */}
      <div className="interview-hero">
        <span className="interview-hero-badge">
          <i className="fa-solid fa-bolt"></i> Interview Prep
        </span>
        <h1>Land the offer with real questions</h1>
        <p>
          Curated technical, system design &amp; behavioral questions actually asked at top companies —
          each linked to a free, no-login resource to practice.
        </p>
        <div className="interview-hero-stats">
          <div className="interview-hero-stat">
            <strong>{totalCompanies}</strong>
            <span>Companies</span>
          </div>
          <div className="interview-hero-stat">
            <strong>{totalQuestions.toLocaleString()}</strong>
            <span>Questions</span>
          </div>
          <div className="interview-hero-stat">
            <strong>100%</strong>
            <span>Free to practice</span>
          </div>
        </div>
      </div>

      {/* Logo carousel */}
      <div className="interview-carousel-wrapper">
        <div className="interview-carousel-track">
          {[...companies.slice(0, 20), ...companies.slice(0, 20)].map((c, i) => (
            <span key={i} className="interview-carousel-item" onClick={() => setSelectedCompany(c.name)}>
              <img
                src={logoUrl(c.domain)}
                alt=""
                className="interview-carousel-logo"
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              />
              <span>{c.name}</span>
            </span>
          ))}
        </div>
      </div>

      {/* Search + category chips */}
      <div className="interview-controls">
        <div className="interview-search-wrap">
          <i className="fa-solid fa-magnifying-glass"></i>
          <input
            type="text"
            placeholder="Search companies..."
            className="interview-search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        <div className="interview-chips">
          {CATEGORY_ORDER.map((cat) => (
            <button
              key={cat}
              className={`interview-chip ${categoryFilter === cat ? "active" : ""}`}
              onClick={() => setCategoryFilter(cat)}
            >
              {CATEGORY_LABELS[cat]}
            </button>
          ))}
        </div>
      </div>

      <div className="interview-grid">
        {filtered.map((company) => {
          const coding = company.questions.filter((q) => q.topic === "Coding").length;
          return (
            <div
              key={company.name}
              className="interview-company-card"
              onClick={() => setSelectedCompany(company.name)}
            >
              <img
                src={logoUrl(company.domain)}
                alt=""
                className="interview-card-logo"
                onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
              />
              <div className="interview-card-info">
                <strong>{company.name}</strong>
                <span>
                  {company.totalQuestions} questions · {coding} coding
                </span>
              </div>
              <span className={`interview-card-cat cat-${company.category.toLowerCase().replace(/[^a-z]/g, "")}`}>
                {CATEGORY_LABELS[company.category] || company.category}
              </span>
            </div>
          );
        })}
      </div>

      {filtered.length === 0 && (
        <div className="interview-empty">No companies match your filters.</div>
      )}

      {/* Submit CTA */}
      <div className="interview-request-cta" onClick={() => setShowRequestModal(true)}>
        <i className="fa-solid fa-circle-plus"></i>
        <div>
          <strong>Don't see a company or question?</strong>
          <span>Submit a company or a question you faced — we'll add it to the database.</span>
        </div>
        <i className="fa-solid fa-chevron-right"></i>
      </div>

      {showRequestModal && <SubmitModal onClose={() => setShowRequestModal(false)} />}
    </div>
  );
}

function CompanyDetail({
  company,
  topicFilter,
  difficultyFilter,
  setTopicFilter,
  setDifficultyFilter,
  onBack,
}: {
  company: Company;
  topicFilter: string;
  difficultyFilter: string;
  setTopicFilter: (v: string) => void;
  setDifficultyFilter: (v: string) => void;
  onBack: () => void;
}) {
  const topics = [...new Set(company.questions.map((q) => q.topic))];
  const difficulties = ["Easy", "Medium", "Hard"];

  const counts = useMemo(() => {
    const c = { Easy: 0, Medium: 0, Hard: 0 } as Record<string, number>;
    company.questions.forEach((q) => {
      if (c[q.difficulty] !== undefined) c[q.difficulty]++;
    });
    return c;
  }, [company]);
  const total = company.questions.length || 1;

  const filteredQuestions = company.questions.filter((q) => {
    if (topicFilter !== "All" && q.topic !== topicFilter) return false;
    if (difficultyFilter !== "All" && q.difficulty !== difficultyFilter) return false;
    return true;
  });

  return (
    <div className="interview-page">
      <button className="interview-back" onClick={onBack}>
        ← Back to Companies
      </button>

      <div className="interview-company-header">
        <img
          src={logoUrl(company.domain)}
          alt=""
          className="interview-company-logo"
          onError={(e) => ((e.target as HTMLImageElement).style.display = "none")}
        />
        <div className="interview-company-header-info">
          <h1>{company.name}</h1>
          <p>{company.totalQuestions} interview questions</p>
        </div>
      </div>

      {/* Difficulty distribution */}
      <div className="interview-distribution">
        <div className="interview-dist-bar">
          <span className="dist-easy" style={{ width: `${(counts.Easy / total) * 100}%` }} />
          <span className="dist-medium" style={{ width: `${(counts.Medium / total) * 100}%` }} />
          <span className="dist-hard" style={{ width: `${(counts.Hard / total) * 100}%` }} />
        </div>
        <div className="interview-dist-legend">
          <span><i className="dot dot-easy" /> Easy {counts.Easy}</span>
          <span><i className="dot dot-medium" /> Medium {counts.Medium}</span>
          <span><i className="dot dot-hard" /> Hard {counts.Hard}</span>
        </div>
      </div>

      <div className="interview-filters">
        <div className="interview-filter-group">
          <label>Topic</label>
          <select value={topicFilter} onChange={(e) => setTopicFilter(e.target.value)}>
            <option value="All">All Topics</option>
            {topics.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>
        <div className="interview-filter-group">
          <label>Difficulty</label>
          <select value={difficultyFilter} onChange={(e) => setDifficultyFilter(e.target.value)}>
            <option value="All">All Levels</option>
            {difficulties.map((d) => (
              <option key={d} value={d}>
                {d}
              </option>
            ))}
          </select>
        </div>
        <span className="interview-filter-count">{filteredQuestions.length} questions</span>
      </div>

      <div className="interview-questions-list">
        {filteredQuestions.map((q, i) => (
          <QuestionCard key={i} question={q} />
        ))}
      </div>
    </div>
  );
}

function QuestionCard({ question: q }: { question: Question }) {
  const [expanded, setExpanded] = useState(false);
  const links = practiceLinks(q);

  return (
    <div className={`interview-question-card ${expanded ? "expanded" : ""}`} onClick={() => setExpanded(!expanded)}>
      <div className="interview-question-tags">
        <span className={`iq-tag iq-tag-${q.topic.toLowerCase().replace(/[^a-z]/g, "")}`}>{q.topic}</span>
        <span className="iq-tag">{q.subtopic}</span>
        <span className={`iq-tag iq-difficulty-${q.difficulty.toLowerCase()}`}>{q.difficulty}</span>
      </div>
      <h3 className="interview-question-title">{q.title}</h3>
      <div className="interview-question-meta">
        <span><i className="fa-solid fa-user-tie"></i> {q.seniority}</span>
        <span><i className="fa-solid fa-phone"></i> {q.type.replace("_", " ")}</span>
        <span className="interview-question-toggle">{expanded ? "Hide resources" : "Practice ↓"}</span>
      </div>
      {expanded && (
        <div className="interview-question-expanded">
          <div className="interview-practice-links">
            {links.map((l, i) => (
              <a
                key={i}
                href={l.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`interview-practice-btn ${l.variant ? `ipb-${l.variant}` : ""}`}
                onClick={(e) => e.stopPropagation()}
              >
                <i className={l.icon}></i> {l.label}
              </a>
            ))}
          </div>
          <p className="interview-practice-note">
            <i className="fa-solid fa-circle-info"></i> All resources are free and open without a login.
          </p>
        </div>
      )}
    </div>
  );
}

function SubmitModal({ onClose }: { onClose: () => void }) {
  const [mode, setMode] = useState<"company" | "question">("company");
  const [company, setCompany] = useState("");
  const [questionTitle, setQuestionTitle] = useState("");
  const [questionCompany, setQuestionCompany] = useState("");
  const [topic, setTopic] = useState("Coding");
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const canSubmit =
    mode === "company" ? company.trim().length > 0 : questionTitle.trim().length > 0;

  async function handleSubmit() {
    if (!canSubmit) return;
    setSubmitting(true);
    const message =
      mode === "company"
        ? `[Interview] Company request: ${company.trim()}`
        : `[Interview] Question submission — Company: ${questionCompany.trim() || "N/A"} | Topic: ${topic} | Question: ${questionTitle.trim()}`;
    try {
      await api.post("/feedback", {
        category: "feature_request",
        message,
        wants_followup: false,
      });
    } catch {
      // Non-blocking: still show success so the UX isn't punishing.
    } finally {
      setSubmitting(false);
      setSubmitted(true);
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal-content interview-request-modal" onClick={(e) => e.stopPropagation()}>
        {!submitted ? (
          <>
            <button className="modal-close" onClick={onClose}>
              <i className="fa-solid fa-xmark"></i>
            </button>
            <div className="request-modal-icon">
              <i className="fa-solid fa-lightbulb"></i>
            </div>
            <h2>Contribute to the database</h2>
            <p>Help everyone prep better. Submit a company we're missing or a question you faced in a real interview.</p>

            <div className="submit-toggle">
              <button
                className={mode === "company" ? "active" : ""}
                onClick={() => setMode("company")}
              >
                <i className="fa-solid fa-building"></i> Company
              </button>
              <button
                className={mode === "question" ? "active" : ""}
                onClick={() => setMode("question")}
              >
                <i className="fa-solid fa-circle-question"></i> Question
              </button>
            </div>

            {mode === "company" ? (
              <input
                type="text"
                className="request-company-input"
                placeholder="e.g. Stripe, Databricks, Shopify..."
                value={company}
                onChange={(e) => setCompany(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleSubmit()}
                autoFocus
              />
            ) : (
              <div className="submit-question-fields">
                <input
                  type="text"
                  className="request-company-input"
                  placeholder="Question you were asked *"
                  value={questionTitle}
                  onChange={(e) => setQuestionTitle(e.target.value)}
                  autoFocus
                />
                <input
                  type="text"
                  className="request-company-input"
                  placeholder="Which company? (optional)"
                  value={questionCompany}
                  onChange={(e) => setQuestionCompany(e.target.value)}
                />
                <select
                  className="request-company-input"
                  value={topic}
                  onChange={(e) => setTopic(e.target.value)}
                >
                  <option value="Coding">Coding</option>
                  <option value="System Design">System Design</option>
                  <option value="Behavioral">Behavioral</option>
                </select>
              </div>
            )}

            <button className="request-submit-btn" onClick={handleSubmit} disabled={!canSubmit || submitting}>
              {submitting ? "Submitting..." : mode === "company" ? "Request Company" : "Submit Question"}
            </button>
          </>
        ) : (
          <>
            <div className="request-success-icon">
              <i className="fa-solid fa-circle-check"></i>
            </div>
            <h2>Thank you!</h2>
            <p>
              {mode === "company"
                ? <>We've noted your request for <strong>{company}</strong>. We'll work on adding it soon.</>
                : <>Your question has been submitted for review. Thanks for helping the community.</>}
            </p>
            <button className="request-submit-btn" onClick={onClose}>
              Done
            </button>
          </>
        )}
      </div>
    </div>
  );
}
