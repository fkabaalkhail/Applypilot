import { useState } from "react";
import interviewData from "../data/interview-questions.json";

export default function Interview() {
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [topicFilter, setTopicFilter] = useState<string>("All");
  const [difficultyFilter, setDifficultyFilter] = useState<string>("All");

  const companies = interviewData.companies;
  const filtered = searchQuery
    ? companies.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : companies;

  const selected = selectedCompany
    ? companies.find(c => c.name === selectedCompany)
    : null;

  if (selected) {
    const filteredQuestions = selected.questions.filter(q => {
      if (topicFilter !== "All" && q.topic !== topicFilter) return false;
      if (difficultyFilter !== "All" && q.difficulty !== difficultyFilter) return false;
      return true;
    });

    const topics = [...new Set(selected.questions.map(q => q.topic))];
    const difficulties = ["Easy", "Medium", "Hard"];

    return (
      <div className="interview-page">
        <button className="interview-back" onClick={() => { setSelectedCompany(null); setTopicFilter("All"); setDifficultyFilter("All"); }}>
          ← Back to Companies
        </button>
        <div className="interview-company-header">
          <img
            src={`https://logos-api.apistemic.com/domain:${selected.domain}?fallback=404`}
            alt=""
            className="interview-company-logo"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
          <div>
            <h1>{selected.name}</h1>
            <p>{selected.totalQuestions} Questions</p>
          </div>
        </div>

        <div className="interview-filters">
          <div className="interview-filter-group">
            <label>Topic:</label>
            <select value={topicFilter} onChange={e => setTopicFilter(e.target.value)}>
              <option value="All">All Topics</option>
              {topics.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div className="interview-filter-group">
            <label>Difficulty:</label>
            <select value={difficultyFilter} onChange={e => setDifficultyFilter(e.target.value)}>
              <option value="All">All Levels</option>
              {difficulties.map(d => <option key={d} value={d}>{d}</option>)}
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

  // Stats
  const totalQuestions = companies.reduce((sum, c) => sum + c.totalQuestions, 0);
  const totalCompanies = companies.length;

  return (
    <div className="interview-page">
      <div className="interview-header">
        <h1>Interview Questions</h1>
        <p>Real technical &amp; behavioral questions from top companies</p>
        <div className="interview-stats">
          <span className="interview-stat">{totalCompanies} Companies</span>
          <span className="interview-stat">{totalQuestions.toLocaleString()} Questions</span>
        </div>
      </div>
      <input
        type="text"
        placeholder="Search companies..."
        className="interview-search"
        value={searchQuery}
        onChange={(e) => setSearchQuery(e.target.value)}
      />
      <div className="interview-grid">
        {filtered.map((company) => (
          <div
            key={company.name}
            className="interview-company-card"
            onClick={() => setSelectedCompany(company.name)}
          >
            <img
              src={`https://logos-api.apistemic.com/domain:${company.domain}?fallback=404`}
              alt=""
              className="interview-card-logo"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
            <div className="interview-card-info">
              <strong>{company.name}</strong>
              <span>{company.totalQuestions} Questions</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function QuestionCard({ question }: { question: any }) {
  const [expanded, setExpanded] = useState(false);
  const q = question;
  const hasUrl = q.url && q.url.length > 0;

  return (
    <div className={`interview-question-card ${expanded ? "expanded" : ""}`} onClick={() => setExpanded(!expanded)}>
      <div className="interview-question-tags">
        <span className={`iq-tag iq-tag-${q.topic.toLowerCase().replace(/[^a-z]/g, "")}`}>{q.topic}</span>
        <span className="iq-tag">{q.subtopic}</span>
        <span className={`iq-tag iq-difficulty-${q.difficulty.toLowerCase()}`}>{q.difficulty}</span>
      </div>
      <h3 className="interview-question-title">{q.title}</h3>
      <div className="interview-question-meta">
        <span>{q.seniority}</span>
        <span>{q.type.replace("_", " ")}</span>
      </div>
      {expanded && (
        <div className="interview-question-expanded">
          {hasUrl ? (
            <a
              href={q.url}
              target="_blank"
              rel="noopener noreferrer"
              className="interview-practice-btn"
              onClick={(e) => e.stopPropagation()}
            >
              Practice on LeetCode →
            </a>
          ) : (
            <p className="interview-no-link">This is a {q.topic.toLowerCase()} question — prepare by practicing similar problems and reviewing common patterns.</p>
          )}
        </div>
      )}
    </div>
  );
}
