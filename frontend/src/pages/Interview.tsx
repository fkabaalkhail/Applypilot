import { useState } from "react";
import interviewData from "../data/interview-questions.json";

export default function Interview() {
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");

  const companies = interviewData.companies;
  const filtered = searchQuery
    ? companies.filter(c => c.name.toLowerCase().includes(searchQuery.toLowerCase()))
    : companies;

  const selected = selectedCompany
    ? companies.find(c => c.name === selectedCompany)
    : null;

  if (selected) {
    return (
      <div className="interview-page">
        <button className="interview-back" onClick={() => setSelectedCompany(null)}>
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
        <div className="interview-questions-list">
          {selected.questions.map((q, i) => (
            <div key={i} className="interview-question-card">
              <div className="interview-question-tags">
                <span className={`iq-tag iq-tag-${q.topic.toLowerCase().replace(/[^a-z]/g, "")}`}>{q.topic}</span>
                <span className="iq-tag">{q.subtopic}</span>
              </div>
              <h3 className="interview-question-title">{q.title}</h3>
              <div className="interview-question-meta">
                <span>{q.difficulty}</span>
                <span>{q.seniority}</span>
                <span>{q.type.replace("_", " ")}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="interview-page">
      <div className="interview-header">
        <h1>Interview Questions</h1>
        <p>Real technical &amp; behavioral questions from top companies</p>
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

