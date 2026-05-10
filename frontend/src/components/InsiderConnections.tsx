import { useState, useEffect } from "react";

const API_BASE = "";

interface Connection {
  id: number;
  name: string;
  title: string;
  relationship_type: string;
  linkedin_url: string;
}

interface Props {
  company: string;
}

const RELATIONSHIP_LABELS: Record<string, string> = {
  beyond_network: "Beyond Network",
  previous_company: "Previous Company",
  school: "School",
};

export default function InsiderConnections({ company }: Props) {
  const [connections, setConnections] = useState<Connection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!company) {
      setLoading(false);
      return;
    }
    fetch(`${API_BASE}/connections/${encodeURIComponent(company)}`)
      .then((r) => (r.ok ? r.json() : []))
      .then((data) => setConnections(data))
      .catch(() => setConnections([]))
      .finally(() => setLoading(false));
  }, [company]);

  if (loading) {
    return (
      <div className="insider-connections">
        <h3>Insider Connections</h3>
        <div className="connections-loading">Loading connections...</div>
      </div>
    );
  }

  if (connections.length === 0) {
    return (
      <div className="insider-connections">
        <h3>Insider Connections</h3>
        <p className="connections-empty">No insider connections found at {company}.</p>
      </div>
    );
  }

  const grouped = connections.reduce<Record<string, Connection[]>>((acc, conn) => {
    const type = conn.relationship_type || "beyond_network";
    if (!acc[type]) acc[type] = [];
    acc[type].push(conn);
    return acc;
  }, {});

  return (
    <div className="insider-connections">
      <h3>Insider Connections</h3>
      {Object.entries(grouped).map(([type, conns]) => (
        <div key={type} className="connection-group">
          <h4 className="connection-group-label">
            {RELATIONSHIP_LABELS[type] || type}
          </h4>
          <ul className="connection-list">
            {conns.map((conn) => (
              <li key={conn.id} className="connection-item">
                <div className="connection-info">
                  <span className="connection-name">{conn.name}</span>
                  <span className="connection-title">{conn.title}</span>
                </div>
                {conn.linkedin_url && (
                  <a
                    href={conn.linkedin_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="connection-link"
                    aria-label={`View ${conn.name} on LinkedIn`}
                  >
                    🔗
                  </a>
                )}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}
